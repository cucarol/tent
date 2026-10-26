import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parseDocument, isScalar } from "yaml";
import { DatabaseSync } from "./sqlite-runtime.js";
import { durableMkdir, durableReplace } from "./durable-file.js";
import {
  SqliteDocumentHistory,
  sqliteContentFingerprint,
  hasLocalMachinePath,
} from "../core/store/sqlite-history.js";
import { isHistoryFile, isHistoryDocument } from "../core/store/document-history.js";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import { nodeBasisRecordSchema } from "../core/base/node-basis-record.js";
import { isNodeId, isRoleId, isCardId } from "../core/base/id.js";
import { initializeGitIgnoreContext } from "./git-ignore-context.js";
import { materialLocator, isDirectoryMaterial, isPrefixMaterial } from "../core/base/material.js";
import { systemMaterialPath } from "../core/graph/material-target.js";
import { cardSourceIdentityError } from "../core/graph/card-context.js";

const execute = promisify(execFile);
const digest = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const legacyId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const zero = /^0+$/;
type Version = { commit: string; path: string };
type Pin = { field: (string | number)[]; source: Version; target: Version };
type Replacement = {
  field: (string | number)[];
  start: number;
  end: number;
  byteStart: number;
  byteEnd: number;
  before: string;
  after: string;
};
type ByteAudit = {
  path: string;
  originalSha256: string;
  expectedConvertedSha256: string;
  actualImportedSha256?: string;
  exactOriginalBytes: boolean;
  replacements: Replacement[];
  verified?: boolean;
};
type Converted = { raw: string; pins: Pin[]; replacements: Replacement[] };
type Change = { path: string; before: string | null; after: string | null };
type LegacyEvent = {
  id: string;
  parent?: string;
  time: string;
  message: string;
  changes: Change[];
};

function gitEnvironment() {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    GIT_OPTIONAL_LOCKS: "0",
  };
}
export async function legacyGit(root: string, args: string[]): Promise<Buffer> {
  const result = await execute(
    "git",
    [`--git-dir=${path.join(root, ".git")}`, `--work-tree=${root}`, ...args],
    { env: gitEnvironment(), windowsHide: true, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );
  return result.stdout;
}
/** Read exact object bytes, including commit:path addresses, through one read-only Git process. */
async function objects(root: string, requests: readonly string[]) {
  if (!requests.length) return new Map<string, Buffer>();
  const child = spawn(
    "git",
    [`--git-dir=${path.join(root, ".git")}`, `--work-tree=${root}`, "cat-file", "--batch"],
    { env: gitEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const failed = new Promise<never>((_, reject) => child.once("error", reject));
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.stdin.on("error", () => undefined);
  child.stdin.end(requests.join("\n") + "\n");
  const chunks = child.stdout[Symbol.asyncIterator]();
  let buffer: Buffer = Buffer.alloc(0),
    offset = 0;
  async function more() {
    const next = await Promise.race([chunks.next(), failed]);
    if (next.done) throw Error(`Incomplete legacy Git object stream: ${stderr}`);
    buffer = Buffer.concat([buffer.subarray(offset), next.value]);
    offset = 0;
  }
  async function line() {
    let end = buffer.indexOf(10, offset);
    while (end < 0) {
      await more();
      end = buffer.indexOf(10, offset);
    }
    const value = buffer.subarray(offset, end).toString("utf8");
    offset = end + 1;
    return value;
  }
  const result = new Map<string, Buffer>();
  try {
    for (const request of requests) {
      const header = await line(),
        match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
      if (!match) throw Error(`Cannot read pinned/history blob ${request}: ${header}`);
      const length = Number(match[2]);
      while (buffer.length - offset < length + 1) await more();
      result.set(request, Buffer.from(buffer.subarray(offset, offset + length)));
      offset += length;
      if (buffer[offset++] !== 10) throw Error("Invalid legacy Git blob frame");
    }
    while (!(await chunks.next()).done) {}
    const code = await closed;
    if (code !== 0) throw Error(`Legacy Git object read failed (${code}): ${stderr}`);
    return result;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
  }
}

/** Replace only the old hexadecimal scalar. Preserve all surrounding Markdown/YAML bytes. */
export function convertHistoryPins(
  raw: string,
  mapping: ReadonlyMap<string, string>,
  owner: string,
): Converted {
  const data = parseFrontmatter(raw).data;
  const header = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  const pins: Pin[] = [],
    replacements: Replacement[] = [];
  if (!header) return { raw, pins, replacements };
  const yaml = header[1]!,
    start = header[0].indexOf(yaml),
    document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length)
    throw Error(`Invalid frontmatter in ${owner}: ${document.errors[0]!.message}`);
  function visit(value: unknown, fields: (string | number)[], sourceEntry = false) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, [...fields, i], fields.at(-1) === "sources"));
      return;
    }
    for (const [key, v] of Object.entries(value)) {
      const selected = key === "version" && sourceEntry;
      if (!selected) {
        // Only Core's declared material sources carry pins. Unknown extension
        // metadata can contain lookalike versions and must retain its bytes.
        if (fields.length === 0 && key === "sources") visit(v, [key]);
        continue;
      }
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.keys(v).some((k) => !["commit", "path"].includes(k))
      )
        throw Error(`Invalid fixed version in ${owner}:${[...fields, key].join(".")}`);
      const version = v as Version;
      if (
        typeof version.commit !== "string" ||
        !legacyId.test(version.commit) ||
        typeof version.path !== "string" ||
        !isHistoryDocument(version.path) ||
        /[\\:\0\r\n]/.test(version.path) ||
        version.path.split("/").some((p) => !p || p === "." || p === "..")
      )
        throw Error(`Invalid fixed address in ${owner}:${[...fields, key].join(".")}`);
      if (sourceEntry) {
        const resource = (value as { resource?: unknown }).resource;
        if (typeof resource !== "string")
          throw Error(`Invalid fixed source resource in ${owner}:${fields.join(".")}`);
        const locator = materialLocator(resource, owner, true);
        if (
          isDirectoryMaterial(locator) ||
          isPrefixMaterial(locator) ||
          systemMaterialPath(locator) !== version.path ||
          version.path.startsWith("cards/")
        )
          throw Error(
            `Fixed source resource does not address its historical Node or Role in ${owner}:${fields.join(".")}`,
          );
      }
      const commit = mapping.get(version.commit);
      if (!commit)
        throw Error(`Unmapped history event in ${owner}: ${version.commit}:${version.path}`);
      const field = [...fields, key, "commit"],
        scalar = document.getIn(field, true);
      if (!isScalar(scalar) || !scalar.range || scalar.value !== version.commit)
        throw Error(`Fixed version uses an unsupported YAML alias in ${owner}:${field.join(".")}`);
      const [from, to] = scalar.range,
        token = yaml.slice(from, to),
        index = token.indexOf(version.commit);
      if (index < 0 || token.indexOf(version.commit, index + 1) >= 0)
        throw Error(`Cannot locate exact fixed-version bytes in ${owner}`);
      pins.push({
        field: [...fields, key],
        source: { commit: version.commit, path: version.path },
        target: { commit, path: version.path },
      });
      const position = start + from + index;
      replacements.push({
        field,
        start: position,
        end: position + version.commit.length,
        byteStart: Buffer.byteLength(raw.slice(0, position)),
        byteEnd: Buffer.byteLength(raw.slice(0, position + version.commit.length)),
        before: version.commit,
        after: commit,
      });
    }
  }
  visit(data, []);
  let converted = raw;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    if (converted.slice(r.start, r.end) !== r.before)
      throw Error(`Pin replacement changed during conversion in ${owner}`);
    converted = converted.slice(0, r.start) + r.after + converted.slice(r.end);
  }
  return { raw: converted, pins, replacements };
}

async function legacyEvents(root: string): Promise<LegacyEvent[]> {
  const parents = (
    await legacyGit(root, ["rev-list", "--reverse", "--topo-order", "--parents", "HEAD"])
  )
    .toString("ascii")
    .trim()
    .split(/\r?\n/);
  for (const row of parents)
    if (row.split(" ").length > 2)
      throw Error(`Merge history requires an explicit migration decision: ${row}`);
  const fields = (
    await legacyGit(root, [
      "log",
      "--reverse",
      "--topo-order",
      "--root",
      "--no-renames",
      "--raw",
      "-z",
      "--no-abbrev",
      "--format=%H%x00%P%x00%cI%x00%B%x00",
      "HEAD",
    ])
  )
    .toString("utf8")
    .split("\0");
  const result: LegacyEvent[] = [];
  let current: LegacyEvent | undefined;
  for (let i = 0; i < fields.length;) {
    const token = fields[i++]!.replace(/^\n+/, "");
    if (!token) continue;
    if (legacyId.test(token)) {
      const parent = fields[i++]!,
        time = fields[i++]!,
        message = fields[i++]!;
      current = {
        id: token,
        ...(parent ? { parent } : {}),
        time: new Date(time).toISOString(),
        message,
        changes: [],
      };
      result.push(current);
      continue;
    }
    const row = /^:[0-7]{6} [0-7]{6} ([a-f0-9]+) ([a-f0-9]+) ([AMDT])$/.exec(token);
    if (!row || !current) throw Error(`Invalid legacy history framing: ${token}`);
    const file = fields[i++]!;
    if (!isHistoryFile(file)) continue;
    if (row[3] === "T")
      throw Error(`Unsupported historical file type change: ${current.id}:${file}`);
    current.changes.push({
      path: file,
      before: zero.test(row[1]!) ? null : row[1]!,
      after: zero.test(row[2]!) ? null : row[2]!,
    });
  }
  if (result.length !== parents.length) throw Error("Legacy event inventory is incomplete");
  return result;
}
async function legacyHead(root: string): Promise<string | null> {
  try {
    return (await legacyGit(root, ["rev-parse", "--verify", "HEAD"])).toString("ascii").trim();
  } catch (error) {
    const declaration = await fs.readFile(path.join(root, ".git/HEAD"), "utf8");
    if (
      /^ref: refs\/heads\/[^\r\n]+\r?\n?$/.test(declaration) &&
      !(await legacyGit(root, ["rev-list", "--all"])).length
    )
      return null;
    throw error;
  }
}

async function workingFiles(root: string, directories: string[]) {
  const files = new Map<string, Buffer>();
  async function visit(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (file === ".git" || /^mutation\.lock(?:\.|$)/.test(file)) continue;
      if (entry.isSymbolicLink()) throw Error(`Migration refuses a symbolic link: ${file}`);
      if (entry.isDirectory()) {
        directories.push(file);
        await visit(file);
      } else if (entry.isFile()) files.set(file, await fs.readFile(path.join(root, file)));
      else throw Error(`Unsupported migration file: ${file}`);
    }
  }
  await visit("");
  return files;
}

/** Walk physical directory identities, including case aliases and existing junctions. */
async function requireSeparateTarget(source: string, target: string) {
  const sourceState = await fs.stat(source, { bigint: true });
  let ancestor = target;
  for (;;) {
    try {
      ancestor = await fs.realpath(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  for (;;) {
    const state = await fs.stat(ancestor, { bigint: true });
    if (state.dev === sourceState.dev && state.ino === sourceState.ino)
      throw Error("Migration target must be separate from its source");
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

/** One-shot conversion to a fresh, offline target. Never activates or edits the source. */
export async function importGitHistory(sourceRoot: string, targetRoot: string) {
  sourceRoot = path.resolve(sourceRoot);
  targetRoot = path.resolve(targetRoot);
  await requireSeparateTarget(sourceRoot, targetRoot);
  if (
    await fs.access(targetRoot).then(
      () => true,
      () => false,
    )
  )
    throw Error("Migration target already exists");
  for (const p of [
    "mutation.lock",
    ".git/tent-transaction.json",
    "node-move.pending.json",
    "delete.pending.json",
  ])
    if (
      await fs.access(path.join(sourceRoot, p)).then(
        () => true,
        () => false,
      )
    )
      throw Error(`Migration requires a settled offline source: ${p}`);
  const head = await legacyHead(sourceRoot),
    events = head ? await legacyEvents(sourceRoot) : [],
    mapping = new Map(events.map((e) => [e.id, digest(`tent-sqlite-import\0${e.id}`)]));
  const additional = head
    ? (await legacyGit(sourceRoot, ["rev-list", "--all", "--not", head])).toString("ascii").trim()
    : "";
  if (additional)
    throw Error(
      `Additional history roots require an explicit migration decision: ${additional.split(/\r?\n/).length} events`,
    );
  const hashes = [
    ...new Set(
      events.flatMap((e) =>
        e.changes.flatMap((c) => [c.before, c.after].filter((v): v is string => v !== null)),
      ),
    ),
  ];
  const originalBlobs = await objects(sourceRoot, hashes),
    converted = new Map<string, Converted>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function content(hash: string, file: string): Converted {
    const key = hash + ":" + file;
    let value = converted.get(key);
    if (!value) {
      const raw = decoder.decode(originalBlobs.get(hash)!);
      value = isHistoryDocument(file)
        ? convertHistoryPins(raw, mapping, file)
        : { raw, pins: [], replacements: [] };
      converted.set(key, value);
    }
    return value;
  }
  const revisions: (ByteAudit & { event: string; targetEvent: string })[] = [],
    pinDeclarations: {
      owner: string;
      event: string;
      field: (string | number)[];
      source: Version;
      target: Version;
    }[] = [];
  for (const event of events)
    for (const change of event.changes)
      if (change.after) {
        const raw = decoder.decode(originalBlobs.get(change.after)!),
          transformed = content(change.after, change.path);
        revisions.push({
          event: event.id,
          targetEvent: mapping.get(event.id)!,
          path: change.path,
          originalSha256: digest(raw),
          expectedConvertedSha256: digest(transformed.raw),
          exactOriginalBytes: raw === transformed.raw,
          replacements: transformed.replacements,
        });
        for (const pin of transformed.pins)
          pinDeclarations.push({ owner: change.path, event: event.id, ...pin });
      }
  const directories: string[] = [],
    live = await workingFiles(sourceRoot, directories),
    liveConverted = new Map<string, Buffer>(),
    working: ByteAudit[] = [];
  for (const [file, bytes] of live) {
    const transformed = isHistoryDocument(file)
      ? convertHistoryPins(decoder.decode(bytes), mapping, file)
      : { raw: "", pins: [], replacements: [] };
    const after = isHistoryDocument(file) ? Buffer.from(transformed.raw) : bytes;
    liveConverted.set(file, after);
    working.push({
      path: file,
      originalSha256: digest(bytes),
      expectedConvertedSha256: digest(after),
      exactOriginalBytes: bytes.equals(after),
      replacements: transformed.replacements,
    });
    for (const pin of transformed.pins)
      pinDeclarations.push({ owner: file, event: "live", ...pin });
  }
  const requested = [...new Set(pinDeclarations.map((p) => `${p.source.commit}:${p.source.path}`))],
    pinned = await objects(sourceRoot, requested);
  await durableMkdir(targetRoot);
  const history = new SqliteDocumentHistory(targetRoot);
  await history.initialize();
  await history.close();
  await initializeGitIgnoreContext(targetRoot);
  const db = new DatabaseSync(path.join(targetRoot, ".git/history.sqlite"));
  db.exec(
    "PRAGMA synchronous=EXTRA;PRAGMA foreign_keys=ON;CREATE TABLE migration_events(event TEXT PRIMARY KEY,message TEXT NOT NULL) STRICT;CREATE TABLE migration_originals(event TEXT NOT NULL,path TEXT NOT NULL,raw BLOB NOT NULL,PRIMARY KEY(event,path)) STRICT;",
  );
  const sequence = new Map<string, number>();
  let imported = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const event of events) {
      const operation = /^Tent-Operation: (.+)$/m.exec(event.message)?.[1] ?? "document.capture",
        entry = /^Tent-Entry: (cli|ui|core)$/m.exec(event.message)?.[1];
      const seq = Number(
        db.prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)").run(
          mapping.get(event.id)!,
          event.parent ? mapping.get(event.parent)! : null,
          event.time,
          JSON.stringify({
            operation,
            entry,
            objectIds: [...event.message.matchAll(/^Tent-Object: (\S+)$/gm)]
              .map((m) => m[1]!)
              .filter((id) => isNodeId(id) || isRoleId(id) || isCardId(id)),
          }),
        ).lastInsertRowid,
      );
      sequence.set(event.id, seq);
      db.prepare("INSERT INTO migration_events VALUES(?,?)").run(
        mapping.get(event.id)!,
        event.message,
      );
      for (const c of event.changes) {
        const before = c.before ? content(c.before, c.path).raw : null,
          after = c.after ? content(c.after, c.path).raw : null,
          a = before === null ? null : sqliteContentFingerprint(before),
          b = after === null ? null : sqliteContentFingerprint(after);
        if (before !== null) db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(a!, before);
        if (after !== null) db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(b!, after);
        db.prepare("INSERT INTO changes VALUES(?,?,?,?)").run(seq, c.path, a, b);
        if (c.after)
          db.prepare("INSERT INTO migration_originals VALUES(?,?,?)").run(
            mapping.get(event.id)!,
            c.path,
            originalBlobs.get(c.after)!,
          );
        if (b === null) db.prepare("DELETE FROM current WHERE path=?").run(c.path);
        else
          db.prepare(
            "INSERT INTO current VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET digest=excluded.digest,event=excluded.event",
          ).run(c.path, b, seq);
        imported++;
      }
      for (const line of event.message.split(/\r?\n/))
        if (line.startsWith("Tent-Node-Record: ")) {
          let id: string | undefined, value: unknown;
          try {
            const pair = JSON.parse(line.slice(18));
            if (Array.isArray(pair) && typeof pair[0] === "string") {
              id = pair[0];
              value = pair[1];
            }
          } catch {
            const match = /^Tent-Node-Record: \["(node-[a-z0-9]+)"/.exec(line);
            id = match?.[1];
          }
          if (!id || !isNodeId(id)) continue;
          if (
            value &&
            typeof value === "object" &&
            (value as { v?: unknown }).v === 1 &&
            hasLocalMachinePath(value)
          )
            db.prepare("INSERT OR IGNORE INTO unportable_records VALUES(?)").run(id);
          const parsed = nodeBasisRecordSchema.safeParse(value);
          db.prepare(
            "INSERT INTO records VALUES(?,?,?) ON CONFLICT(event,id) DO UPDATE SET value=excluded.value",
          ).run(seq, id, JSON.stringify(parsed.success ? parsed.data : null));
        }
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  for (const directory of directories) await durableMkdir(path.join(targetRoot, directory));
  for (const [file, bytes] of liveConverted) {
    await durableMkdir(path.dirname(path.join(targetRoot, file)));
    await durableReplace(path.join(targetRoot, file), bytes);
  }
  const target = new SqliteDocumentHistory(targetRoot),
    pins = [],
    uncaptured = [];
  try {
    const audit = new DatabaseSync(path.join(targetRoot, ".git/history.sqlite"));
    try {
      const original = audit.prepare(
        "SELECT raw FROM migration_originals WHERE event=? AND path=?",
      );
      for (const row of revisions) {
        const raw = original.get(row.targetEvent, row.path)?.raw;
        if (!(raw instanceof Uint8Array) || digest(Buffer.from(raw)) !== row.originalSha256)
          throw Error(`Original history byte audit failed: ${row.event}:${row.path}`);
        row.actualImportedSha256 = digest(
          await target.read({ commit: row.targetEvent, path: row.path }),
        );
        if (row.actualImportedSha256 !== row.expectedConvertedSha256)
          throw Error(`Converted history byte audit failed: ${row.event}:${row.path}`);
        row.verified = true;
      }
    } finally {
      audit.close();
    }
    for (const row of working) {
      row.actualImportedSha256 = digest(await fs.readFile(path.join(targetRoot, row.path)));
      if (row.actualImportedSha256 !== row.expectedConvertedSha256)
        throw Error(`Working file byte audit failed: ${row.path}`);
      row.verified = true;
    }
    for (const declaration of pinDeclarations) {
      const key = `${declaration.source.commit}:${declaration.source.path}`,
        original = pinned.get(key)!,
        expected = convertHistoryPins(decoder.decode(original), mapping, declaration.source.path),
        actual = await target.read(declaration.target);
      if (actual !== expected.raw)
        throw Error(
          `Fixed historical source mismatch: ${declaration.owner}:${declaration.field.join(".")}`,
        );
      const before = decoder.decode(original),
        originalDiagnostic = cardSourceIdentityError(
          declaration.source.path,
          before,
          parseFrontmatter(before).data,
        ),
        importedDiagnostic = cardSourceIdentityError(
          declaration.target.path,
          actual,
          parseFrontmatter(actual).data,
        );
      if (originalDiagnostic !== importedDiagnostic)
        throw Error(
          `Fixed historical source diagnostic changed: ${declaration.owner}:${declaration.field.join(".")}`,
        );
      pins.push({
        ...declaration,
        originalSha256: digest(original),
        expectedConvertedSha256: digest(expected.raw),
        actualConvertedSha256: digest(actual),
        exactOriginalBytes: original.equals(Buffer.from(actual)),
        targetReplacements: expected.replacements,
        diagnostics: { before: originalDiagnostic, after: importedDiagnostic },
        status: originalDiagnostic ? "originally-invalid-preserved" : "verified",
        verified: originalDiagnostic === null,
      });
    }
    const current = head
      ? await target.readDirectory(mapping.get(head)!)
      : new Map<string, string>();
    for (const [file, raw] of current) {
      const bytes = liveConverted.get(file);
      if (!bytes || !bytes.equals(Buffer.from(raw)))
        uncaptured.push({
          path: file,
          kind: bytes ? "external-edit" : "deleted",
          retainedSha256: digest(raw),
          liveSha256: bytes ? digest(bytes) : null,
        });
    }
    for (const [file, bytes] of liveConverted)
      if (isHistoryDocument(file) && !current.has(file))
        uncaptured.push({
          path: file,
          kind: "unretained",
          retainedSha256: null,
          liveSha256: digest(bytes),
        });
    if ((await legacyHead(sourceRoot)) !== head)
      throw Error("Offline source HEAD changed during migration");
    const finalDirectories: string[] = [],
      finalFiles = await workingFiles(sourceRoot, finalDirectories);
    if (
      finalFiles.size !== live.size ||
      JSON.stringify([...finalDirectories].sort()) !== JSON.stringify([...directories].sort()) ||
      [...live].some(([file, bytes]) => !finalFiles.get(file)?.equals(bytes))
    )
      throw Error("Offline source files changed during migration");
  } finally {
    await target.close();
  }
  const check = new DatabaseSync(path.join(targetRoot, ".git/history.sqlite"));
  try {
    const rows = check.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
      throw Error("Imported SQLite integrity check failed");
  } finally {
    check.close();
  }
  return {
    sourceRoot,
    targetRoot,
    sourceHead: head,
    targetHead: head ? mapping.get(head)! : null,
    events: events.length,
    changes: imported,
    graphFiles: live.size,
    directories,
    mapping: Object.fromEntries(mapping),
    revisions,
    working,
    pins,
    preservedInvalidPins: pins.filter((pin) => !pin.verified),
    uncaptured,
    note: "Offline target only. Original bytes and transformed version fields are reported separately. No source write, activation or Git fallback.",
  };
}
