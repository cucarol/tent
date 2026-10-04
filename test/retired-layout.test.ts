import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { testScratchRoot } from "./scratch.js";

test("retired names are ordinary Nodes and grouping folders stay transparent", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "retired-names-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new NodeFs(root);
  await scaffoldTent(adapter, { name: "names" });
  const env = { fs: adapter, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "names" };
  for (const name of [
    "notes",
    "returns",
    "snapshots",
    "migrations",
    "roles.json",
    "log.md",
    "MIGRATED.md",
  ]) {
    const id = await createNode(env, { parentPath: "", name, type: "prompt" });
    assert.equal((await loadTent(adapter)).byId.get(id)?.path, name);
  }
  await adapter.writeFile(
    "notes/group/Child/Child.md",
    "---\nid: node-child\ntype: output\n---\nbody",
  );
  const child = (await loadTent(adapter)).byId.get("node-child")!;
  assert.equal(child.parent?.name, "notes");
  assert.equal(child.path, "notes/group/Child");
});

test("old snapshot stores produce one diagnostic before scanning copies as live Nodes", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "retired-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new NodeFs(root);
  await scaffoldTent(adapter, { name: "legacy" });
  const raw = "---\nid: node-alpha\ntype: prompt\n---\nkept";
  await adapter.writeFile("Alpha/Alpha.md", raw);
  await adapter.writeFile("snapshots/objects/old/Alpha/Alpha.md", raw);
  await assert.rejects(loadTent(adapter), /Retired Tent storage found: snapshots/);
  assert.equal(await adapter.readFile("snapshots/objects/old/Alpha/Alpha.md"), raw);
});
