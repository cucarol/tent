import { DatabaseSync } from "../../fs/sqlite-runtime.js";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalSha256 } from "../base/canonical-digest.js";
import type { HistoryCommit, DocumentVersion } from "./history-port.js";

export class HistoryIndexDamage extends Error {}
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
export function indexValue(value: unknown): string {
  const json = JSON.stringify(value);
  return checksum(json) + json;
}
export function readIndexValue<T>(value: unknown): T {
  if (typeof value !== "string" || value.slice(0, 64) !== checksum(value.slice(64)))
    throw new HistoryIndexDamage("Damaged history projection");
  try {
    return JSON.parse(value.slice(64)) as T;
  } catch {
    throw new HistoryIndexDamage("Invalid history projection");
  }
}

// Tag only failures from the disposable database. Authority errors retain their
// original type/message and never enter the cache-rebuild fallback.
function disposable(db: DatabaseSync): DatabaseSync {
  const guarded = (target: object) =>
    new Proxy(target, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          try {
            const result: unknown = value.apply(target, args);
            return key === "prepare" ? guarded(result as object) : result;
          } catch (error) {
            throw new HistoryIndexDamage(String(error));
          }
        };
      },
    });
  return guarded(db) as DatabaseSync;
}

/** Disposable, incremental projections. Never an authority for document bytes. */
export class SqliteHistoryIndex {
  private database?: DatabaseSync;
  constructor(private readonly systemRoot: string) {}

  async open(): Promise<DatabaseSync> {
    if (this.database) return this.database;
    const directory = path.join(this.systemRoot, ".git/tent-material-cache");
    const file = path.join(directory, "history-index.sqlite");
    let db: DatabaseSync | undefined;
    try {
      await fs.mkdir(directory, { recursive: true });
      db = new DatabaseSync(file);
      this.database = this.initialize(db);
    } catch {
      const replace = db !== undefined;
      db?.close();
      db = undefined;
      // Only this disposable file may be replaced. On Windows another reader
      // can still hold it open; an in-memory rebuild preserves the read result.
      if (replace) {
        try {
          await fs.rm(file, { force: true });
          db = new DatabaseSync(file);
          this.database = this.initialize(db);
        } catch {
          db?.close();
        }
      }
      this.database ??= this.initialize(new DatabaseSync(":memory:"));
    }
    return this.database;
  }

  private initialize(db: DatabaseSync) {
    db.exec("PRAGMA busy_timeout=8000; BEGIN IMMEDIATE");
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      if (tables.length) {
        const expected = [
          "events",
          "identities",
          "node_events",
          "nodes",
          "records",
          "state",
          "versions",
        ];
        if (
          JSON.stringify(tables) !== JSON.stringify(expected) ||
          db.prepare("PRAGMA user_version").get()?.user_version !== 1
        )
          throw new HistoryIndexDamage("Incompatible history projection");
        db.exec("COMMIT");
        return disposable(db);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS identities(digest TEXT PRIMARY KEY, id TEXT);
        CREATE TABLE IF NOT EXISTS node_events(id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,seq));
        CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, first TEXT NOT NULL, latest TEXT);
        CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;`);
      return disposable(db);
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  async rebuild() {
    this.close();
    const file = path.join(this.systemRoot, ".git/tent-material-cache/history-index.sqlite");
    try {
      await fs.rm(file, { force: true });
    } catch {
      this.database = this.initialize(new DatabaseSync(":memory:"));
      return;
    }
    await this.open();
  }

  close() {
    this.database?.close();
    this.database = undefined;
  }

  reset(db: DatabaseSync) {
    db.exec(
      "DELETE FROM state; DELETE FROM events; DELETE FROM identities; DELETE FROM node_events; DELETE FROM nodes; DELETE FROM versions; DELETE FROM records;",
    );
  }

  /** Statements belong to this update batch, never to a later connection. */
  batch(db: DatabaseSync) {
    const putEvent = db.prepare("INSERT INTO events VALUES(?,?)");
    const putVersion = db.prepare(
      "INSERT INTO versions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET latest=excluded.latest",
    );
    const deleteVersion = db.prepare("UPDATE versions SET latest=NULL WHERE id=?");
    const putNodeEvent = db.prepare("INSERT INTO node_events VALUES(?,?,?)");
    const nodeEvents = db.prepare("SELECT value FROM node_events WHERE id=? ORDER BY seq");
    const putNode = db.prepare("INSERT OR REPLACE INTO nodes VALUES(?,?)");
    return {
      add: (seq: number, event: HistoryCommit, affected: Set<string>) => {
        putEvent.run(seq, indexValue(event));
        for (const change of event.changes) {
          const id = change.objectId;
          if (!id) continue;
          if (change.after) {
            const value = indexValue(change.after);
            putVersion.run(id, value, value);
          } else deleteVersion.run(id);
        }
        for (const id of new Set(event.changes.flatMap((c) => (c.objectId ? [c.objectId] : [])))) {
          putNodeEvent.run(
            id,
            seq,
            indexValue({ ...event, changes: event.changes.filter((c) => c.objectId === id) }),
          );
          affected.add(id);
        }
      },
      finish: (affected: Set<string>) => {
        for (const id of affected) {
          const events = nodeEvents.all(id).map((r) => readIndexValue<HistoryCommit>(r.value));
          // Keep the public cursor revision identical to canonicalSha256(full history).
          putNode.run(id, indexValue({ revision: canonicalSha256(events), total: events.length }));
        }
      },
    };
  }

  identities(db: DatabaseSync) {
    const first: Record<string, DocumentVersion> = {},
      latest: Record<string, DocumentVersion> = {};
    for (const row of db.prepare("SELECT * FROM versions").all()) {
      first[String(row.id)] = readIndexValue<DocumentVersion>(row.first);
      if (row.latest !== null) latest[String(row.id)] = readIndexValue<DocumentVersion>(row.latest);
    }
    return { first, latest };
  }
}
