#!/usr/bin/env node
// Stop all Tent writers, test an offline copy, then run:
//   node scripts/one-off/remove-node-records-history.mjs <workspaceRoot>
// Publish only a verified copy. Node documents, verified provenance, event IDs,
// parent links, times, document blobs, changes and current membership are retained.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const emitWarning = process.emitWarning;
let DatabaseSync;
try {
  process.emitWarning = (warning, ...args) => {
    const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
    if (
      warning === "SQLite is an experimental feature and might change at any time" &&
      type === "ExperimentalWarning"
    )
      return;
    Reflect.apply(emitWarning, process, [warning, ...args]);
  };
  ({ DatabaseSync } = require("node:sqlite"));
} finally {
  process.emitWarning = emitWarning;
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
const quoted = (name) => `"${name.replaceAll('"', '""')}"`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const retiredTables = new Set(["records", "unportable_records"]);
const stripRecordTrailers = (message) =>
  message.replace(/^Tent-Node-Record: [^\r\n]*(?:\r?\n|$)/gm, "");

function metadataWithoutRecords(raw) {
  const metadata = JSON.parse(raw);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid SQLite event metadata");
  if (!Object.hasOwn(metadata, "nodeRecords")) return raw;
  delete metadata.nodeRecords;
  return JSON.stringify(metadata);
}

function tables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

/** Compare every retained table, including Git-import original Markdown audits. */
function retainedSnapshot(db, scrub) {
  return tables(db)
    .filter((table) => !retiredTables.has(table))
    .map((table) => {
      const columns = db
        .prepare(`PRAGMA table_info(${quoted(table)})`)
        .all()
        .map((row) => row.name);
      const hash = createHash("sha256");
      for (const row of db
        .prepare(`SELECT * FROM ${quoted(table)} ORDER BY ${columns.map(quoted).join(",")}`)
        .iterate()) {
        if (scrub && table === "events") row.metadata = metadataWithoutRecords(row.metadata);
        if (scrub && table === "migration_events") row.message = stripRecordTrailers(row.message);
        hash.update(JSON.stringify(row) + "\n");
      }
      return [table, hash.digest("hex")];
    });
}

function validate(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
    throw new Error("SQLite history integrity check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("SQLite history has invalid foreign keys");
}

function assertClean(db) {
  if (tables(db).some((table) => retiredTables.has(table)))
    throw new Error("SQLite history format 2 still contains retired Node record tables");
  for (const row of db.prepare("SELECT metadata FROM events").iterate())
    if (metadataWithoutRecords(row.metadata) !== row.metadata)
      throw new Error("SQLite history format 2 still contains Node record metadata");
  if (tables(db).includes("migration_events"))
    for (const row of db.prepare("SELECT message FROM migration_events").iterate())
      if (stripRecordTrailers(row.message) !== row.message)
        throw new Error("SQLite history format 2 still contains Node record trailers");
}

async function requireOffline(systemRoot, filename) {
  for (const pending of [
    "mutation.lock",
    "mutation.lock.guard",
    "node-move.pending.json",
    "delete.pending.json",
    ".git/tent-transaction.json",
  ])
    if (await exists(path.join(systemRoot, pending)))
      throw new Error(`Stop Tent writers and settle pending operations first: ${pending}`);
  for (const suffix of ["-journal", "-wal", "-shm"])
    if (await exists(filename + suffix))
      throw new Error(
        `Close SQLite connections and settle its journal first: history.sqlite${suffix}`,
      );
}

export async function removeNodeRecordsHistory(workspaceRoot) {
  const systemRoot = path.join(path.resolve(workspaceRoot), ".tent");
  const filename = path.join(systemRoot, ".git/history.sqlite");
  await requireOffline(systemRoot, filename);
  const source = new DatabaseSync(filename, { readOnly: true });
  let expected, original, temporary;
  try {
    source.exec("BEGIN");
    const version = source.prepare("PRAGMA user_version").get().user_version;
    if (version !== 1 && version !== 2)
      throw new Error(`Unsupported Tent SQLite history format: ${version}`);
    validate(source);
    if (version === 2) {
      assertClean(source);
      return { changed: false, metadata: 0, trailers: 0, records: 0, unportableRecords: 0 };
    }
    expected = retainedSnapshot(source, true);
    original = digest(await fs.readFile(filename));
    temporary = `${filename}.remove-node-records-${randomUUID()}`;
    try {
      await fs.copyFile(filename, temporary, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  } finally {
    source.close();
  }

  const result = { changed: true, metadata: 0, trailers: 0, records: 0, unportableRecords: 0 };
  try {
    const db = new DatabaseSync(temporary);
    try {
      db.exec(
        "PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE",
      );
      for (const row of db.prepare("SELECT seq,metadata FROM events").all()) {
        const clean = metadataWithoutRecords(row.metadata);
        if (clean !== row.metadata) {
          db.prepare("UPDATE events SET metadata=? WHERE seq=?").run(clean, row.seq);
          result.metadata++;
        }
      }
      if (tables(db).includes("migration_events"))
        for (const row of db.prepare("SELECT event,message FROM migration_events").all()) {
          const clean = stripRecordTrailers(row.message);
          if (clean !== row.message) {
            db.prepare("UPDATE migration_events SET message=? WHERE event=?").run(clean, row.event);
            result.trailers++;
          }
        }
      for (const [table, field] of [
        ["records", "records"],
        ["unportable_records", "unportableRecords"],
      ]) {
        result[field] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get().n);
        db.exec(`DROP TABLE ${quoted(table)}`);
      }
      db.exec("PRAGMA user_version=2");
      validate(db);
      assertClean(db);
      if (JSON.stringify(retainedSnapshot(db, false)) !== JSON.stringify(expected))
        throw new Error("Node record conversion changed retained document history");
      db.exec("COMMIT");
      // Rebuild the copied file so retired values cannot survive in free pages.
      db.exec("VACUUM");
      validate(db);
      if (JSON.stringify(retainedSnapshot(db, false)) !== JSON.stringify(expected))
        throw new Error("Node record conversion changed retained document history");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
    await requireOffline(systemRoot, filename);
    if (digest(await fs.readFile(filename)) !== original)
      throw new Error("Offline SQLite history changed during conversion");
    const handle = await fs.open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // This whole managed directory is disposable: old material fingerprints,
    // structure-derived data and prepared graph observations must leave with
    // the record projection. Hook section/turn baselines live separately in temp/.
    const cacheDirectory = path.resolve(systemRoot, ".git/tent-material-cache");
    await fs.rm(cacheDirectory, { recursive: true, force: true });
    await fs.rename(temporary, filename);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(filename), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return result;
  } finally {
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      await fs.rm(temporary + suffix, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/one-off/remove-node-records-history.mjs <workspaceRoot>");
    process.exitCode = 1;
  } else {
    removeNodeRecordsHistory(process.argv[2])
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
