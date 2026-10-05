import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";
import { parseFrontmatter } from "./frontmatter.js";
import { isCardId, isNodeId, isRoleId } from "./id.js";
import { isHistoryDocument } from "./document-history.js";
import { isDeepStrictEqual } from "node:util";
import { nodeBasisRecordSchema, type NodeBasisRecord } from "./node-basis-record.js";

export type DocumentVersion = { commit: string; path: string };
export type DocumentChange = { path: string; raw: string | null };
export type CaptureResult = {
  commit: string | null;
  created: boolean;
  versions: DocumentVersion[];
};
export type CaptureMetadata = {
  operation: string;
  objectIds?: readonly string[];
  entry?: "cli" | "ui" | "core";
  nodeRecords?: Record<string, NodeBasisRecord>;
};
export type HistoryChange = {
  objectId?: string;
  before?: DocumentVersion;
  after?: DocumentVersion;
};
export type HistoryCommit = {
  commit: string;
  time: string;
  parent?: string;
  operation?: string;
  objectIds: string[];
  entry?: "cli" | "ui" | "core";
  changes: HistoryChange[];
};

const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const documentVersionSchema = z.strictObject({
  commit: z.string().regex(oidPattern),
  path: z.string().min(1),
});

function documentPath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes(":") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Invalid Git document path: ${value}`);
  }
  return value;
}

function oid(value: string): string {
  if (!oidPattern.test(value)) throw new Error("Invalid Git commit or object ID");
  return value;
}

function isHistoryId(value: string): boolean {
  return isNodeId(value) || isRoleId(value) || isCardId(value);
}

function identity(raw: string): string | undefined {
  try {
    const value = parseFrontmatter(raw).data.id;
    return typeof value === "string" && isHistoryId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function commitMessage(metadata: CaptureMetadata, objectIds: readonly string[]): string {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(metadata.operation)) {
    throw new Error(`Invalid Tent history operation: ${metadata.operation}`);
  }
  for (const id of objectIds)
    if (!isHistoryId(id)) {
      throw new Error(`Invalid Tent history object id: ${id}`);
    }
  if (metadata.entry !== undefined && !["cli", "ui", "core"].includes(metadata.entry)) {
    throw new Error(`Invalid Tent history entry: ${metadata.entry}`);
  }
  return (
    `Tent: ${metadata.operation}\n\nTent-Operation: ${metadata.operation}` +
    objectIds.map((id) => `\nTent-Object: ${id}`).join("") +
    (metadata.entry ? `\nTent-Entry: ${metadata.entry}` : "") +
    Object.entries(metadata.nodeRecords ?? {})
      .map(([id, record]) => {
        if (!isNodeId(id)) throw new Error(`Invalid Node record id: ${id}`);
        return `\nTent-Node-Record: ${JSON.stringify([id, nodeBasisRecordSchema.parse(record)])}`;
      })
      .join("")
  );
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return { ...env, ...extra };
}

function spawnGit(root: string, args: string[], options: { index?: string } = {}) {
  const env = gitEnvironment(options.index ? { GIT_INDEX_FILE: options.index } : {});
  return spawn(
    "git",
    [
      "-C",
      root,
      `--git-dir=${path.join(root, ".git")}`,
      `--work-tree=${root}`,
      "-c",
      "user.name=Tent",
      "-c",
      "user.email=tent@local.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${path.join(root, ".git", `tent-no-hooks-${randomUUID()}`)}`,
      ...args,
    ],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

async function runGit(
  root: string,
  args: string[],
  options: { input?: Buffer; index?: string } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(root, args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout))
        : reject(
            new Error(
              `Git ${args[0]} failed: ${Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`}`,
            ),
          ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

type RawHistoryCommit = {
  commit: string;
  parents: string[];
  parent?: string;
  time: string;
  message: string;
  files: Array<{ path: string; status: string; beforeBlob?: string; afterBlob?: string }>;
};

/** NUL framing keeps multiline messages and non-ASCII paths out of the raw-diff grammar. */
function parseHistoryLog(bytes: Buffer): RawHistoryCommit[] {
  const fields = bytes.toString("utf8").split("\0");
  const records: RawHistoryCommit[] = [];
  let current: RawHistoryCommit | undefined;
  for (let i = 0; i < fields.length;) {
    const token = fields[i++]!.replace(/^\n/, "");
    if (!token) continue;
    if (oidPattern.test(token)) {
      const parents = fields[i++]!,
        time = fields[i++]!,
        message = fields[i++]!;
      const parent = parents.split(" ")[0];
      current = {
        commit: token,
        parents: parents.split(" ").filter(Boolean),
        ...(parent ? { parent: oid(parent) } : {}),
        time: new Date(time).toISOString(),
        message,
        files: [],
      };
      records.push(current);
      continue;
    }
    const row = /^:[0-7]{6} [0-7]{6} ([a-f0-9]+) ([a-f0-9]+) ([AMDT])$/.exec(token);
    if (!current || !row) throw new Error("Invalid Git history record");
    const file = documentPath(fields[i++]!);
    current.files.push({
      path: file,
      status: row[3]!,
      ...(row[3] !== "A" ? { beforeBlob: oid(row[1]!) } : {}),
      ...(row[3] !== "D" ? { afterBlob: oid(row[2]!) } : {}),
    });
  }
  return records;
}

/** One query-owned process, with byte framing rather than buffering the entire blob batch. */
async function readBlobs<T>(
  root: string,
  objects: ReadonlySet<string>,
  select: (raw: string) => T,
) {
  const results = new Map<string, T | Error>();
  if (!objects.size) return results;
  const child = spawnGit(root, ["cat-file", "--batch"]);
  const stderr: Buffer[] = [];
  let spawnError: Error | undefined;
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.stdin.on("error", () => {});
  child.stdin.end([...objects].join("\n") + "\n");
  const chunks = child.stdout[Symbol.asyncIterator]();
  let chunk: Buffer = Buffer.alloc(0),
    offset = 0;
  async function ready() {
    if (offset < chunk.length) return;
    const next = await chunks.next();
    if (next.done) throw new Error("Unexpected end of Git blob batch");
    chunk = next.value as Buffer;
    offset = 0;
  }
  async function readLine() {
    const parts: Buffer[] = [];
    for (;;) {
      await ready();
      const end = chunk.indexOf(10, offset);
      if (end !== -1) {
        parts.push(chunk.subarray(offset, end));
        offset = end + 1;
        return Buffer.concat(parts).toString("utf8");
      }
      parts.push(chunk.subarray(offset));
      offset = chunk.length;
    }
  }
  async function readBytes(size: number) {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining) {
      await ready();
      const count = Math.min(remaining, chunk.length - offset);
      parts.push(chunk.subarray(offset, offset + count));
      offset += count;
      remaining -= count;
    }
    return Buffer.concat(parts, size);
  }
  try {
    for (const object of objects) {
      const header = await readLine();
      if (header === `${object} missing`) {
        results.set(object, new Error(`Git document is unavailable: ${object}`));
        continue;
      }
      const [returned, type, length] = header.split(" ");
      const size = Number(length);
      if (!returned || !oidPattern.test(returned) || !Number.isSafeInteger(size) || size < 0)
        throw new Error(`Invalid Git history blob: ${object}`);
      const raw = await readBytes(size);
      if ((await readBytes(1))[0] !== 10) throw new Error("Invalid Git blob terminator");
      results.set(
        object,
        type === "blob"
          ? select(raw.toString("utf8"))
          : new Error(`Git document is not a blob: ${object}`),
      );
    }
    if (offset !== chunk.length || !(await chunks.next()).done)
      throw new Error("Unexpected trailing Git batch output");
    const code = await closed;
    if (spawnError || code !== 0)
      throw (
        spawnError ??
        new Error(
          `Git cat-file failed: ${Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`}`,
        )
      );
    return results;
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
}

const historySnapshotSchema = z.object({
  version: z.literal(2),
  head: z.string().regex(oidPattern),
  digest: z.string(),
  records: z.array(
    z.object({
      commit: z.string().regex(oidPattern),
      parents: z.array(z.string().regex(oidPattern)),
      parent: z.string().regex(oidPattern).optional(),
      time: z.string(),
      message: z.string(),
      files: z.array(
        z.object({
          path: z.string(),
          status: z.string(),
          beforeBlob: z.string().regex(oidPattern).optional(),
          afterBlob: z.string().regex(oidPattern).optional(),
        }),
      ),
    }),
  ),
  blobs: z.record(z.string(), z.string()),
  frontmatters: z.record(z.string(), z.record(z.string(), z.unknown())),
});
type HistorySnapshot = z.infer<typeof historySnapshotSchema>;

/** Git plumbing for selected Markdown documents. Caller holds the Tent mutation lock for captureUnlocked. */
export class GitDocumentHistory {
  private readonly root: string;
  private readonly defaultEntry: CaptureMetadata["entry"];
  private knownHead: string | null | undefined;
  private knownEntries = new Map<string, string>();
  private recordHead: string | null | undefined;
  private records: Record<string, NodeBasisRecord> = {};
  private firstTimesHead: string | null | undefined;
  private firstTimes = new Map<string, string>();
  private snapshotHead?: string;
  private snapshotPromise?: Promise<HistorySnapshot>;
  private snapshotRecordsPromise?: Promise<RawHistoryCommit[]>;
  private derivedPromises = new Map<string, Promise<unknown>>();
  private derivedHead: string | null | undefined;
  private derivedScope = new AsyncLocalStorage<{ head: string | null }>();

  private async retainedHead() {
    const scope = this.derivedScope.getStore();
    return scope ? scope.head : this.currentCommit();
  }

  /** Disposable, exact-HEAD indexes. A hit never invokes the history replay builder. */
  async derived<T>(
    name: string,
    schemaVersion: number,
    compute: (head: string | null) => Promise<T>,
  ): Promise<T> {
    return this.derivedAtHead(name, schemaVersion, await this.retainedHead(), compute);
  }

  private async derivedAtHead<T>(
    name: string,
    schemaVersion: number,
    head: string | null,
    compute: (head: string | null) => Promise<T>,
  ): Promise<T> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Invalid derived history index name");
    if (this.derivedHead !== head) {
      this.derivedPromises.clear();
      this.derivedHead = head;
    }
    const key = `${name}:${schemaVersion}:${head}`;
    let pending = this.derivedPromises.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = (async () => {
        const file = path.join(this.root, ".git", `tent-derived-${name}.json`);
        try {
          const saved = JSON.parse(await fs.readFile(file, "utf8"));
          if (
            saved.version === schemaVersion &&
            saved.head === head &&
            "value" in saved &&
            saved.digest === createHash("sha256").update(JSON.stringify(saved.value)).digest("hex")
          )
            return saved.value as T;
        } catch {
          /* A missing or damaged disposable cache is rebuilt. */
        }
        const value = await this.derivedScope.run({ head }, () => compute(head));
        await this.saveCache(file, {
          version: schemaVersion,
          head,
          value,
          digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        });
        return value;
      })();
      this.derivedPromises.set(key, pending);
      pending.catch(() => {
        if (this.derivedPromises.get(key) === pending) this.derivedPromises.delete(key);
      });
    }
    return structuredClone(await pending);
  }

  private async saveCache(file: string, value: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value));
      await fs.rename(temporary, file);
    } catch {
      // Derived state is optional; an unwritable cache never prevents a query.
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** One complete reachable graph and blob batch serve every consumer at this HEAD. */
  private async snapshot(head: string): Promise<HistorySnapshot> {
    if (this.snapshotHead !== head || !this.snapshotPromise) {
      this.snapshotHead = head;
      let resolveRecords!: (records: RawHistoryCommit[]) => void;
      let rejectRecords!: (error: unknown) => void;
      this.snapshotRecordsPromise = new Promise((resolve, reject) => {
        resolveRecords = resolve;
        rejectRecords = reject;
      });
      this.snapshotRecordsPromise.catch(() => {});
      this.snapshotPromise = (async () => {
        const file = path.join(this.root, ".git", "tent-history-index.json");
        try {
          const saved = historySnapshotSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
          if (saved.head === head && saved.digest === this.snapshotDigest(saved)) {
            resolveRecords(saved.records);
            return saved;
          }
        } catch {
          /* Derived history can always be reconstructed from Git. */
        }
        const records = parseHistoryLog(
          await runGit(this.root, [
            "log",
            "--full-history",
            "--reverse",
            "--raw",
            "-z",
            "--root",
            "--no-renames",
            "--no-abbrev",
            "--no-color",
            "--no-show-signature",
            "--diff-merges=separate",
            "--always",
            "--format=%x00%H%x00%P%x00%cI%x00%B%x00",
            head,
          ]),
        );
        const objects = new Set<string>();
        resolveRecords(records);
        for (const record of records)
          for (const entry of record.files) {
            if (!isHistoryDocument(entry.path) || entry.status === "T") continue;
            if (entry.beforeBlob) objects.add(entry.beforeBlob);
            if (entry.afterBlob) objects.add(entry.afterBlob);
          }
        const blobs: Record<string, string> = {};
        for (const [object, raw] of await readBlobs(this.root, objects, (raw) => raw)) {
          if (raw instanceof Error) throw raw;
          blobs[object] = raw;
        }
        const frontmatters: Record<string, Record<string, unknown>> = {};
        for (const [object, raw] of Object.entries(blobs)) {
          try {
            frontmatters[object] = parseFrontmatter(raw).data;
          } catch {
            /* Invalid headers have no retained identity. */
          }
        }
        const result: HistorySnapshot = {
          version: 2,
          head,
          records,
          blobs,
          frontmatters,
          digest: "",
        };
        result.digest = this.snapshotDigest(result);
        await this.saveCache(file, result);
        return result;
      })();
      this.snapshotPromise.catch((error) => {
        rejectRecords(error);
        if (this.snapshotHead === head) this.snapshotPromise = undefined;
      });
    }
    return this.snapshotPromise;
  }

  private async snapshotRecords(head: string) {
    // Message/path consumers can start live inspection while the blob batch runs.
    void this.snapshot(head).catch(() => {});
    return this.snapshotRecordsPromise!;
  }

  private snapshotDigest(snapshot: HistorySnapshot) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          head: snapshot.head,
          records: snapshot.records,
          blobs: snapshot.blobs,
          frontmatters: snapshot.frontmatters,
        }),
      )
      .digest("hex");
  }

  private firstParentRecords(
    snapshot: Pick<HistorySnapshot, "head" | "records">,
    head = snapshot.head,
  ): RawHistoryCommit[] {
    const byCommit = new Map<string, RawHistoryCommit>();
    for (const record of snapshot.records)
      if (!byCommit.has(record.commit)) byCommit.set(record.commit, record);
    const records: RawHistoryCommit[] = [];
    for (let commit: string | undefined = head; commit;) {
      const record: RawHistoryCommit = byCommit.get(commit)!;
      records.push(record);
      commit = record.parent;
    }
    return records.reverse();
  }

  /** Latest declarations on the retained first-parent lineage; a reset rolls records back too. */
  async nodeRecords(): Promise<Record<string, NodeBasisRecord>> {
    await this.ensureRepository();
    const head = await this.retainedHead();
    if (this.recordHead !== head) {
      this.records = await this.derivedAtHead("node-records", 1, head, async () => {
        const records: Record<string, NodeBasisRecord> = {};
        if (head)
          for (const event of this.firstParentRecords({
            head,
            records: await this.snapshotRecords(head),
          }).reverse())
            for (const line of event.message.split("\n")) {
              if (!line.startsWith("Tent-Node-Record: ")) continue;
              const [id, record] = JSON.parse(line.slice("Tent-Node-Record: ".length));
              if (!isNodeId(id)) throw new Error("Invalid retained Node record id");
              if (!(id in records)) records[id] = nodeBasisRecordSchema.parse(record);
            }
        return records;
      });
      this.recordHead = head;
    }
    return structuredClone(this.records);
  }

  /** First retained identity event, independent of its current filename. */
  async firstNodeTime(nodeId: string): Promise<string | undefined> {
    if (!isNodeId(nodeId)) throw new Error("Invalid Node id");
    await this.ensureRepository();
    const head = await this.retainedHead();
    if (!head) return undefined;
    if (this.firstTimesHead !== head) {
      this.firstTimes = new Map(
        Object.entries(
          await this.derivedAtHead("identity-times", 1, head, async () => {
            const times: Record<string, string> = {};
            for (const event of await this.changesInRange())
              for (const change of event.changes)
                if (change.objectId && !(change.objectId in times))
                  times[change.objectId] = event.time;
            return times;
          }),
        ),
      );
      this.firstTimesHead = head;
    }
    return this.firstTimes.get(nodeId);
  }

  constructor(systemRoot: string, entry: CaptureMetadata["entry"] = "core") {
    this.root = path.resolve(systemRoot);
    this.defaultEntry = entry;
  }

  async available(): Promise<boolean> {
    try {
      await this.ensureRepository();
      await this.currentCommit();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureRepository(): Promise<string> {
    // Every command explicitly selects this independent .git and work tree;
    // it cannot fall through to the project's parent Git repository.
    const gitDir = path.join(this.root, ".git");
    if (!(await fs.stat(gitDir).catch(() => null))?.isDirectory()) {
      throw new Error(
        `Tent Git history is unavailable: requires an independent repository at ${this.root}`,
      );
    }
    return gitDir;
  }

  private async head(): Promise<string | null> {
    try {
      return oid(
        (await runGit(this.root, ["rev-parse", "--verify", "HEAD"])).toString("ascii").trim(),
      );
    } catch (error) {
      let ref: string;
      try {
        ref = (await runGit(this.root, ["symbolic-ref", "--quiet", "HEAD"]))
          .toString("utf8")
          .trim();
      } catch {
        throw error;
      }
      const existing = (await runGit(this.root, ["for-each-ref", "--format=%(objectname)", ref]))
        .toString("ascii")
        .trim();
      if (!existing) return null;
      throw error;
    }
  }

  /** Current independent Tent HEAD, including an unborn repository. */
  async currentCommit(): Promise<string | null> {
    const gitDir = await this.ensureRepository();
    let ref = "HEAD";
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(ref)) throw new Error("Cyclic Tent Git HEAD reference");
      visited.add(ref);
      const value = await fs
        .readFile(path.join(gitDir, ref), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" && ref !== "HEAD") return null;
          throw error;
        });
      if (value === null) {
        const packed = await fs
          .readFile(path.join(gitDir, "packed-refs"), "utf8")
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
        const entry = packed.split("\n").find((line) => line.slice(line.indexOf(" ") + 1) === ref);
        return entry ? oid(entry.slice(0, entry.indexOf(" "))) : null;
      }
      const target = value.trim();
      if (!target.startsWith("ref: ")) return oid(target);
      ref = target.slice(5);
      if (
        !ref.startsWith("refs/") ||
        /[\\\x00-\x20\x7f:]/.test(ref) ||
        ref.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Invalid Tent Git HEAD reference");
    }
  }

  /** Capture only selected raw content; null explicitly deletes a path from history. */
  async captureUnlocked(
    changes: readonly DocumentChange[],
    metadata: CaptureMetadata = { operation: "document.capture" },
  ): Promise<CaptureResult> {
    const seen = new Set<string>();
    for (const change of changes) {
      documentPath(change.path);
      if (seen.has(change.path)) throw new Error(`Duplicate Git document path: ${change.path}`);
      seen.add(change.path);
      if (change.raw !== null && typeof change.raw !== "string")
        throw new Error(`Invalid raw document: ${change.path}`);
    }
    const gitDir = await this.ensureRepository();
    const before = await this.head();
    const records = Object.keys(metadata.nodeRecords ?? {}).length ? await this.nodeRecords() : {};
    const recordChanges = Object.fromEntries(
      Object.entries(metadata.nodeRecords ?? {}).filter(
        ([id, record]) => !isDeepStrictEqual(records[id], record),
      ),
    );
    metadata = { ...metadata, nodeRecords: recordChanges };
    if (changes.length === 0 && !Object.keys(recordChanges).length)
      return { commit: before, created: false, versions: [] };

    // HEAD is the cache key, never mtime or a process-local "already saved" flag.
    // Cache object identities only; comparison uses Git's exact blob digest.
    if (this.knownHead !== before) {
      this.knownEntries.clear();
      if (before)
        for (const entry of (await runGit(this.root, ["ls-tree", "-r", "-z", before]))
          .toString("utf8")
          .split("\0")) {
          const tab = entry.indexOf("\t");
          if (tab >= 0) this.knownEntries.set(entry.slice(tab + 1), entry.slice(0, tab));
        }
      this.knownHead = before;
    }
    commitMessage(metadata, metadata.objectIds ?? []);
    const objectFormat =
      before?.length === 64
        ? "sha256"
        : before
          ? "sha1"
          : (await runGit(this.root, ["rev-parse", "--show-object-format"]))
              .toString("ascii")
              .trim();
    const expected = new Map(
      changes.map((change) => {
        const bytes = change.raw === null ? null : Buffer.from(change.raw, "utf8");
        const hash =
          bytes &&
          createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        return [change.path, hash ? `100644 blob ${hash}` : undefined] as const;
      }),
    );
    if (
      !Object.keys(recordChanges).length &&
      changes.every((change) => this.knownEntries.get(change.path) === expected.get(change.path))
    ) {
      if ((await this.head()) !== before)
        throw new Error("Tent Git history HEAD changed during capture");
      return {
        commit: before,
        created: false,
        versions: changes
          .filter((c) => c.raw !== null)
          .map((c) => ({ commit: before!, path: c.path })),
      };
    }

    const objectIds = new Set(metadata.objectIds ?? []);
    for (const change of changes) {
      if (this.knownEntries.get(change.path) === expected.get(change.path)) continue;
      if (change.raw !== null) {
        const id = identity(change.raw);
        if (id) objectIds.add(id);
      }
      if (before && this.knownEntries.has(change.path)) {
        const id = identity(await this.readSnapshot({ commit: before, path: change.path }));
        if (id) objectIds.add(id);
      }
    }
    const message = commitMessage(
      { ...metadata, entry: metadata.entry ?? this.defaultEntry },
      [...objectIds].sort(),
    );
    const temporary = await fs.mkdtemp(path.join(gitDir, "tent-index-"));
    const index = path.join(temporary, "index");
    let committed = false;
    try {
      await runGit(this.root, before ? ["read-tree", before] : ["read-tree", "--empty"], { index });
      for (const change of changes) {
        if (change.raw === null) {
          await runGit(this.root, ["update-index", "--force-remove", "--", change.path], { index });
        } else {
          const blob = oid(
            (
              await runGit(this.root, ["hash-object", "-w", "--no-filters", "--stdin"], {
                input: Buffer.from(change.raw, "utf8"),
              })
            )
              .toString("ascii")
              .trim(),
          );
          await runGit(
            this.root,
            ["update-index", "--add", "--cacheinfo", "100644", blob, change.path],
            { index },
          );
        }
      }
      const tree = oid(
        (await runGit(this.root, ["write-tree"], { index })).toString("ascii").trim(),
      );
      const commit = oid(
        (
          await runGit(this.root, [
            "commit-tree",
            tree,
            ...(before ? ["-p", before] : []),
            "-m",
            message,
          ])
        )
          .toString("ascii")
          .trim(),
      );
      try {
        await runGit(this.root, [
          "update-ref",
          "HEAD",
          commit,
          before ?? "0".repeat(commit.length),
        ]);
      } catch (error) {
        throw new Error(`Tent Git history HEAD changed during capture: ${String(error)}`);
      }
      committed = true;
      this.knownHead = commit;
      for (const [path, entry] of expected) {
        if (entry === undefined) this.knownEntries.delete(path);
        else this.knownEntries.set(path, entry);
      }
      return {
        commit,
        created: true,
        versions: changes.filter((c) => c.raw !== null).map((c) => ({ commit, path: c.path })),
      };
    } finally {
      // HEAD publication completes capture. Disposable-index cleanup must not
      // report a failed save after the new revision has already become live.
      await fs.rm(temporary, { recursive: true, force: true }).catch((error) => {
        if (!committed) throw error;
      });
    }
  }

  private async blob(version: DocumentVersion): Promise<string> {
    oid(version.commit);
    documentPath(version.path);
    await this.ensureRepository();
    await runGit(this.root, ["merge-base", "--is-ancestor", version.commit, "HEAD"]);
    const blob = oid(
      (await runGit(this.root, ["rev-parse", "--verify", `${version.commit}:${version.path}`]))
        .toString("ascii")
        .trim(),
    );
    if ((await runGit(this.root, ["cat-file", "-t", blob])).toString("ascii").trim() !== "blob") {
      throw new Error(`Git document is not a blob: ${version.path}`);
    }
    return blob;
  }

  async read(version: DocumentVersion): Promise<string> {
    oid(version.commit);
    documentPath(version.path);
    await this.ensureRepository();
    await runGit(this.root, ["merge-base", "--is-ancestor", version.commit, "HEAD"]);
    return (
      await runGit(this.root, ["cat-file", "blob", `${version.commit}:${version.path}`])
    ).toString("utf8");
  }

  /** Read a committed directory without replaying history or writing derived caches. */
  async readDirectory(commit: string, directory: string): Promise<Map<string, string>> {
    oid(commit);
    documentPath(directory);
    await this.ensureRepository();
    const entries = (
      await runGit(this.root, ["ls-tree", "-r", "-z", commit, "--", `${directory}/`])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const match = /^[0-7]{6} blob ([a-f0-9]+)\t(.+)$/.exec(row);
        if (!match) throw new Error("Invalid Git directory entry");
        return { blob: oid(match[1]!), path: documentPath(match[2]!) };
      });
    const blobs = await readBlobs(
      this.root,
      new Set(entries.map((entry) => entry.blob)),
      (raw) => raw,
    );
    return new Map(
      entries.map((entry) => {
        const raw = blobs.get(entry.blob)!;
        if (raw instanceof Error) throw raw;
        return [entry.path, raw];
      }),
    );
  }

  /** Verify many retained sources against one HEAD, preserving per-source failures. */
  async readVersions(versions: readonly DocumentVersion[]): Promise<
    Array<
      | {
          version: DocumentVersion;
          raw: string;
          changedSince: boolean;
          frontmatter?: Record<string, unknown>;
        }
      | Error
    >
  > {
    if (!versions.length) return [];
    const head = await this.retainedHead();
    if (!head) return versions.map(() => new Error("Tent Git history is empty"));
    const snapshot = await this.snapshot(head);
    const index = await this.versionReadIndex(head);
    const checked = versions.map((version) => {
      try {
        oid(version.commit);
        documentPath(version.path);
        if (!(version.commit in index.trees))
          throw new Error(`Git version is not reachable: ${version.commit}`);
        return version;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    });
    const rawByVersion = new Map<string, string | Error>();
    const dataByVersion = new Map<string, Record<string, unknown>>();
    const missing = new Set<string>();
    for (const version of checked) {
      if (version instanceof Error) continue;
      const key = `${version.commit}:${version.path}`;
      const blob = index.trees[version.commit]![version.path];
      if (!blob) rawByVersion.set(key, new Error(`Git document is unavailable: ${key}`));
      else if (blob in snapshot.blobs) {
        rawByVersion.set(key, snapshot.blobs[blob]!);
        const data = snapshot.frontmatters[blob];
        if (data) dataByVersion.set(key, data);
      } else missing.add(key);
    }
    for (const [key, raw] of await readBlobs(this.root, missing, (raw) => raw))
      rawByVersion.set(key, raw);
    return checked.map((version) => {
      if (version instanceof Error) return version;
      const raw = rawByVersion.get(`${version.commit}:${version.path}`)!;
      if (raw instanceof Error) return raw;
      const changedSince = index.changed[version.commit]!.includes(version.path);
      const data = dataByVersion.get(`${version.commit}:${version.path}`);
      return {
        version,
        raw,
        changedSince,
        ...(data ? { frontmatter: structuredClone(data) } : {}),
      };
    });
  }

  private async versionReadIndex(head: string) {
    return this.derivedAtHead("version-reads", 1, head, async () => {
      const snapshot = await this.snapshot(head);
      const graph = new Map<string, { record: RawHistoryCommit; paths: Set<string> }>();
      for (const record of snapshot.records) {
        const entry = graph.get(record.commit) ?? { record, paths: new Set<string>() };
        for (const file of record.files) entry.paths.add(file.path);
        graph.set(record.commit, entry);
      }
      const trees: Record<string, Record<string, string>> = {};
      for (const commit of graph.keys()) {
        const pending: RawHistoryCommit[] = [];
        for (let next: string | undefined = commit; next && !trees[next];) {
          const record: RawHistoryCommit = graph.get(next)!.record;
          pending.push(record);
          next = record.parent;
        }
        for (const record of pending.reverse()) {
          const tree = { ...(record.parent ? trees[record.parent] : {}) };
          for (const file of record.files) {
            if (file.afterBlob) tree[file.path] = file.afterBlob;
            else delete tree[file.path];
          }
          trees[record.commit] = tree;
        }
      }
      const changed: Record<string, string[]> = {};
      for (const commit of graph.keys()) {
        const ancestors = new Set<string>(),
          pending = [commit];
        while (pending.length) {
          const next = pending.pop()!;
          if (ancestors.has(next)) continue;
          ancestors.add(next);
          pending.push(...graph.get(next)!.record.parents);
        }
        const paths = new Set<string>();
        for (const [next, entry] of graph)
          if (!ancestors.has(next)) for (const file of entry.paths) paths.add(file);
        changed[commit] = [...paths];
      }
      return { trees, changed };
    });
  }

  private async readSnapshot(version: DocumentVersion): Promise<string> {
    return (
      await runGit(this.root, [
        "cat-file",
        "blob",
        `${oid(version.commit)}:${documentPath(version.path)}`,
      ])
    ).toString("utf8");
  }

  async commitTime(commit: string): Promise<string> {
    oid(commit);
    await this.ensureRepository();
    await runGit(this.root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    const time = (await runGit(this.root, ["show", "-s", "--format=%cI", commit]))
      .toString("ascii")
      .trim();
    return new Date(time).toISOString();
  }

  /** First retained timestamps for selected paths, from one reachable history walk. */
  async firstCommitTimes(files: readonly string[]): Promise<Map<string, string>> {
    return this.pathCommitTimes(files, true);
  }

  /** Latest retained change per path; does not capture live files or consult filename dates. */
  async latestCommitTimes(files: readonly string[]): Promise<Map<string, string>> {
    return this.pathCommitTimes(files, false);
  }

  private async pathCommitTimes(
    files: readonly string[],
    first: boolean,
  ): Promise<Map<string, string>> {
    const selected = new Set(files.map(documentPath));
    const times = new Map<string, string>();
    if (!selected.size) return times;
    await this.ensureRepository();
    const head = await this.retainedHead();
    if (!head) return times;
    const entries = await this.pathIndex(head);
    for (const file of selected) {
      const entry = entries[file];
      if (entry) times.set(file, first ? entry.firstTime : entry.latestTime);
    }
    return times;
  }

  /** Publication and current retained state are derived from this path's reachable history. */
  async pathVersions(file: string): Promise<{ first?: DocumentVersion; latest?: DocumentVersion }> {
    documentPath(file);
    const head = await this.retainedHead();
    if (!head) return {};
    const entry = (await this.pathIndex(head))[file];
    return entry
      ? { first: { commit: entry.first, path: file }, latest: { commit: entry.latest, path: file } }
      : {};
  }

  private async pathIndex(head: string) {
    return this.derivedAtHead<
      Record<string, { first: string; firstTime: string; latest: string; latestTime: string }>
    >("path-versions", 1, head, async () => {
      const result: Record<
        string,
        { first: string; firstTime: string; latest: string; latestTime: string }
      > = {};
      for (const record of await this.snapshotRecords(head))
        for (const file of record.files) {
          const previous = result[file.path];
          if (!previous && file.status !== "A") continue;
          result[file.path] = {
            first: previous?.first ?? record.commit,
            firstTime: previous?.firstTime ?? record.time,
            latest: record.commit,
            latestTime: record.time,
          };
        }
      return result;
    });
  }

  /** Changes from an exclusive ancestor to an inclusive descendant, oldest first. */
  async changesInRange(range: { from?: string; to?: string } = {}): Promise<HistoryCommit[]> {
    if (!range.from && !range.to)
      return this.derived("identity-events", 1, () => this.buildChangesInRange(range));
    return this.buildChangesInRange(range);
  }

  private async buildChangesInRange(range: {
    from?: string;
    to?: string;
  }): Promise<HistoryCommit[]> {
    await this.ensureRepository();
    const head = await this.retainedHead();
    if (!head) return [];
    const to = range.to ? oid(range.to) : head;
    const from = range.from ? oid(range.from) : undefined;
    const retained = await this.snapshot(head);
    const byCommit = new Map(retained.records.map((record) => [record.commit, record]));
    if (!byCommit.has(to)) throw new Error(`Git version is not reachable: ${to}`);
    const ancestors = (start: string) => {
      const seen = new Set<string>(),
        pending = [start];
      while (pending.length) {
        const commit = pending.pop()!;
        if (seen.has(commit)) continue;
        seen.add(commit);
        pending.push(...(byCommit.get(commit)?.parents ?? []));
      }
      return seen;
    };
    if (from && !ancestors(to).has(from))
      throw new Error(`Git version is not an ancestor: ${from}`);
    const excluded = from ? ancestors(from) : new Set<string>();
    const records = this.firstParentRecords(retained, to).filter(
      (record) => !excluded.has(record.commit),
    );
    const objects = new Set<string>();
    const initial: Array<{ path: string; blob: string }> = [];
    if (from) {
      const rows = (await runGit(this.root, ["ls-tree", "-r", "-z", from]))
        .toString("utf8")
        .split("\0");
      for (const row of rows) {
        if (!row) continue;
        const separator = row.indexOf("\t"),
          file = documentPath(row.slice(separator + 1));
        if (!isHistoryDocument(file)) continue;
        const [, type, object] = row.slice(0, separator).split(" ");
        if (type !== "blob") throw new Error(`Git history document is not a blob: ${file}`);
        const blob = oid(object!);
        initial.push({ path: file, blob });
        objects.add(blob);
      }
    }
    for (const record of records)
      for (const file of record.files) {
        if (!isHistoryDocument(file.path) || file.status === "T") continue;
        if (file.beforeBlob) objects.add(file.beforeBlob);
        if (file.afterBlob) objects.add(file.afterBlob);
      }
    const identities = new Map<string, string | undefined>();
    for (const object of objects) {
      const id = retained.frontmatters[object]?.id;
      identities.set(object, typeof id === "string" && isHistoryId(id) ? id : undefined);
    }
    const result: HistoryCommit[] = [];
    const live = new Map<string, string>();
    for (const file of initial) {
      const id = identities.get(file.blob);
      if (id) live.set(file.path, id);
    }
    assertUniqueIdentities();
    for (const { commit, parent, time, message, files } of records) {
      const operation = /^Tent-Operation: ([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)$/m.exec(
        message,
      )?.[1];
      const entryValue = /^Tent-Entry: (cli|ui|core)$/m.exec(message)?.[1];
      const entry = entryValue as HistoryCommit["entry"];
      const objectIds = new Set(
        [...message.matchAll(/^Tent-Object: (.+)$/gm)]
          .map((match) => match[1]!)
          .filter(isHistoryId),
      );
      const changes: HistoryChange[] = [];
      const byId = new Map<string, HistoryChange>();
      for (const { path: file, status, beforeBlob, afterBlob } of files) {
        if (!isHistoryDocument(file) || status === "T") continue;
        const before = parent && beforeBlob ? { commit: parent, path: file } : undefined;
        const after = afterBlob ? { commit, path: file } : undefined;
        const beforeId = beforeBlob ? identities.get(beforeBlob) : undefined;
        const afterId = afterBlob ? identities.get(afterBlob) : undefined;
        live.delete(file);
        if (afterId) live.set(file, afterId);
        if (beforeId && afterId && beforeId !== afterId) {
          add(beforeId, before, undefined);
          add(afterId, undefined, after);
        } else {
          add(afterId ?? beforeId, before, after);
        }
      }
      assertUniqueIdentities();
      result.push({
        commit,
        time,
        ...(parent ? { parent } : {}),
        ...(operation ? { operation } : {}),
        objectIds: [...objectIds].sort(),
        ...(entry ? { entry } : {}),
        changes,
      });

      function add(
        id: string | undefined,
        before: DocumentVersion | undefined,
        after: DocumentVersion | undefined,
      ) {
        if (id) objectIds.add(id);
        const existing = id ? byId.get(id) : undefined;
        if (existing) {
          if (before) {
            if (existing.before)
              throw new Error(`Duplicate historical identity ${id} in ${commit}`);
            existing.before = before;
          }
          if (after) {
            if (existing.after) throw new Error(`Duplicate historical identity ${id} in ${commit}`);
            existing.after = after;
          }
        } else {
          const change: HistoryChange = {
            ...(id ? { objectId: id } : {}),
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
          };
          changes.push(change);
          if (id) byId.set(id, change);
        }
      }
    }
    return result;

    function assertUniqueIdentities() {
      const paths = new Map<string, string>();
      for (const [file, id] of live) {
        const existing = paths.get(id);
        if (existing)
          throw new Error(`Duplicate historical identity ${id}: ${existing} and ${file}`);
        paths.set(id, file);
      }
    }
  }

  /** Identity-based history includes old commits, moves, and the deletion event. */
  async nodeVersions(nodeId: string): Promise<HistoryCommit[]> {
    if (!isNodeId(nodeId)) throw new Error(`Invalid Node id: ${nodeId}`);
    return (await this.changesInRange()).flatMap((record) => {
      const changes = record.changes.filter((change) => change.objectId === nodeId);
      return changes.length ? [{ ...record, changes }] : [];
    });
  }

  /** Exact single-parent changes for a reachable commit, with no rename inference. */
  async commitChanges(commit: string) {
    oid(commit);
    await this.ensureRepository();
    await runGit(this.root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    const parents = (await runGit(this.root, ["rev-list", "--parents", "-n", "1", commit]))
      .toString("ascii")
      .trim()
      .split(" ");
    if (parents.length !== 2) throw new Error("Archive undo requires a single-parent commit");
    const parent = oid(parents[1]!);
    const rows = (
      await runGit(this.root, [
        "diff-tree",
        "--no-commit-id",
        "--no-renames",
        "--name-status",
        "-r",
        "-z",
        parent,
        commit,
      ])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const changes: Array<{ path: string; before: string | null; after: string | null }> = [];
    for (let i = 0; i < rows.length; i += 2) {
      const status = rows[i],
        path = documentPath(rows[i + 1]!);
      if (!["A", "M", "D"].includes(status!))
        throw new Error(`Unsupported document change: ${path}`);
      changes.push({
        path,
        before: status === "A" ? null : await this.read({ commit: parent, path }),
        after: status === "D" ? null : await this.read({ commit, path }),
      });
    }
    return { parent, changes };
  }

  /** Retained edits after a selected version invalidate undo even when bytes later match (ABA). */
  async changedSince(version: DocumentVersion): Promise<boolean> {
    oid(version.commit);
    documentPath(version.path);
    await this.ensureRepository();
    await runGit(this.root, ["merge-base", "--is-ancestor", version.commit, "HEAD"]);
    return !!(
      await runGit(this.root, [
        "--literal-pathspecs",
        "log",
        "--full-history",
        "--format=%H",
        "-1",
        `${version.commit}..HEAD`,
        "--",
        version.path,
      ])
    )
      .toString("ascii")
      .trim();
  }

  async pathsUnder(prefix: string): Promise<string[]> {
    documentPath(prefix);
    await this.ensureRepository();
    const head = await this.head();
    if (!head) return [];
    return (await runGit(this.root, ["ls-tree", "-r", "--name-only", "-z", head]))
      .toString("utf8")
      .split("\0")
      .filter((file) => file.startsWith(`${prefix}/`));
  }

  async diff(from: DocumentVersion, to: DocumentVersion): Promise<string> {
    const oldBlob = await this.blob(from);
    const newBlob = await this.blob(to);
    return (
      await runGit(this.root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        oldBlob,
        newBlob,
      ])
    ).toString("utf8");
  }
}
