import { DatabaseSync, type SQLInputValue } from "../../fs/sqlite-runtime.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as fs from "node:fs/promises";
import { durableMkdir, syncDirectory } from "../../fs/durable-file.js";
import { unifiedLineDiff } from "./line-diff.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { nodeBasisRecordSchema, type NodeBasisRecord } from "../base/node-basis-record.js";
import { isNodeId, isRoleId, isCardId } from "../base/id.js";
import { isHistoryFile, isHistoryDocument } from "./document-history.js";
import type { DocumentHistory } from "./history-port.js";
import type {
  CaptureMetadata,
  CaptureResult,
  DocumentChange,
  DocumentVersion,
  HistoryCommit,
  HistoryChange,
} from "./history-port.js";

type Observer = { before(commit: string): Promise<void>; after(): Promise<void> };
type Row = Record<string, string | number | null>;
type Event = { seq: number; id: string; parent: string | null; time: string; metadata: string };
export type SqliteCheckpoint = "before-publication" | "before-commit" | "after-commit";

export function sqliteContentFingerprint(raw: string): string {
  const bytes = Buffer.from(raw);
  return createHash("sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
function checkedPath(file: string) {
  if (
    !isHistoryFile(file) ||
    /[\\:\x00-\x1f\x7f]/.test(file) ||
    file.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error(`Invalid history path: ${file}`);
  return file;
}
function objectId(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  try {
    const id = parseFrontmatter(raw).data.id;
    return typeof id === "string" && (isNodeId(id) || isRoleId(id) || isCardId(id))
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}
export function hasLocalMachinePath(value: unknown): boolean {
  if (typeof value === "string") {
    if (/^(?:[\\/]|file:)|(?:^|[^a-z0-9])[a-z]:[\\/]|\\\\[?.]\\/i.test(value)) return true;
    try {
      return hasLocalMachinePath(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(hasLocalMachinePath);
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(([k, v]) => hasLocalMachinePath(k) || hasLocalMachinePath(v))
  );
}

/** Content-addressed bytes, immutable event versions, current membership; caller owns mutation.lock. */
export class SqliteDocumentHistory implements DocumentHistory {
  private closed = false;
  private database?: DatabaseSync;
  private opening?: Promise<DatabaseSync>;
  private observer = new AsyncLocalStorage<Observer>();
  private async hasLegacyHistory() {
    return (
      (await fs.access(path.join(this.systemRoot, "index.md")).then(
        () => true,
        () => false,
      )) &&
      (await fs.access(path.join(this.systemRoot, ".git/HEAD")).then(
        () => true,
        () => false,
      ))
    );
  }
  constructor(
    readonly systemRoot: string,
    private readonly entry: CaptureMetadata["entry"] = "core",
    private readonly checkpoint?: (point: SqliteCheckpoint) => Promise<void>,
  ) {}

  private async db(create = false): Promise<DatabaseSync> {
    if (this.closed) throw new Error("Tent history connection is closed");
    if (this.database) return this.database;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (await this.hasLegacyHistory())
        throw new Error(
          "This Workspace has legacy Git history; migrate an offline copy before opening it with SQLite",
        );
      if (!create && !(await this.available()))
        throw new Error("Tent SQLite history is unavailable; initialize or migrate this Workspace");
      await durableMkdir(path.join(this.systemRoot, ".git"));
      const db = new DatabaseSync(path.join(this.systemRoot, ".git", "history.sqlite"));
      try {
        // Even the first format read can race another connection's exclusive commit.
        db.exec("PRAGMA busy_timeout=8000");
        const version = db.prepare("PRAGMA user_version").get()?.user_version;
        if (!create && version !== 1)
          throw new Error(`Unsupported Tent SQLite history format: ${version}`);
        db.exec("PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON");
        if (create)
          db.exec(`PRAGMA journal_mode=DELETE;
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, parent TEXT, time TEXT NOT NULL, metadata TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS blobs(digest TEXT PRIMARY KEY, raw TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS changes(event INTEGER NOT NULL REFERENCES events(seq), path TEXT NOT NULL, before_digest TEXT REFERENCES blobs(digest), after_digest TEXT REFERENCES blobs(digest), PRIMARY KEY(event,path)) STRICT;
          CREATE INDEX IF NOT EXISTS changes_path ON changes(path,event);
          CREATE TABLE IF NOT EXISTS current(path TEXT PRIMARY KEY, digest TEXT NOT NULL REFERENCES blobs(digest), event INTEGER NOT NULL REFERENCES events(seq)) STRICT;
          CREATE TABLE IF NOT EXISTS records(event INTEGER NOT NULL REFERENCES events(seq), id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(event,id)) STRICT;
          CREATE TABLE IF NOT EXISTS unportable_records(id TEXT PRIMARY KEY) STRICT;`);
        if (create) db.exec("PRAGMA user_version=1");
        this.database = db;
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }
  async initialize() {
    await this.db(true);
  }
  async close() {
    if (this.opening) await this.opening.catch(() => undefined);
    this.database?.close();
    this.database = undefined;
    this.closed = true;
  }
  private async all(sql: string, ...args: SQLInputValue[]): Promise<Row[]> {
    return (await this.db()).prepare(sql).all(...args) as Row[];
  }
  private async event(id: string): Promise<Event> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Invalid SQLite event: ${id}`);
    const row = (await this.all("SELECT * FROM events WHERE id=?", id))[0];
    if (!row) throw new Error(`Unknown SQLite event: ${id}`);
    return row as unknown as Event;
  }
  private async digestAt(event: number, file: string): Promise<string | null> {
    return (
      ((
        await this.all(
          "SELECT after_digest FROM changes WHERE path=? AND event<=? ORDER BY event DESC LIMIT 1",
          checkedPath(file),
          event,
        )
      )[0]?.after_digest as string | null) ?? null
    );
  }
  private async raw(digest: string): Promise<string> {
    const row = (await this.all("SELECT raw FROM blobs WHERE digest=?", digest))[0];
    if (!row || sqliteContentFingerprint(String(row.raw)) !== digest)
      throw new Error(`Damaged SQLite content: ${digest}`);
    return String(row.raw);
  }
  async available() {
    if (this.closed) throw new Error("Tent history connection is closed");
    if (await this.hasLegacyHistory())
      throw new Error(
        "This Workspace has legacy Git history; migrate an offline copy before opening it with SQLite",
      );
    return fs.access(path.join(this.systemRoot, ".git/history.sqlite")).then(
      () => true,
      () => false,
    );
  }
  async currentCommit(): Promise<string | null> {
    return (
      ((await this.all("SELECT id FROM events ORDER BY seq DESC LIMIT 1"))[0]?.id as string) ?? null
    );
  }
  async isPublished(commit: string) {
    return !!(await this.all("SELECT id FROM events WHERE id=?", commit)).length;
  }
  withPublicationObserver<T>(observer: Observer, action: () => Promise<T>) {
    return this.observer.run(observer, action);
  }

  async captureUnlocked(
    changes: readonly DocumentChange[],
    metadata: CaptureMetadata = { operation: "document.capture" },
  ): Promise<CaptureResult> {
    const seen = new Set<string>();
    for (const c of changes) {
      checkedPath(c.path);
      if (seen.has(c.path)) throw new Error(`Duplicate capture path: ${c.path}`);
      seen.add(c.path);
    }
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(metadata.operation))
      throw new Error("Invalid history operation");
    for (const id of metadata.objectIds ?? [])
      if (!(isNodeId(id) || isRoleId(id) || isCardId(id)))
        throw new Error(`Invalid history identity: ${id}`);
    if (metadata.entry !== undefined && !["cli", "ui", "core"].includes(metadata.entry))
      throw new Error("Invalid history entry");
    const previousRecords = await this.nodeRecords();
    const nodeRecords: Record<string, NodeBasisRecord> = {};
    for (const [id, value] of Object.entries(metadata.nodeRecords ?? {})) {
      if (!isNodeId(id)) throw new Error(`Invalid Node record: ${id}`);
      if (hasLocalMachinePath(value))
        throw new Error(
          "Node records cannot contain local machine paths; use workspace-relative paths",
        );
      const record = nodeBasisRecordSchema.parse(value);
      if (!isDeepStrictEqual(previousRecords[id], record)) nodeRecords[id] = record;
    }
    const db = await this.db(),
      before = await this.currentCommit();
    const current = new Map(
      (await this.all("SELECT path,digest FROM current")).map((r) => [
        String(r.path),
        String(r.digest),
      ]),
    );
    const selected = changes.map((c) => ({
      ...c,
      before: current.get(c.path) ?? null,
      digest: c.raw === null ? null : sqliteContentFingerprint(c.raw),
    }));
    const changed = selected.filter((c) => c.before !== c.digest);
    const publication =
      metadata.operation === "document.external-capture" ? undefined : this.observer.getStore();
    if (!changed.length && !Object.keys(nodeRecords).length) {
      const handle = await fs.open(path.join(this.systemRoot, ".git/history.sqlite"), "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(path.join(this.systemRoot, ".git"));
      await publication?.after();
      return {
        commit: before,
        created: false,
        versions: selected
          .filter((c) => c.raw !== null)
          .map((c) => ({ commit: before!, path: c.path })),
      };
    }
    // Event occurrence, not just content, preserves A -> B -> A and archive-undo semantics.
    const id = createHash("sha256")
      .update(randomUUID())
      .update(before ?? "")
      .digest("hex");
    await publication?.before(id);
    if (this.checkpoint) await this.checkpoint("before-publication");
    let committed = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        (db.prepare("SELECT id FROM events ORDER BY seq DESC LIMIT 1").get()?.id ?? null) !== before
      )
        throw new Error("SQLite history changed during capture; reread before retrying");
      const saved = { ...metadata, entry: metadata.entry ?? this.entry, nodeRecords };
      const seq = Number(
        db
          .prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)")
          .run(id, before, new Date().toISOString(), JSON.stringify(saved)).lastInsertRowid,
      );
      for (const c of changed) {
        if (c.raw !== null)
          db.prepare("INSERT OR IGNORE INTO blobs(digest,raw) VALUES(?,?)").run(c.digest!, c.raw);
        db.prepare(
          "INSERT INTO changes(event,path,before_digest,after_digest) VALUES(?,?,?,?)",
        ).run(seq, c.path, c.before, c.digest);
        if (c.digest === null) db.prepare("DELETE FROM current WHERE path=?").run(c.path);
        else
          db.prepare(
            "INSERT INTO current(path,digest,event) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET digest=excluded.digest,event=excluded.event",
          ).run(c.path, c.digest, seq);
      }
      for (const [key, value] of Object.entries(nodeRecords))
        db.prepare("INSERT INTO records(event,id,value) VALUES(?,?,?)").run(
          seq,
          key,
          JSON.stringify(value),
        );
      // Current retained identities must remain unique, including moves captured as delete + add.
      const ids = new Map<string, string>();
      for (const r of db.prepare("SELECT path,raw FROM current JOIN blobs USING(digest)").all()) {
        if (!isHistoryDocument(String(r.path))) continue;
        const key = objectId(String(r.raw));
        if (!key) continue;
        if (ids.has(key))
          throw new Error(`Duplicate historical identity ${key}: ${ids.get(key)} and ${r.path}`);
        ids.set(key, String(r.path));
      }
      if (this.checkpoint) await this.checkpoint("before-commit");
      db.exec("COMMIT");
      committed = true;
      if (this.checkpoint) await this.checkpoint("after-commit");
      await publication?.after();
      return {
        commit: id,
        created: true,
        versions: selected.filter((c) => c.raw !== null).map((c) => ({ commit: id, path: c.path })),
      };
    } catch (error) {
      if (!committed && db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  async read(version: DocumentVersion) {
    const digest = await this.digestAt((await this.event(version.commit)).seq, version.path);
    if (!digest) throw new Error(`Document absent at SQLite event: ${version.path}`);
    return this.raw(digest);
  }
  async changedSince(version: DocumentVersion) {
    return !!(
      await this.all(
        "SELECT event FROM changes WHERE path=? AND event>? LIMIT 1",
        checkedPath(version.path),
        (await this.event(version.commit)).seq,
      )
    ).length;
  }
  async readVersions(versions: readonly DocumentVersion[]) {
    const head = (await this.all("SELECT MAX(seq) AS seq FROM events"))[0]?.seq;
    return Promise.all(
      versions.map(async (version) => {
        try {
          const raw = await this.read(version);
          return {
            version,
            raw,
            changedSince: !!(
              await this.all(
                "SELECT event FROM changes WHERE path=? AND event>? AND event<=? LIMIT 1",
                checkedPath(version.path),
                (await this.event(version.commit)).seq,
                head ?? 0,
              )
            ).length,
            ...(isHistoryDocument(version.path) ? { frontmatter: parseFrontmatter(raw).data } : {}),
          };
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      }),
    );
  }
  async readDirectory(commit: string, directory?: string) {
    const seq = (await this.event(commit)).seq;
    const rows = await this.all(
      "SELECT c.path,c.after_digest AS digest FROM changes c WHERE c.event=(SELECT MAX(x.event) FROM changes x WHERE x.path=c.path AND x.event<=?) AND c.after_digest IS NOT NULL",
      seq,
    );
    const result = new Map<string, string>();
    for (const row of rows) {
      const file = String(row.path);
      if (directory === undefined ? !isHistoryDocument(file) : !file.startsWith(`${directory}/`))
        continue;
      result.set(file, await this.raw(String(row.digest)));
    }
    return result;
  }
  async documentBlobs() {
    return new Map(
      (await this.all("SELECT path,digest FROM current"))
        .filter((r) => isHistoryDocument(String(r.path)))
        .map((r) => [String(r.path), String(r.digest)]),
    );
  }
  async retainedPaths() {
    return (await this.all("SELECT path FROM current ORDER BY path")).map((r) => String(r.path));
  }
  async pathsUnder(prefix: string) {
    return (await this.retainedPaths()).filter((p) => p.startsWith(`${prefix}/`));
  }
  async changedRetainedDocuments(documents: readonly { path: string; raw: string }[]) {
    const blobs = await this.documentBlobs(),
      result = [];
    for (const d of documents) {
      const digest = blobs.get(d.path);
      if (digest && digest !== sqliteContentFingerprint(d.raw))
        result.push({ ...d, previousRaw: await this.raw(digest) });
    }
    return result;
  }
  async nodeRecords(): Promise<Record<string, NodeBasisRecord | null>> {
    return Object.fromEntries(
      (
        await this.all(
          "SELECT r.id,r.value FROM records r WHERE r.event=(SELECT MAX(x.event) FROM records x WHERE x.id=r.id)",
        )
      ).map((r) => {
        const value = JSON.parse(String(r.value));
        return [
          String(r.id),
          value === null || hasLocalMachinePath(value) ? null : nodeBasisRecordSchema.parse(value),
        ];
      }),
    );
  }
  async unportableNodeRecordIds() {
    const current = (await this.all("SELECT DISTINCT id,value FROM records"))
      .filter((r) => hasLocalMachinePath(JSON.parse(String(r.value))))
      .map((r) => String(r.id));
    return [
      ...new Set([
        ...current,
        ...(await this.all("SELECT id FROM unportable_records")).map((r) => String(r.id)),
      ]),
    ].sort();
  }
  async pathVersions(file: string) {
    checkedPath(file);
    const rows = await this.all(
      "SELECT e.id FROM changes c JOIN events e ON e.seq=c.event WHERE c.path=? ORDER BY c.event",
      file,
    );
    return rows.length
      ? {
          first: { commit: String(rows[0]!.id), path: file },
          latest: { commit: String(rows.at(-1)!.id), path: file },
        }
      : {};
  }
  async firstCommitTimes(files: readonly string[]) {
    const result = new Map<string, string>();
    for (const file of files) {
      const r = (
        await this.all(
          "SELECT time FROM changes c JOIN events e ON e.seq=c.event WHERE c.path=? ORDER BY e.seq LIMIT 1",
          checkedPath(file),
        )
      )[0];
      if (r) result.set(file, String(r.time));
    }
    return result;
  }
  async cardQueueTimes(head: string, files: readonly string[]) {
    const max = (await this.event(head)).seq,
      published = new Map<string, string>(),
      returned = new Map<string, string>();
    for (const file of files)
      for (const row of await this.all(
        "SELECT e.time,e.metadata,c.before_digest,c.after_digest FROM changes c JOIN events e ON e.seq=c.event WHERE c.path=? AND e.seq<=? ORDER BY e.seq",
        checkedPath(file),
        max,
      )) {
        if (row.before_digest === null && row.after_digest !== null && !published.has(file))
          published.set(file, String(row.time));
        if (
          JSON.parse(String(row.metadata)).operation === "card.return" &&
          row.after_digest !== null
        )
          returned.set(file, String(row.time));
      }
    return { published, returned };
  }
  async completedCardPaths(completed: (file: string, raw: string) => boolean) {
    const head = await this.currentCommit();
    return new Set(
      head
        ? [...(await this.readDirectory(head, "cards"))]
            .filter(([p, r]) => completed(p, r))
            .map(([p]) => p)
        : [],
    );
  }
  async derived<T>(
    _name: string,
    _schemaVersion: number,
    compute: (head: string | null) => Promise<T>,
  ): Promise<T> {
    return compute(await this.currentCommit());
  }
  async changesInRange(range: { from?: string; to?: string } = {}): Promise<HistoryCommit[]> {
    const from = range.from ? (await this.event(range.from)).seq : 0,
      to = range.to ? (await this.event(range.to)).seq : Number.MAX_SAFE_INTEGER;
    if (from > to) throw new Error("Invalid SQLite history range");
    const result: HistoryCommit[] = [];
    for (const row of await this.all(
      "SELECT * FROM events WHERE seq>? AND seq<=? ORDER BY seq",
      from,
      to,
    )) {
      const event = row as unknown as Event,
        metadata = JSON.parse(event.metadata) as CaptureMetadata,
        changes: HistoryChange[] = [],
        byId = new Map<string, HistoryChange>(),
        objectIds = new Set(metadata.objectIds ?? []);
      for (const c of await this.all(
        "SELECT * FROM changes WHERE event=? ORDER BY path",
        event.seq,
      )) {
        const file = String(c.path),
          old = c.before_digest === null ? null : await this.raw(String(c.before_digest)),
          raw = c.after_digest === null ? null : await this.raw(String(c.after_digest));
        const before = old === null ? undefined : { commit: event.parent!, path: file },
          after = raw === null ? undefined : { commit: event.id, path: file };
        const a = isHistoryDocument(file) ? objectId(old) : undefined,
          b = isHistoryDocument(file) ? objectId(raw) : undefined;
        const add = (
          id: string | undefined,
          before: DocumentVersion | undefined,
          after: DocumentVersion | undefined,
        ) => {
          if (id) objectIds.add(id);
          const current = id ? byId.get(id) : undefined;
          if (current) {
            if (before) current.before = before;
            if (after) current.after = after;
          } else {
            const change = {
              ...(id ? { objectId: id } : {}),
              ...(before ? { before } : {}),
              ...(after ? { after } : {}),
            };
            changes.push(change);
            if (id) byId.set(id, change);
          }
        };
        if (a && b && a !== b) {
          add(a, before, undefined);
          add(b, undefined, after);
        } else add(b ?? a, before, after);
      }
      result.push({
        commit: event.id,
        time: event.time,
        ...(event.parent ? { parent: event.parent } : {}),
        operation: metadata.operation,
        objectIds: [...objectIds].sort(),
        entry: metadata.entry,
        changes,
      });
    }
    return result;
  }
  async nodeVersions(nodeId: string) {
    if (!isNodeId(nodeId)) throw new Error("Invalid Node id");
    return (await this.changesInRange()).flatMap((e) => {
      const changes = e.changes.filter((c) => c.objectId === nodeId);
      return changes.length ? [{ ...e, changes }] : [];
    });
  }
  async commitChanges(commit: string) {
    const event = await this.event(commit);
    if (!event.parent) throw new Error("Archive undo requires a single-parent event");
    const changes = [];
    for (const c of await this.all("SELECT * FROM changes WHERE event=? ORDER BY path", event.seq))
      changes.push({
        path: String(c.path),
        before: c.before_digest === null ? null : await this.raw(String(c.before_digest)),
        after: c.after_digest === null ? null : await this.raw(String(c.after_digest)),
      });
    return { parent: event.parent, changes };
  }
  async diff(from: DocumentVersion, to: DocumentVersion) {
    const a = await this.read(from),
      b = await this.read(to);
    return unifiedLineDiff(a, b, from.path, to.path);
  }
}
