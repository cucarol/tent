import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { createNode, renameNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { loadTent, reloadLoadedNode } from "../src/core/tree.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("Node names follow filenames; writes synchronize existing titles and retain metadata", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-title-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new NodeFs(root);
  await scaffoldTent(adapter, { name: "Title" });
  const env = { fs: adapter, tentName: "Title", clock: { now: () => "2026-09-27" } };
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
  assert.equal((await reloadLoadedNode(adapter, tent, "Scoped")).name, "Scoped");
  assert.equal(await adapter.readFile("Scoped/Scoped.md"), original);
  let edit = await readNodeForEdit(adapter, id);
  await writeNodeDocument(adapter, id, { baseEtag: edit.etag, body: "fact" });
  const current = parseFrontmatter(await adapter.readFile("Scoped/Scoped.md"));
  assert.equal(current.data.title, "Scoped");
  assert.deepEqual(current.data.custom, { nested: [1, "keep"] });
  const write = adapter.writeFile.bind(adapter);
  let writes = 0;
  adapter.writeFile = async (file, raw) => {
    writes++;
    await write(file, raw);
  };
  edit = await readNodeForEdit(adapter, id);
  await writeNodeDocument(adapter, id, { baseEtag: edit.etag, body: "fact" });
  assert.equal(writes, 0);
  adapter.writeFile = write;
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
