import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { createNode, renameNode } from "../src/core/graph/ops.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { loadTent } from "../src/core/store/tree.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";

test("Node names follow filenames; renames synchronize existing titles and retain metadata", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-title-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const adapter = openTestFs(root);
  await scaffoldTent(adapter, { name: "Title" });
  const env = { fs: adapter, tentName: "Title", clock: { now: () => "2026-10-04T00:00:00.000Z" } };
  const id = await createNode(env, {
    name: "Scoped",
    parentPath: "",
    type: "prompt",
    body: "fact",
  });
  const original = (await adapter.readFile("Scoped/Scoped.md")).replace(
    "---\nfact",
    "title: Stale\ncustom: {nested: [1, keep]}\n---\nfact",
  );
  await adapter.writeFile("Scoped/Scoped.md", original);
  const tent = await loadTent(adapter);
  assert.equal(tent.byId.get(id)?.name, "Scoped");
  assert.equal((await loadTent(adapter)).byPath.get("Scoped")!.name, "Scoped");
  assert.equal(await adapter.readFile("Scoped/Scoped.md"), original);
  const child = await createNode(env, { name: "Child", parentPath: "Scoped", type: "prompt" });
  const childRaw = (await adapter.readFile("Scoped/Child/Child.md")).replace(
    "type: prompt",
    "type: prompt\ntitle: Old child title",
  );
  await adapter.writeFile("Scoped/Child/Child.md", childRaw);
  await renameNode(env, id, "Renamed");
  const renamed = parseFrontmatter(await adapter.readFile("Renamed/Renamed.md"));
  assert.equal(renamed.data.id, id);
  assert.equal(renamed.data.title, "Renamed");
  assert.deepEqual(renamed.data.custom, { nested: [1, "keep"] });
  const movedChild = parseFrontmatter(await adapter.readFile("Renamed/Child/Child.md"));
  assert.equal(movedChild.data.id, child);
  assert.equal(movedChild.data.title, "Child");
  const plain = await createNode(env, { name: "Plain", parentPath: "", type: "prompt" });
  await renameNode(env, plain, "StillPlain");
  assert.equal(
    parseFrontmatter(await adapter.readFile("StillPlain/StillPlain.md")).data.title,
    undefined,
  );
});
