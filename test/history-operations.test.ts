import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode, deleteNode, renameNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { listNodeVersions } from "../src/core/history-query.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { testScratchRoot } from "./scratch.js";

test("public saves and observed edits retain distinct history operations across locations", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "history-operations-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await initializeTentWorkspace(workspace);
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
  const first = (await listNodeVersions(adapter, id))[0]!;
  assert.equal(first.operation, "node.create");
  assert.equal(first.entry, "cli");

  const original = await adapter.readFile("Alpha/Alpha.md");
  await fs.writeFile(
    path.join(workspace, ".tent/Alpha/Alpha.md"),
    original.replace("Initial", "Editor input"),
  );
  await readNodeForEdit(adapter, id);
  assert.equal((await listNodeVersions(adapter, id)).length, 1);
  const basis = await readNodeForEdit(adapter, id, { capture: true });
  await writeNodeDocument(adapter, id, { baseEtag: basis.etag, body: "Saved fact" });
  await renameNode(env, id, "Beta");
  await deleteNode(env, id);
  const rows = await listNodeVersions(adapter, id);
  assert.deepEqual(
    rows.map((row) => row.operation),
    ["node.create", "document.external-capture", "node.write", "node.rename", "node.delete"],
  );
  assert.ok(rows.every((row) => row.entry === "cli" && row.objectIds.includes(id)));
  assert.equal(rows.at(-1)!.changes[0]!.before!.path, "Beta/Beta.md");
  assert.equal(rows.at(-1)!.changes[0]!.after, undefined);

  const result = await runWorkspaceCommand("changes", ["--from", first.commit, "--limit", "1"], {
    workspace,
    json: true,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.items[0].operation, "document.external-capture");
  assert.equal(page.page.hasMore, true);
  const next = await runWorkspaceCommand(
    "changes",
    ["--from", first.commit, "--limit", "1", "--cursor", page.page.nextCursor],
    { workspace, json: true },
  );
  assert.equal(next.exitCode, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).items[0].operation, "node.write");
});
