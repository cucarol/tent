import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";
import { parseFrontmatter } from "./frontmatter.js";
import { isCardId, isNodeId, isRoleId } from "./id.js";
import { isHistoryDocument } from "./document-history.js";

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
    (metadata.entry ? `\nTent-Entry: ${metadata.entry}` : "")
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
  parent?: string;
  time: string;
  message: string;
  files: Array<{ path: string; beforeBlob?: string; afterBlob?: string }>;
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
    if (row[3] === "T" || !isHistoryDocument(file)) continue;
    current.files.push({
      path: file,
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

/** Git plumbing for selected Markdown documents. Caller holds the Tent mutation lock for captureUnlocked. */
export class GitDocumentHistory {
  private readonly root: string;
  private readonly defaultEntry: CaptureMetadata["entry"];
  private knownHead: string | null | undefined;
  private knownEntries = new Map<string, string>();

  constructor(systemRoot: string, entry: CaptureMetadata["entry"] = "core") {
    this.root = path.resolve(systemRoot);
    this.defaultEntry = entry;
  }

  async available(): Promise<boolean> {
    try {
      await this.ensureRepository();
      await runGit(this.root, ["rev-parse", "--git-dir"]);
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
    if (changes.length === 0) return { commit: before, created: false, versions: [] };

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

  /** Verify many retained sources against one HEAD, preserving per-source failures. */
  async readVersions(
    versions: readonly DocumentVersion[],
  ): Promise<Array<{ version: DocumentVersion; raw: string; changedSince: boolean } | Error>> {
    if (!versions.length) return [];
    const head = await this.currentCommit();
    if (!head) return versions.map(() => new Error("Tent Git history is empty"));
    // Retain changes against every merge parent, just as --full-history path
    // queries do. Keep the whole parent graph for version reachability/exclusion.
    const fields = (
      await runGit(this.root, [
        "log",
        "--full-history",
        "--raw",
        "-z",
        "--root",
        "--no-renames",
        "--no-abbrev",
        "--no-color",
        "--no-show-signature",
        "--diff-merges=separate",
        "--always",
        "--format=%x00%H%x00%P%x00",
        head,
      ])
    )
      .toString("utf8")
      .split("\0");
    const commits = new Map<string, { parents: string[]; paths: Set<string> }>();
    let current: { parents: string[]; paths: Set<string> } | undefined;
    for (let i = 0; i < fields.length;) {
      const token = fields[i++]!.replace(/^\n/, "");
      if (!token) continue;
      if (oidPattern.test(token)) {
        const parents = fields[i++]!.split(" ").filter(Boolean);
        current = commits.get(token) ?? { parents, paths: new Set() };
        commits.set(token, current);
      } else if (current && token.startsWith(":")) {
        current.paths.add(fields[i++]!);
      } else throw new Error("Invalid Git source history record");
    }
    const ancestors = new Map<string, Set<string>>();
    function excluded(commit: string) {
      const cached = ancestors.get(commit);
      if (cached) return cached;
      const seen = new Set<string>(),
        pending = [commit];
      while (pending.length) {
        const next = pending.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(...(commits.get(next)?.parents ?? []));
      }
      ancestors.set(commit, seen);
      return seen;
    }
    const checked = versions.map((version) => {
      try {
        oid(version.commit);
        documentPath(version.path);
        if (!commits.has(version.commit))
          throw new Error(`Git version is not reachable: ${version.commit}`);
        return version;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    });
    const objects = new Set(
      checked.flatMap((version) =>
        version instanceof Error ? [] : [`${version.commit}:${version.path}`],
      ),
    );
    const blobs = await readBlobs(this.root, objects, (raw) => raw);
    return checked.map((version) => {
      if (version instanceof Error) return version;
      const raw = blobs.get(`${version.commit}:${version.path}`)!;
      if (raw instanceof Error) return raw;
      const before = excluded(version.commit);
      const changedSince = [...commits].some(
        ([commit, entry]) => !before.has(commit) && entry.paths.has(version.path),
      );
      return { version, raw, changedSince };
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
    const head = await this.currentCommit();
    if (!head) return times;
    const log = await runGit(this.root, [
      "--literal-pathspecs",
      "log",
      "--full-history",
      ...(first ? ["--reverse", "--diff-filter=A"] : ["--diff-merges=separate"]),
      // A single-path query sees the destination as an addition, not a rename.
      "--no-renames",
      "--format=%cI",
      "-z",
      "--name-only",
      head,
      "--",
      ...selected,
    ]);
    let time: string | undefined;
    for (const token of log.toString("utf8").split("\0")) {
      // Git separates a commit header from its first path with a newline.
      // Document paths cannot contain control characters; -z leaves names unquoted.
      const value = token.replace(/^\n/, "");
      // ISO dates contain colons, which documentPath rejects in filenames.
      if (value.includes(":")) {
        time = new Date(value).toISOString();
      } else if (time && selected.has(value) && !times.has(value)) {
        times.set(value, time);
      }
    }
    return times;
  }

  /** Publication and current retained state are derived from this path's reachable history. */
  async pathVersions(file: string): Promise<{ first?: DocumentVersion; latest?: DocumentVersion }> {
    documentPath(file);
    await this.ensureRepository();
    if (!(await this.head())) return {};
    const first = (
      await runGit(this.root, [
        "--literal-pathspecs",
        "log",
        "--full-history",
        "--reverse",
        "--diff-filter=A",
        "--format=%H",
        "--",
        file,
      ])
    )
      .toString("ascii")
      .trim()
      .split("\n")[0];
    const latest = (
      await runGit(this.root, [
        "--literal-pathspecs",
        "log",
        "--full-history",
        "-1",
        "--format=%H",
        "--",
        file,
      ])
    )
      .toString("ascii")
      .trim();
    return {
      ...(first ? { first: { commit: oid(first), path: file } } : {}),
      ...(latest ? { latest: { commit: oid(latest), path: file } } : {}),
    };
  }

  /** Changes from an exclusive ancestor to an inclusive descendant, oldest first. */
  async changesInRange(range: { from?: string; to?: string } = {}): Promise<HistoryCommit[]> {
    await this.ensureRepository();
    const head = await this.currentCommit();
    if (!head) return [];
    const to = range.to ? oid(range.to) : head;
    if (to !== head) await runGit(this.root, ["merge-base", "--is-ancestor", to, head]);
    const from = range.from ? oid(range.from) : undefined;
    if (from) await runGit(this.root, ["merge-base", "--is-ancestor", from, to]);
    const records = parseHistoryLog(
      await runGit(this.root, [
        "log",
        "--first-parent",
        "--reverse",
        "--raw",
        "-z",
        "--no-renames",
        "--root",
        "--no-abbrev",
        "--no-color",
        "--no-show-signature",
        "--diff-merges=first-parent",
        "--format=%x00%H%x00%P%x00%cI%x00%B%x00",
        from ? `${from}..${to}` : to,
      ]),
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
        if (file.beforeBlob) objects.add(file.beforeBlob);
        if (file.afterBlob) objects.add(file.afterBlob);
      }
    const identities = new Map<string, string | undefined>();
    for (const [object, result] of await readBlobs(this.root, objects, identity)) {
      if (result instanceof Error) throw result;
      identities.set(object, result);
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
      for (const { path: file, beforeBlob, afterBlob } of files) {
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
