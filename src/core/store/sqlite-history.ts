import { DatabaseSync, type SQLInputValue } from "../../fs/sqlite-runtime.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as fs from "node:fs/promises";
import { scopedRead, forgetScopedRead } from "../../fs/file-state-cache.js";
import { durableMkdir, syncDirectory } from "../../fs/durable-file.js";
import {
  SqliteHistoryIndex,
  HistoryIndexDamage,
  indexValue,
  readIndexValue,
} from "./sqlite-history-index.js";
import { canonicalSha256 } from "../base/canonical-digest.js";
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
const readBatchSize = 256;
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
  private availability?: Promise<boolean>;
  private readonly availabilityScope = `sqlite-history-availability:${path.resolve(this.systemRoot)}`;
  private readonly index = new SqliteHistoryIndex(this.systemRoot);
  private indexing?: Promise<DatabaseSync>;
  private repairing?: Promise<void>;
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
      const available = await this.available();
      if (!create && !available)
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
        if (create) {
          forgetScopedRead(this.availabilityScope);
          this.availability = Promise.resolve(true);
        }
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
    if (this.indexing) await this.indexing.catch(() => undefined);
    if (this.repairing) await this.repairing.catch(() => undefined);
    this.index.close();
    this.database?.close();
    this.database = undefined;
    this.closed = true;
    forgetScopedRead(this.availabilityScope);
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
    return this.checkedRaw(digest, row);
  }
  private checkedRaw(digest: string, row: Row | Error | undefined): string {
    if (row instanceof Error) throw row;
    if (!row || sqliteContentFingerprint(String(row.raw)) !== digest)
      throw new Error(`Damaged SQLite content: ${digest}`);
    return String(row.raw);
  }
  private async rawRows(digests: readonly string[]) {
    const wanted = [...new Set(digests)];
    const result = new Map<string, Row | Error>();
    const db = await this.db();
    for (let start = 0; start < wanted.length; start += readBatchSize) {
      const batch = wanted.slice(start, start + readBatchSize);
      try {
        const rows = db
          .prepare(
            `SELECT digest,raw FROM blobs WHERE digest IN (${batch.map(() => "?").join(",")})`,
          )
          .all(...batch) as Row[];
        for (const row of rows) result.set(String(row.digest), row);
      } catch {
        // A failed bulk query must not make one unreadable blob hide other
        // requests, or supersede an earlier bad blob in directory order.
        for (const digest of batch) {
          try {
            result.set(digest, { raw: await this.raw(digest) });
          } catch (error) {
            result.set(digest, error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    }
    return result;
  }
  async available() {
    if (this.closed) throw new Error("Tent history connection is closed");
    if (this.availability) return this.availability;
    const pending = scopedRead(this.availabilityScope, async () => {
      const present = await fs.access(path.join(this.systemRoot, ".git/history.sqlite")).then(
        () => true,
        () => false,
      );
      if (present) return true;
      if (await this.hasLegacyHistory())
        throw new Error(
          "This Workspace has legacy Git history; migrate an offline copy before opening it with SQLite",
        );
      return false;
    });
    this.availability = pending;
    try {
      const present = await pending;
      // Another process may initialize an unopened workspace. A negative result
      // belongs to this read request only, while an existing history is stable.
      if (!present && this.availability === pending) this.availability = undefined;
      return present;
    } catch (error) {
      if (this.availability === pending) this.availability = undefined;
      throw error;
    }
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
    const db = await this.db();
    const head = db.prepare("SELECT MAX(seq) AS seq FROM events").get()?.seq ?? 0;
    const key = (version: DocumentVersion) => JSON.stringify([version.commit, version.path]);
    const wanted = [...new Map(versions.map((version) => [key(version), version])).values()];
    const selections = new Map<string, Row>();
    const fallback = new Set<string>();
    for (let start = 0; start < wanted.length; start += readBatchSize) {
      const batch = wanted.slice(start, start + readBatchSize);
      try {
        const rows = db
          .prepare(
            `WITH wanted(ordinal,commit_id,path) AS (VALUES ${batch.map(() => "(?,?,?)").join(",")})
          SELECT w.ordinal,e.seq,
            (SELECT c.after_digest FROM changes c WHERE c.path=w.path AND c.event<=e.seq ORDER BY c.event DESC LIMIT 1) AS digest,
            EXISTS(SELECT 1 FROM changes c WHERE c.path=w.path AND c.event>e.seq AND c.event<=?) AS changed
          FROM wanted w LEFT JOIN events e ON e.id=w.commit_id`,
          )
          .all(
            ...batch.flatMap((version, index) => [start + index, version.commit, version.path]),
            head,
          ) as Row[];
        for (const row of rows) selections.set(key(wanted[Number(row.ordinal)]!), row);
      } catch {
        // Preserve each request's original validation/error order if a bulk
        // metadata query cannot complete, including raw-before-changed checks.
        for (const version of batch) fallback.add(key(version));
      }
    }
    const select = (version: DocumentVersion) => {
      if (!/^[a-f0-9]{64}$/.test(version.commit))
        throw new Error(`Invalid SQLite event: ${version.commit}`);
      const row = selections.get(key(version));
      if (row?.seq == null) throw new Error(`Unknown SQLite event: ${version.commit}`);
      checkedPath(version.path);
      if (!row.digest) throw new Error(`Document absent at SQLite event: ${version.path}`);
      return { digest: String(row.digest), changedSince: !!row.changed };
    };
    const digests: string[] = [];
    for (const version of wanted) {
      if (fallback.has(key(version))) continue;
      try {
        digests.push(select(version).digest);
      } catch {
        /* Invalid selections keep their own result slot and fetch no blob. */
      }
    }
    const rows = await this.rawRows(digests);
    const content = new Map<string, string>();
    return Promise.all(
      versions.map(async (version) => {
        try {
          let raw: string, changedSince: boolean;
          if (fallback.has(key(version))) {
            const event = await this.event(version.commit);
            const digest = await this.digestAt(event.seq, version.path);
            if (!digest) throw new Error(`Document absent at SQLite event: ${version.path}`);
            raw = await this.raw(digest);
            changedSince = !!(
              await this.all(
                "SELECT event FROM changes WHERE path=? AND event>? AND event<=? LIMIT 1",
                version.path,
                event.seq,
                head,
              )
            ).length;
          } else {
            const selected = select(version);
            let observed = content.get(selected.digest);
            if (observed === undefined) {
              observed = this.checkedRaw(selected.digest, rows.get(selected.digest));
              content.set(selected.digest, observed);
            }
            raw = observed;
            changedSince = selected.changedSince;
          }
          return {
            version,
            raw,
            changedSince,
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
    const rows = (
      await this.all(
        "SELECT c.path,c.after_digest AS digest FROM changes c WHERE c.event=(SELECT MAX(x.event) FROM changes x WHERE x.path=c.path AND x.event<=?) AND c.after_digest IS NOT NULL",
        seq,
      )
    ).filter((row) =>
      directory === undefined
        ? isHistoryDocument(String(row.path))
        : String(row.path).startsWith(`${directory}/`),
    );
    const blobs = await this.rawRows(rows.map((row) => String(row.digest)));
    const content = new Map<string, string>();
    const result = new Map<string, string>();
    // Validate in selected-row order, never in the bulk blob query's order.
    for (const row of rows) {
      const digest = String(row.digest);
      let raw = content.get(digest);
      if (raw === undefined) {
        raw = this.checkedRaw(digest, blobs.get(digest));
        content.set(digest, raw);
      }
      result.set(String(row.path), raw);
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
    return this.projection(
      (index) =>
        Object.fromEntries(
          index
            .prepare("SELECT id,value FROM records")
            .all()
            .map((r) => [String(r.id), readIndexValue<NodeBasisRecord | null>(r.value)]),
        ),
      "records",
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
  async identityVersions() {
    return this.projection((index) => this.index.identities(index));
  }

  private async projection<T>(
    read: (index: DatabaseSync) => T | Promise<T>,
    kind: "events" | "records" = "events",
  ): Promise<T> {
    try {
      return await read(await this.historyIndex(kind));
    } catch (error) {
      if (!(error instanceof HistoryIndexDamage)) throw error;
      if (!this.repairing) {
        this.repairing = this.index.rebuild().finally(() => {
          this.repairing = undefined;
        });
      }
      await this.repairing;
      return await read(await this.historyIndex(kind));
    }
  }

  private async historyIndex(kind: "events" | "records"): Promise<DatabaseSync> {
    if (this.repairing) await this.repairing;
    const previous = this.indexing;
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.updateIndex(kind);
    })();
    this.indexing = pending;
    try {
      return await pending;
    } finally {
      if (this.indexing === pending) this.indexing = undefined;
    }
  }

  private async updateIndex(kind: "events" | "records"): Promise<DatabaseSync> {
    const events = kind === "events";
    const source = await this.db(),
      index = await this.index.open();
    const stat = await fs.stat(path.join(this.systemRoot, ".git/history.sqlite"), { bigint: true });
    const stamp = [stat.size, stat.mtimeNs, stat.ctimeNs, stat.dev, stat.ino].join(":");
    const head = source.prepare("SELECT seq,id FROM events ORDER BY seq DESC LIMIT 1").get();
    const to = Number(head?.seq ?? 0);
    index.exec("BEGIN IMMEDIATE");
    try {
      const state = Object.fromEntries(
        index
          .prepare("SELECT key,value FROM state")
          .all()
          .map((r) => [String(r.key), readIndexValue<string>(r.value)]),
      );
      let from = Number(state.seq ?? 0);
      if (!Number.isSafeInteger(from) || from < 0)
        throw new HistoryIndexDamage("Invalid history projection position");
      const anchor = from ? source.prepare("SELECT id FROM events WHERE seq=?").get(from)?.id : "";
      if (
        state.version !== "1" ||
        from > to ||
        anchor !== (state.head ?? "") ||
        (from === to && state.stamp !== stamp)
      ) {
        this.index.reset(index);
        from = 0;
      }
      const cursor = events ? "identitySeq" : "recordsSeq";
      const processed = from === 0 ? 0 : Number(state[cursor] ?? 0);
      if (!Number.isSafeInteger(processed) || processed < 0 || processed > from)
        throw new HistoryIndexDamage("Invalid history projection position");
      if (processed < to && events) {
        const affected = new Set<string>();
        const batch = this.index.batch(index);
        const knownIdentity = index.prepare("SELECT id FROM identities WHERE digest=?");
        const putIdentity = index.prepare("INSERT INTO identities VALUES(?,?)");
        const readBlob = source.prepare("SELECT raw FROM blobs WHERE digest=?");
        const readChanges = source.prepare("SELECT * FROM changes WHERE event=? ORDER BY path");
        const identity = (digest: string | null): string | undefined => {
          if (digest === null) return undefined;
          const known = knownIdentity.get(digest);
          if (known) return readIndexValue<string | null>(known.id) ?? undefined;
          const raw = readBlob.get(digest)?.raw;
          if (typeof raw !== "string" || sqliteContentFingerprint(raw) !== digest)
            throw new Error(`Damaged SQLite content: ${digest}`);
          const id = objectId(raw);
          putIdentity.run(digest, indexValue(id ?? null));
          return id;
        };
        for (const row of source
          .prepare("SELECT * FROM events WHERE seq>? AND seq<=? ORDER BY seq")
          .all(processed, to)) {
          const event = this.projectEvent(
            row as unknown as Event,
            readChanges.all(row.seq) as Row[],
            identity,
          );
          batch.add(Number(row.seq), event, affected);
        }
        batch.finish(affected);
      }
      if (processed < to && !events) {
        const latest = new Map<string, string>();
        const putRecord = index.prepare("INSERT OR REPLACE INTO records VALUES(?,?)");
        for (const row of source
          .prepare("SELECT id,value FROM records WHERE event>? AND event<=? ORDER BY event,rowid")
          .all(processed, to)) {
          latest.delete(String(row.id));
          latest.set(String(row.id), String(row.value));
        }
        for (const [id, raw] of latest) {
          const value = JSON.parse(raw);
          const clean =
            value === null || hasLocalMachinePath(value)
              ? null
              : nodeBasisRecordSchema.parse(value);
          putRecord.run(id, indexValue(clean));
        }
      }
      const putState = index.prepare("INSERT OR REPLACE INTO state VALUES(?,?)");
      for (const [key, value] of Object.entries({
        version: "1",
        seq: String(to),
        head: String(head?.id ?? ""),
        stamp,
        [cursor]: String(to),
      }))
        putState.run(key, indexValue(value));
      index.exec("COMMIT");
      return index;
    } catch (error) {
      try {
        if (index.isTransaction) index.exec("ROLLBACK");
      } catch {
        /* Preserve the original authority/cache failure. */
      }
      throw error;
    }
  }

  private projectEvent(
    event: Event,
    rows: readonly Row[],
    identity: (digest: string | null) => string | undefined,
  ): HistoryCommit {
    const metadata = JSON.parse(event.metadata) as CaptureMetadata,
      changes: HistoryChange[] = [],
      byId = new Map<string, HistoryChange>(),
      objectIds = new Set(metadata.objectIds ?? []);
    for (const c of rows) {
      const file = String(c.path),
        before = c.before_digest === null ? undefined : { commit: event.parent!, path: file },
        after = c.after_digest === null ? undefined : { commit: event.id, path: file },
        oldId = identity(c.before_digest as string | null),
        nextId = identity(c.after_digest as string | null),
        a = isHistoryDocument(file) ? oldId : undefined,
        b = isHistoryDocument(file) ? nextId : undefined;
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
    return {
      commit: event.id,
      time: event.time,
      ...(event.parent ? { parent: event.parent } : {}),
      operation: metadata.operation,
      objectIds: [...objectIds].sort(),
      entry: metadata.entry,
      changes,
    };
  }
  private async checkedHistory(items: HistoryCommit[]): Promise<HistoryCommit[]> {
    const versions = new Map<string, DocumentVersion>();
    for (const event of items)
      for (const change of event.changes)
        for (const version of [change.before, change.after])
          if (version) versions.set(`${version.commit}:${version.path}`, version);
    const checked = new Set<string>();
    for (const version of versions.values()) {
      const digest = await this.digestAt((await this.event(version.commit)).seq, version.path);
      if (!digest) throw new Error(`Document absent at SQLite event: ${version.path}`);
      if (!checked.has(digest)) {
        // Cached identities never replace validation of the selected authority
        // bytes. This checks only returned events and never reparses their YAML.
        await this.raw(digest);
        checked.add(digest);
      }
    }
    return items;
  }
  async changesInRange(range: { from?: string; to?: string } = {}): Promise<HistoryCommit[]> {
    const from = range.from ? (await this.event(range.from)).seq : 0,
      to = range.to ? (await this.event(range.to)).seq : Number.MAX_SAFE_INTEGER;
    if (from > to) throw new Error("Invalid SQLite history range");
    return this.projection((index) =>
      this.checkedHistory(
        index
          .prepare("SELECT value FROM events WHERE seq>? AND seq<=? ORDER BY seq")
          .all(from, to)
          .map((row) => readIndexValue<HistoryCommit>(row.value)),
      ),
    );
  }
  async nodeVersions(nodeId: string) {
    if (!isNodeId(nodeId)) throw new Error("Invalid Node id");
    return this.projection((index) =>
      this.checkedHistory(
        index
          .prepare("SELECT value FROM node_events WHERE id=? ORDER BY seq")
          .all(nodeId)
          .map((row) => readIndexValue<HistoryCommit>(row.value)),
      ),
    );
  }
  async nodeVersionPage(nodeId: string, start: number, limit: number) {
    if (!isNodeId(nodeId)) throw new Error("Invalid Node id");
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid history page");
    return this.projection(async (index) => {
      const row = index.prepare("SELECT value FROM nodes WHERE id=?").get(nodeId);
      const summary = row
        ? readIndexValue<{ revision: string; total: number }>(row.value)
        : undefined;
      return {
        revision: String(summary?.revision ?? canonicalSha256([])),
        total: Number(summary?.total ?? 0),
        items: await this.checkedHistory(
          index
            .prepare("SELECT value FROM node_events WHERE id=? ORDER BY seq LIMIT ? OFFSET ?")
            .all(nodeId, limit, start)
            .map((row) => readIndexValue<HistoryCommit>(row.value)),
        ),
      };
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
