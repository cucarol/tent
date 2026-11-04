import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { initializeFixtureWorkspace } from "./scratch.js";
import { createNode, deleteNode, renameNode } from "../src/core/graph/ops.js";
import { testScratchRoot } from "./scratch.js";
import { editNode, readNodeFile } from "./node-edit.js";

test("observed edits, renames and deletes retain their history operations across locations", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "history-operations-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(workspace);
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const env = {
    fs: adapter,
    tentName: "history",
    tentRoot: path.join(workspace, ".tent"),
    clock: { now: () => new Date().toISOString() },
  };
  const id = await createNode(env, {
    parentPath: "",
    name: "Alpha",
    type: "prompt",
    body: "Initial",
  });
  const first = (await adapter.history.nodeVersionPage(id, 0, 100)).items[0]!;
  assert.equal(first.operation, "node.create");

  const original = await adapter.readFile("Alpha/Alpha.md");
  await fs.writeFile(
    path.join(workspace, ".tent/Alpha/Alpha.md"),
    original.replace("Initial", "Editor input"),
  );
  await readNodeFile(adapter, id);
  assert.equal((await adapter.history.nodeVersionPage(id, 0, 100)).total, 1);
  await readNodeFile(adapter, id, { capture: true });
  await editNode(adapter, id, { body: "Saved fact" });
  await renameNode(env, id, "Beta");
  await deleteNode(env, id);
  const rows = (await adapter.history.nodeVersionPage(id, 0, 100)).items;
  assert.deepEqual(
    rows.map((row) => row.operation),
    ["node.create", "node.native-save", "node.native-save", "node.rename", "node.delete"],
  );
  assert.ok(rows.every((row) => row.objectIds.includes(id)));
  assert.equal(rows.at(-1)!.changes[0]!.before!.path, "Beta/Beta.md");
  assert.equal(rows.at(-1)!.changes[0]!.after, undefined);

  const changes = await adapter.history.changesInRange({ from: first.commit });
  assert.deepEqual(
    changes.map((change) => change.operation),
    ["node.native-save", "node.native-save", "node.rename", "node.delete"],
  );
});
