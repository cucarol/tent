import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { createNode } from "../src/core/graph/ops.js";
import { readNodeTimes } from "../src/core/read/node-times.js";
import { sqliteContentFingerprint } from "../src/core/store/sqlite-history.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";

const { removeCanvasHistory } = await import(
  new URL("../scripts/one-off/remove-canvas-history.mjs", import.meta.url).href
);

async function files(
  root: string,
): Promise<Map<string, { raw: Buffer; mtime: bigint; ctime: bigint }>> {
  const result = new Map();
  for (const file of await fs.readdir(root, { recursive: true })) {
    const filename = path.join(root, file),
      info = await fs.stat(filename, { bigint: true });
    if (info.isFile())
      result.set(file, {
        raw: await fs.readFile(filename),
        mtime: info.mtimeNs,
        ctime: info.ctimeNs,
      });
  }
  return result;
}

test("one-off removal preserves Node times, shared blobs and event identities, then writes nothing", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "remove-canvas-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await initializeFixtureWorkspace(root);
  const system = path.join(root, ".tent"),
    setup = openTestFs(system);
  for (const name of ["Alpha", "Beta"])
    await createNode(
      { fs: setup, tentName: "Canvas conversion", clock: { now: () => new Date().toISOString() } },
      { id: `node-${name.toLowerCase()}`, name, type: "prompt", parentPath: "", body: name },
    );
  const expectedTimes = await readNodeTimes(setup, ["node-alpha", "node-beta"]);
  assert.ok(expectedTimes.every((row) => row.contentChangedAt));
  const alpha = await setup.readFile("Alpha/Alpha.md");
  await setup.close();
  const filename = path.join(system, ".git/history.sqlite"),
    db = new DatabaseSync(filename);
  const canvasOnly = '{"version":3,"open":[],"shut":[],"drawings":[]}\n';
  const oldDigest = sqliteContentFingerprint(canvasOnly),
    shared = sqliteContentFingerprint(alpha);
  const unrelated = sqliteContentFingerprint("unrelated retained blob");
  let originalEvents: unknown[], originalRecords: unknown[];
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    db.prepare("INSERT INTO blobs VALUES(?,?)").run(oldDigest, canvasOnly);
    db.prepare("INSERT INTO blobs VALUES(?,?)").run(unrelated, "unrelated retained blob");
    const first = db.prepare("SELECT seq FROM events ORDER BY seq LIMIT 1").get()!;
    db.prepare("INSERT INTO changes VALUES(?,?,?,?)").run(
      first.seq,
      "canvas.json",
      null,
      oldDigest,
    );
    const parent = db.prepare("SELECT id FROM events ORDER BY seq DESC LIMIT 1").get()!;
    const inserted = db
      .prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)")
      .run(
        randomBytes(32).toString("hex"),
        parent.id,
        "2026-10-30T00:00:00.000Z",
        JSON.stringify({ operation: "canvas.write", entry: "ui", objectIds: [] }),
      );
    db.prepare("INSERT INTO changes VALUES(?,?,?,?)").run(
      inserted.lastInsertRowid,
      "canvas.json",
      oldDigest,
      shared,
    );
    db.prepare("INSERT INTO current VALUES(?,?,?)").run(
      "canvas.json",
      shared,
      inserted.lastInsertRowid,
    );
    db.exec("COMMIT");
    originalEvents = db.prepare("SELECT * FROM events ORDER BY seq").all();
    originalRecords = db.prepare("SELECT * FROM records ORDER BY event,id").all();
  } finally {
    db.close();
  }
  await fs.writeFile(path.join(system, "canvas.json"), alpha);
  const before = openTestFs(system);
  await assert.rejects(before.history.changesInRange(), /Invalid history path: canvas.json/);
  await before.close();
  const index = path.join(system, ".git/tent-material-cache/history-index.sqlite");
  assert.ok((await fs.stat(index)).isFile());
  assert.deepEqual(await removeCanvasHistory(root), {
    changed: true,
    changes: 2,
    current: 1,
    blobs: 1,
    file: true,
  });
  await assert.rejects(fs.access(path.join(system, "canvas.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(index), { code: "ENOENT" });
  const audit = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(audit.prepare("SELECT * FROM events ORDER BY seq").all(), originalEvents);
    assert.deepEqual(
      audit.prepare("SELECT * FROM records ORDER BY event,id").all(),
      originalRecords,
    );
    assert.equal(
      audit.prepare("SELECT COUNT(*) AS n FROM blobs WHERE digest IN (?,?)").get(shared, unrelated)!
        .n,
      2,
    );
    assert.equal(
      audit.prepare("SELECT COUNT(*) AS n FROM changes WHERE path='canvas.json'").get()!.n,
      0,
    );
    assert.equal(
      audit.prepare("SELECT COUNT(*) AS n FROM current WHERE path='canvas.json'").get()!.n,
      0,
    );
    assert.deepEqual(audit.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    audit.close();
  }
  const after = openTestFs(system);
  assert.deepEqual(await readNodeTimes(after, ["node-alpha", "node-beta"]), expectedTimes);
  const events = await after.history.changesInRange();
  assert.equal(events.length, originalEvents.length);
  assert.deepEqual(events.at(-1)!.changes, []);
  await after.close();
  for (const sub of ["check", "brief"]) {
    const result = await runWorkspaceCommand(sub, ["--json"], { workspace: root });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
  const unchanged = await files(system);
  assert.deepEqual(await removeCanvasHistory(root), {
    changed: false,
    changes: 0,
    current: 0,
    blobs: 0,
    file: false,
  });
  assert.deepEqual(await files(system), unchanged);
});

test("one-off removal refuses an unsupported database without deleting the live file", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "remove-canvas-unsupported-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await initializeFixtureWorkspace(root);
  const system = path.join(root, ".tent"),
    filename = path.join(system, ".git/history.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA user_version=2");
  db.close();
  await fs.writeFile(path.join(system, "canvas.json"), "keep");
  const before = await files(system);
  await assert.rejects(removeCanvasHistory(root), /Unsupported Tent SQLite history format: 2/);
  assert.deepEqual(await files(system), before);
});

test("one-off removal refuses unsettled writes without changing their files or database", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "remove-canvas-pending-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await initializeFixtureWorkspace(root);
  const system = path.join(root, ".tent");
  await fs.writeFile(path.join(system, "canvas.json"), "keep");
  for (const pending of [
    "mutation.lock",
    "mutation.lock.guard",
    "node-move.pending.json",
    "delete.pending.json",
    ".git/tent-transaction.json",
  ]) {
    const filename = path.join(system, pending);
    await fs.writeFile(filename, "pending");
    const before = await files(system);
    await assert.rejects(
      removeCanvasHistory(root),
      /Stop Tent writers and settle pending operations/,
    );
    assert.deepEqual(await files(system), before);
    await fs.unlink(filename);
  }
});
