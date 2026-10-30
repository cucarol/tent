import assert from "node:assert/strict";
import test from "node:test";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { createNode } from "../src/core/graph/ops.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { confirmNodeSync, readOutputChanges } from "../src/core/graph/node-sync.js";

async function fixture() {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Comparisons" });
  const env = { fs, clock: { now: () => "2026-10-17T00:00:00.000Z" }, tentName: "Comparisons" };
  await fs.writeFile("../direction.txt", "first");
  await fs.writeFile("../result.txt", "first");
  const outer = await createNode(env, {
    parentPath: "",
    name: "Outer",
    type: "goal",
    resource: "../../direction.txt",
  });
  const inner = await createNode(env, { parentPath: "Outer", name: "Inner", type: "goal" });
  const rule = await createNode(env, { parentPath: "Outer/Inner", name: "Rule", type: "prompt" });
  const outputs: string[] = [];
  for (const name of ["One", "Two"])
    outputs.push(
      await createNode(env, {
        parentPath: "Outer/Inner/Rule",
        name,
        type: "output",
        resource: "../../../../../result.txt",
      }),
    );
  const confirm = async (id: string) =>
    confirmNodeSync(fs, id, { baseEtag: (await readNodeForEdit(fs, id)).etag });
  return { fs, outer, inner, rule, outputs, confirm };
}

test("output changes retain own materials and the nearest changed goal without acknowledgement", async () => {
  const { fs, outer, inner, outputs, confirm } = await fixture();
  assert.equal(await readOutputChanges(fs, outputs[0]!), undefined);
  await fs.writeFile("../direction.txt", "second");
  await fs.writeFile("../result.txt", "second");
  await writeNodeDocument(fs, inner, {
    baseEtag: (await readNodeForEdit(fs, inner)).etag,
    body: "Changed direction",
  });
  await confirm(outer);
  await confirm(outputs[1]!);
  const head = await fs.history.currentCommit(),
    before = new Map(fs.files);
  assert.deepEqual(await readOutputChanges(fs, outputs[0]!), [
    { kind: "material", resource: "../../../../../result.txt" },
    { kind: "goal", nodeId: inner, name: "Inner" },
  ]);
  assert.equal(await readOutputChanges(fs, outputs[1]!), undefined);
  assert.equal(await fs.history.currentCommit(), head);
  assert.deepEqual(fs.files, before);
});

for (const code of ["EACCES", "ENOENT"]) {
  test(`${code} in an ancestor body preserves a known nearest-goal change`, async () => {
    const { fs, inner, outputs } = await fixture();
    await writeNodeDocument(fs, inner, {
      baseEtag: (await readNodeForEdit(fs, inner)).etag,
      body: "A changed inner requirement",
    });
    const read = fs.readFile.bind(fs);
    fs.readFrontmatter = async (path) => {
      const raw = await read(path);
      return raw.slice(0, raw.length - parseFrontmatter(raw).body.length);
    };
    fs.readFile = async (path) => {
      if (path === "Outer/Outer.md")
        throw Object.assign(new Error(`${code}: ancestor body unavailable`), { code });
      return read(path);
    };
    const files = new Map(fs.files),
      head = await fs.history.currentCommit();
    assert.deepEqual(await readOutputChanges(fs, outputs[0]!), [
      { kind: "goal", nodeId: inner, name: "Inner" },
    ]);
    assert.deepEqual(fs.files, files);
    assert.equal(await fs.history.currentCommit(), head);
  });
}
