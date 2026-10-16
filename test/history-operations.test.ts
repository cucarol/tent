import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { initializeFixtureWorkspace } from "./scratch.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode, deleteNode, renameNode } from "../src/core/graph/ops.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { listHistoryChanges } from "../src/core/read/history-query.js";
import { testScratchRoot } from "./scratch.js";

test("public saves and observed edits retain distinct history operations across locations", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "history-operations-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await initializeFixtureWorkspace(workspace);
  const adapter = new NodeFs(path.join(workspace, ".tent"), "cli");
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
  const first = (await adapter.history.nodeVersions(id))[0]!;
  assert.equal(first.operation, "node.create");
  assert.equal(first.entry, "cli");

  const original = await adapter.readFile("Alpha/Alpha.md");
  await fs.writeFile(
    path.join(workspace, ".tent/Alpha/Alpha.md"),
    original.replace("Initial", "Editor input"),
  );
  await readNodeForEdit(adapter, id);
  assert.equal((await adapter.history.nodeVersions(id)).length, 1);
  const basis = await readNodeForEdit(adapter, id, { capture: true });
  await writeNodeDocument(adapter, id, { baseEtag: basis.etag, body: "Saved fact" });
  await renameNode(env, id, "Beta");
  await deleteNode(env, id);
  const rows = await adapter.history.nodeVersions(id);
  assert.deepEqual(
    rows.map((row) => row.operation),
    ["node.create", "document.external-capture", "node.write", "node.rename", "node.delete"],
  );
  assert.ok(rows.every((row) => row.entry === "cli" && row.objectIds.includes(id)));
  assert.equal(rows.at(-1)!.changes[0]!.before!.path, "Beta/Beta.md");
  assert.equal(rows.at(-1)!.changes[0]!.after, undefined);

  const changes = await listHistoryChanges(adapter, { from: first.commit });
  assert.deepEqual(
    changes.map((change) => change.operation),
    ["document.external-capture", "node.write", "node.rename", "node.delete"],
  );
});
