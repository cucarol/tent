#!/usr/bin/env node
// Run once after stopping all Tent writers:
//   node scripts/one-off/remove-canvas-history.mjs <workspaceRoot>
// Removes the retired canvas file and its SQLite history. Event identities,
// timestamps, metadata and parent links remain unchanged, including empty events.
import fs from "node:fs/promises";
import path from "node:path";
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

export async function removeCanvasHistory(workspaceRoot) {
  const systemRoot = path.join(path.resolve(workspaceRoot), ".tent");
  const filename = path.join(systemRoot, ".git/history.sqlite");
  const canvas = path.join(systemRoot, "canvas.json");
  for (const pending of [
    "mutation.lock",
    "mutation.lock.guard",
    "node-move.pending.json",
    "delete.pending.json",
    ".git/tent-transaction.json",
  ])
    if (await exists(path.join(systemRoot, pending)))
      throw new Error(`Stop Tent writers and settle pending operations first: ${pending}`);

  const inspect = new DatabaseSync(filename, { readOnly: true });
  let rows;
  try {
    const version = inspect.prepare("PRAGMA user_version").get().user_version;
    if (version !== 1) throw new Error(`Unsupported Tent SQLite history format: ${version}`);
    rows = Number(
      inspect
        .prepare(
          "SELECT (SELECT COUNT(*) FROM changes WHERE path='canvas.json') + (SELECT COUNT(*) FROM current WHERE path='canvas.json') AS count",
        )
        .get().count,
    );
  } finally {
    inspect.close();
  }
  const liveFile = await exists(canvas);
  if (!rows && !liveFile) return { changed: false, changes: 0, current: 0, blobs: 0, file: false };

  const result = { changed: true, changes: 0, current: 0, blobs: 0, file: liveFile };
  if (rows) {
    const db = new DatabaseSync(filename);
    try {
      db.exec("PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      const candidates = db
        .prepare(
          "SELECT before_digest AS digest FROM changes WHERE path='canvas.json' UNION SELECT after_digest FROM changes WHERE path='canvas.json' UNION SELECT digest FROM current WHERE path='canvas.json'",
        )
        .all()
        .map((row) => row.digest)
        .filter((digest) => digest !== null);
      result.current = Number(
        db.prepare("DELETE FROM current WHERE path='canvas.json'").run().changes,
      );
      result.changes = Number(
        db.prepare("DELETE FROM changes WHERE path='canvas.json'").run().changes,
      );
      const removeBlob = db.prepare(
        "DELETE FROM blobs WHERE digest=? AND NOT EXISTS(SELECT 1 FROM changes WHERE before_digest=? OR after_digest=?) AND NOT EXISTS(SELECT 1 FROM current WHERE digest=?)",
      );
      for (const digest of candidates)
        result.blobs += Number(removeBlob.run(digest, digest, digest, digest).changes);
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("SQLite history has invalid foreign keys");
      // This projection stores canvas changes even when the authoritative event
      // identities are unchanged. Invalidate it before committing the conversion.
      const index = path.join(systemRoot, ".git/tent-material-cache/history-index.sqlite");
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        await fs.rm(index + suffix, { force: true });
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
  if (liveFile) await fs.unlink(canvas);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/one-off/remove-canvas-history.mjs <workspaceRoot>");
    process.exitCode = 1;
  } else {
    removeCanvasHistory(process.argv[2])
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
