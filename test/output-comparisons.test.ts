import assert from "node:assert/strict";
import test from "node:test";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { createNode } from "../src/core/graph/ops.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import {
  confirmNodeSync,
  readOutputChanges,
  readOutputComparisons,
} from "../src/core/graph/node-sync.js";

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

test("selected outputs compare every ancestor goal independently without acknowledging changes", async () => {
  const { fs, outer, inner, outputs, confirm } = await fixture();
  const initial = await readOutputComparisons(fs, outputs);
  assert.deepEqual(
    initial,
    outputs.map((nodeId) => ({
      nodeId,
      goals: [
        { goalId: inner, state: "current" },
        { goalId: outer, state: "current" },
      ],
      changedSince: [],
    })),
  );
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
  const compared = await readOutputComparisons(fs, [outputs[0]!, outputs[1]!, outputs[0]!]);
  assert.deepEqual(compared[0], {
    nodeId: outputs[0],
    goals: [
      { goalId: inner, state: "changed" },
      { goalId: outer, state: "changed" },
    ],
    changedSince: [
      { kind: "material", resource: "../../../../../result.txt" },
      { kind: "goal", nodeId: inner, name: "Inner" },
    ],
  });
  assert.deepEqual(compared[1], initial[1]);
  assert.equal(compared.length, 2);
  assert.deepEqual(compared[0]!.changedSince, await readOutputChanges(fs, outputs[0]!));
  assert.equal(await fs.history.currentCommit(), head);
  assert.deepEqual(fs.files, before);
});

test("missing baselines and unavailable materials are unknown, while a proven change remains changed", async () => {
  const { fs, outer, inner, outputs } = await fixture();
  await fs.remove("../direction.txt");
  let comparison = (await readOutputComparisons(fs, [outputs[0]!]))[0]!;
  assert.deepEqual(comparison.goals, [
    { goalId: inner, state: "current" },
    { goalId: outer, state: "unknown" },
  ]);
  assert.deepEqual(comparison.changedSince, []);
  await writeNodeDocument(fs, outer, {
    baseEtag: (await readNodeForEdit(fs, outer)).etag,
    body: "A known change with unreadable material",
  });
  comparison = (await readOutputComparisons(fs, [outputs[0]!]))[0]!;
  assert.equal(comparison.goals[1]!.state, "changed");
  assert.deepEqual(comparison.changedSince, []);
  await fs.writeFile(
    "Outer/Inner/Imported/Imported.md",
    "---\nid: node-imported\ntype: output\n---\nImported\n",
  );
  const imported = (await readOutputComparisons(fs, ["node-imported"]))[0]!;
  assert.deepEqual(imported.goals, [
    { goalId: inner, state: "unknown" },
    { goalId: outer, state: "unknown" },
  ]);
  assert.deepEqual(imported.changedSince, []);
});

test("metadata and expiry do not change goal comparisons, and batches do not inspect other outputs", async () => {
  const { fs, inner, outputs } = await fixture();
  await writeNodeDocument(fs, inner, {
    baseEtag: (await readNodeForEdit(fs, inner)).etag,
    frontmatter: { tags: ["requirement"] },
  });
  await writeNodeDocument(fs, outputs[0]!, {
    baseEtag: (await readNodeForEdit(fs, outputs[0]!)).etag,
    frontmatter: { stale_after: "2020-01-01T00:00:00Z" },
  });
  const read = fs.readFile.bind(fs);
  fs.readFrontmatter = async (path) => {
    const raw = await read(path);
    return raw.slice(0, raw.length - parseFrontmatter(raw).body.length);
  };
  fs.readFile = async (path) => {
    if (path === "Outer/Inner/Rule/Two/Two.md") throw new Error("Unselected output body was read");
    return read(path);
  };
  const comparison = (await readOutputComparisons(fs, [outputs[0]!]))[0]!;
  assert.ok(comparison.goals.every((goal) => goal.state === "current"));
  assert.deepEqual(comparison.changedSince, []);
});

test("output comparison rejects missing, malformed and non-output ids without writes", async () => {
  const { fs, rule } = await fixture();
  const before = new Map(fs.files),
    head = await fs.history.currentCommit();
  await assert.rejects(readOutputComparisons(fs, ["../escape"]), /canonical output Node ids/);
  await assert.rejects(readOutputComparisons(fs, ["node-missing"]), /Node not found/);
  await assert.rejects(readOutputComparisons(fs, [rule]), /Expected an output Node/);
  assert.deepEqual(await readOutputComparisons(fs, []), []);
  assert.deepEqual(fs.files, before);
  assert.equal(await fs.history.currentCommit(), head);
});

for (const code of ["EACCES", "ENOENT"]) {
  test(`${code} in an ancestor body preserves other goals and selected outputs`, async () => {
    const { fs, outer, inner, outputs } = await fixture();
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
    const expected = outputs.map((nodeId) => ({
      nodeId,
      goals: [
        { goalId: inner, state: "changed" },
        { goalId: outer, state: "unknown" },
      ],
      changedSince: [{ kind: "goal", nodeId: inner, name: "Inner" }],
    }));
    assert.deepEqual(await readOutputComparisons(fs, outputs), expected);
    assert.deepEqual(await readOutputChanges(fs, outputs[0]!), expected[0]!.changedSince);
    assert.deepEqual(fs.files, files);
    assert.equal(await fs.history.currentCommit(), head);
  });
}

test("an ancestor becoming unreadable during recheck is unknown without erasing a current sibling goal", async () => {
  const { fs, outer, inner, outputs } = await fixture();
  const read = fs.readFile.bind(fs);
  fs.readFrontmatter = async (path) => {
    const raw = await read(path);
    return raw.slice(0, raw.length - parseFrontmatter(raw).body.length);
  };
  let outerReads = 0;
  fs.readFile = async (path) => {
    if (path === "Outer/Outer.md" && ++outerReads > 1)
      throw Object.assign(new Error("EACCES during ancestor recheck"), { code: "EACCES" });
    return read(path);
  };
  const files = new Map(fs.files),
    head = await fs.history.currentCommit();
  assert.deepEqual(
    await readOutputComparisons(fs, outputs),
    outputs.map((nodeId) => ({
      nodeId,
      goals: [
        { goalId: inner, state: "current" },
        { goalId: outer, state: "unknown" },
      ],
      changedSince: [],
    })),
  );
  assert.deepEqual(fs.files, files);
  assert.equal(await fs.history.currentCommit(), head);
});
