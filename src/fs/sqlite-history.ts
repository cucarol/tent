import { DatabaseSync, type SQLInputValue } from "./sqlite-runtime.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as fs from "node:fs/promises";
import { durableMkdir } from "./durable-file.js";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import { isNodeId, isRoleId, isCardId } from "../core/base/id.js";
import type { DocumentHistory } from "../core/store/history-port.js";
import type {
  CaptureMetadata,
  CaptureResult,
  DocumentChange,
  DocumentVersion,
  HistoryCommit,
  HistoryChange,
} from "../core/store/history-port.js";

type Observer = { before(commit: string): Promise<void>; after(): Promise<void> };
type Row = Record<string, string | number | null>;
type Event = { seq: number; id: string; parent: string | null; time: string; metadata: string };
export type SqliteCheckpoint = "before-publication" | "before-commit" | "after-commit";

export function sqliteContentFingerprint(raw: string): string {
  const bytes = Buffer.from(raw);
  return createHash("sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
function objectId(raw: string): string | undefined {
  try {
    const id = parseFrontmatter(raw).data.id;
    return typeof id === "string" && (isNodeId(id) || isRoleId(id) || isCardId(id))
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}
function commitOf(
  event: Event,
  rows: readonly Row[],
  raws: ReadonlyMap<string, string>,
): HistoryCommit {
  const identity = (digest: Row[string]) =>
      digest === null ? undefined : objectId(raws.get(String(digest))!),
    changes: HistoryChange[] = [],
    byId = new Map<string, HistoryChange[]>(),
    objectIds = new Set<string>();
  for (const c of rows) {
    const file = String(c.path),
      before = c.before_digest === null ? undefined : { commit: event.parent!, path: file },
      after = c.after_digest === null ? undefined : { commit: event.id, path: file },
      a = identity(c.before_digest),
      b = identity(c.after_digest);
    const add = (
      id: string | undefined,
      before: DocumentVersion | undefined,
      after: DocumentVersion | undefined,
    ) => {
      if (id) objectIds.add(id);
      const change = {
        ...(id ? { objectId: id } : {}),
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      };
      if (!id) changes.push(change);
      else byId.set(id, [...(byId.get(id) ?? []), change]);
    };
    if (a && b && a !== b) {
      add(a, before, undefined);
      add(b, undefined, after);
    } else add(b ?? a, before, after);
  }
  for (const [objectId, entries] of byId) {
    const before = entries.flatMap((change) => (change.before ? [change.before] : []));
    const after = entries.flatMap((change) => (change.after ? [change.after] : []));
    // Coalesce a unique identity's move, never competing documents on either side.
    if (before.length <= 1 && after.length <= 1)
      changes.push({
        objectId,
        ...(before[0] ? { before: before[0] } : {}),
        ...(after[0] ? { after: after[0] } : {}),
      });
    else changes.push(...entries);
  }
  return {
    commit: event.id,
    time: event.time,
    ...(event.parent ? { parent: event.parent } : {}),
    operation: (JSON.parse(event.metadata) as CaptureMetadata).operation,
    objectIds: [...objectIds].sort(),
    changes,
  };
}
/** Content-addressed bytes, immutable event versions, current membership; caller owns mutation.lock. */
export class SqliteDocumentHistory implements DocumentHistory {
  private closed = false;
  private database?: DatabaseSync;
  private opening?: Promise<DatabaseSync>;
  private observer = new AsyncLocalStorage<Observer>();
  constructor(
    readonly systemRoot: string,
    private readonly checkpoint?: (point: SqliteCheckpoint) => Promise<void>,
  ) {}

  private async db(create = false): Promise<DatabaseSync> {
    if (this.closed) throw new Error("Tent history connection is closed");
    if (this.database) return this.database;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const available = await this.available();
      if (!create && !available)
        throw new Error("This Workspace has no Tent history: .tent/.git/history.sqlite is missing");
      await durableMkdir(path.join(this.systemRoot, ".git"));
      const db = new DatabaseSync(path.join(this.systemRoot, ".git", "history.sqlite"));
      try {
        // Even the first format read can race another connection's exclusive commit.
        db.exec("PRAGMA busy_timeout=8000");
        const version = db.prepare("PRAGMA user_version").get()?.user_version;
        if (version !== 2 && !(create && version === 0))
          throw new Error(`Unsupported Tent SQLite history format: ${version}`);
        db.exec("PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON");
        if (create)
          db.exec(`PRAGMA journal_mode=DELETE;
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, parent TEXT, time TEXT NOT NULL, metadata TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS blobs(digest TEXT PRIMARY KEY, raw TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS changes(event INTEGER NOT NULL REFERENCES events(seq), path TEXT NOT NULL, before_digest TEXT REFERENCES blobs(digest), after_digest TEXT REFERENCES blobs(digest), PRIMARY KEY(event,path)) STRICT;
          CREATE INDEX IF NOT EXISTS changes_path ON changes(path,event);
          CREATE TABLE IF NOT EXISTS current(path TEXT PRIMARY KEY, digest TEXT NOT NULL REFERENCES blobs(digest), event INTEGER NOT NULL REFERENCES events(seq)) STRICT;`);
        if (create) db.exec("PRAGMA user_version=2");
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
    const row = (await this.all("SELECT * FROM events WHERE id=?", id))[0];
    if (!row) throw new Error(`Unknown SQLite event: ${id}`);
    return row as unknown as Event;
  }
  /** Damaged bytes fail here, whichever read asked for them. */
  private async raws(digests: readonly string[]) {
    const read = (await this.db()).prepare("SELECT raw FROM blobs WHERE digest=?");
    const result = new Map<string, string>();
    for (const digest of digests) {
      if (result.has(digest)) continue;
      const raw = read.get(digest)?.raw;
      if (typeof raw !== "string" || sqliteContentFingerprint(raw) !== digest)
        throw new Error(`Damaged SQLite content: ${digest}`);
      result.set(digest, raw);
    }
    return result;
  }
  async available() {
    if (this.closed) throw new Error("Tent history connection is closed");
    if (this.database) return true;
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
    if (!changed.length) {
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
      const seq = Number(
        db
          .prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)")
          .run(id, before, new Date().toISOString(), JSON.stringify(metadata)).lastInsertRowid,
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
    return (await this.readVersions([version]))[0]!;
  }
  async readVersions(versions: readonly DocumentVersion[]) {
    const digestAt = (await this.db()).prepare(
      "SELECT after_digest AS digest FROM changes WHERE path=? AND event<=(SELECT seq FROM events WHERE id=?) ORDER BY event DESC LIMIT 1",
    );
    const digests = versions.map((version) => {
      const digest = digestAt.get(version.path, version.commit)?.digest;
      if (!digest) throw new Error(`Document absent at SQLite event: ${version.path}`);
      return String(digest);
    });
    const raws = await this.raws(digests);
    return digests.map((digest) => raws.get(digest)!);
  }
  async readDirectory(commit: string, directory?: string) {
    const seq = (await this.event(commit)).seq;
    const rows = (
      await this.all(
        "SELECT c.path,c.after_digest AS digest FROM changes c WHERE c.event=(SELECT MAX(x.event) FROM changes x WHERE x.path=c.path AND x.event<=?) AND c.after_digest IS NOT NULL",
        seq,
      )
    ).filter((row) => directory === undefined || String(row.path).startsWith(`${directory}/`));
    const raws = await this.raws(rows.map((row) => String(row.digest)));
    return new Map(rows.map((row) => [String(row.path), raws.get(String(row.digest))!]));
  }
  async documentBlobs() {
    return new Map(
      (await this.all("SELECT path,digest FROM current")).map((r) => [
        String(r.path),
        String(r.digest),
      ]),
    );
  }
  async retainedPaths() {
    return (await this.all("SELECT path FROM current ORDER BY path")).map((r) => String(r.path));
  }
  async changedRetainedDocuments(documents: readonly { path: string; raw: string }[]) {
    const blobs = await this.documentBlobs(),
      result = [];
    for (const d of documents) {
      const digest = blobs.get(d.path);
      if (digest && digest !== sqliteContentFingerprint(d.raw))
        result.push({ ...d, previousRaw: (await this.raws([digest])).get(digest)! });
    }
    return result;
  }
  async pathVersions(file: string) {
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
          file,
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
        file,
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

  private async commits(events: readonly Event[]) {
    const read = (await this.db()).prepare("SELECT * FROM changes WHERE event=? ORDER BY path");
    const rows = events.map((event) => read.all(event.seq) as Row[]);
    const raws = await this.raws(
      rows
        .flat()
        .flatMap((row) => [row.before_digest, row.after_digest])
        .filter((digest) => digest !== null)
        .map(String),
    );
    return events.map((event, index) => commitOf(event, rows[index]!, raws));
  }
  async changesInRange(range: { from?: string; to?: string } = {}): Promise<HistoryCommit[]> {
    const from = range.from ? (await this.event(range.from)).seq : 0,
      to = range.to ? (await this.event(range.to)).seq : Number.MAX_SAFE_INTEGER;
    return this.commits(
      (await this.all(
        "SELECT * FROM events WHERE seq>? AND seq<=? ORDER BY seq",
        from,
        to,
      )) as unknown as Event[],
    );
  }
  async nodeVersionPage(nodeId: string, start: number, limit: number) {
    // Every version carries the id in its own bytes, wherever the file was then.
    // SQLite narrows by text and the frontmatter decides: other documents can mention the id.
    const digests = JSON.stringify(
      (await this.all("SELECT digest,raw FROM blobs WHERE instr(raw,?)", nodeId))
        .filter((row) => objectId(String(row.raw)) === nodeId)
        .map((row) => String(row.digest)),
    );
    const events = (await this.all(
      `SELECT * FROM events WHERE seq IN (SELECT event FROM changes
        WHERE before_digest IN (SELECT value FROM json_each(?)) OR after_digest IN (SELECT value FROM json_each(?)))
      ORDER BY seq`,
      digests,
      digests,
    )) as unknown as Event[];
    return {
      total: events.length,
      items: (await this.commits(events.slice(start, start + limit))).map((commit) => ({
        ...commit,
        changes: commit.changes.filter((change) => change.objectId === nodeId),
      })),
    };
  }
}
