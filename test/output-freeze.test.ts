import assert from "node:assert/strict";
import test from "node:test";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { createNode } from "../src/core/graph/ops.js";
import { readNode, readNodeForEdit } from "../src/core/read/node-query.js";
import { prepareNodeBatch } from "../src/core/write/node-batch.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import {
  confirmNodeSync,
  inspectWorkspaceSync,
  inspectNodeSync,
} from "../src/core/graph/node-sync.js";
import {
  createCardDocument,
  takeCardDocument,
  listCardDocuments,
} from "../src/core/graph/card-document.js";
import { pageText } from "../src/cli/reader-page.js";

async function fixture(tag: string) {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Frozen outputs" });
  const env = { fs, clock: { now: () => "2026-10-06T00:00:00.000Z" }, tentName: "Frozen outputs" };
  for (const name of ["outer", "inner", "result"]) await fs.writeFile(`../${name}.txt`, "first");
  const outer = await createNode(env, {
    parentPath: "",
    name: "Outer",
    type: "goal",
    resource: "../../outer.txt",
  });
  const inner = await createNode(env, {
    parentPath: "Outer",
    name: "Inner",
    type: "goal",
    resource: "../../../inner.txt",
  });
  const prompt = await createNode(env, {
    parentPath: "",
    name: "Rule",
    type: "prompt",
    resource: "../../result.txt",
  });
  await createCardDocument(fs, {
    cardId: "card-freeze",
    prompt: "implement",
    sources: [{ resource: "/Outer/Outer.md" }, { resource: "/Outer/Inner/Inner.md" }],
  });
  await takeCardDocument(fs, "card-freeze");
  const output = await createNode(env, {
    parentPath: "Outer/Inner",
    name: "Result",
    type: "output",
    tags: [tag],
    resource: "../../../../result.txt",
    sources: [{ resource: "/cards/card-freeze.md" }],
  });
  const confirm = async (id: string) =>
    confirmNodeSync(fs, id, { baseEtag: (await readNodeForEdit(fs, id)).etag });
  return { fs, env, output, outer, inner, prompt, confirm };
}

for (const tag of ["asset", "evidence", "analysis", "issue"]) {
  test(`output ${tag} stays frozen while full reads report only own and nearest goal changes`, async () => {
    const { fs, output, outer, inner, prompt, confirm } = await fixture(tag);
    await fs.writeFile("../result.txt", "second");
    assert.equal((await inspectNodeSync(fs, output)).behind, undefined);
    assert.ok((await inspectNodeSync(fs, prompt)).behind);
    assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
    await fs.writeFile("../outer.txt", "second");
    await fs.writeFile("../inner.txt", "second");
    await confirm(outer);
    const sync = await inspectWorkspaceSync(fs);
    assert.deepEqual(
      sync.nodes
        .filter((node) => node.ahead)
        .map((node) => node.nodeId)
        .sort(),
      [outer, inner].sort(),
    );
    assert.equal(sync.nodes.find((node) => node.nodeId === output)!.behind, undefined);
    assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
    const head = await fs.history.currentCommit();
    const raw = await fs.readFile("Outer/Inner/Result/Result.md");
    const read = await readNode(fs, "ws-test", { nodeId: output });
    assert.ok("changedSince" in read.node);
    const changes = read.node.changedSince!;
    assert.deepEqual(changes, [
      { kind: "material", resource: "../../../../result.txt" },
      { kind: "goal", nodeId: inner, name: "Inner" },
    ]);
    assert.deepEqual((await readNodeForEdit(fs, output, { changes: true })).changedSince, changes);
    const batch = await prepareNodeBatch(fs, "ws-test");
    assert.deepEqual((await batch.read(output, "raw")).item.changedSince, changes);
    assert.equal(await fs.history.currentCommit(), head);
    assert.equal(await fs.readFile("Outer/Inner/Result/Result.md"), raw);
    const edit = await readNodeForEdit(fs, output);
    await writeNodeDocument(fs, output, { baseEtag: edit.etag, body: "rewritten result" });
    assert.deepEqual((await readNodeForEdit(fs, output, { changes: true })).changedSince, changes);
    await confirm(output);
    assert.equal((await readNodeForEdit(fs, output, { changes: true })).changedSince, undefined);
    assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
    assert.equal((await inspectNodeSync(fs, outer)).ahead, undefined);
    assert.equal((await inspectNodeSync(fs, inner)).ahead, undefined);
  });
}

for (const evidence of ["confirmation", "new output"] as const) {
  test(`one matching ${evidence} clears goal ahead while older outputs retain their changes and Card delivery stays complete`, async () => {
    const { fs, env, output, outer, inner, confirm } = await fixture("evidence");
    const other = await createNode(env, {
      parentPath: "Outer/Inner",
      name: "Other",
      type: "output",
      body: "Independent evidence",
    });
    await fs.writeFile("../outer.txt", "second");
    await writeNodeDocument(fs, inner, {
      baseEtag: (await readNodeForEdit(fs, inner)).etag,
      body: "Changed requirement",
    });
    await confirm(outer);
    assert.ok((await inspectNodeSync(fs, outer)).ahead);
    assert.ok((await inspectNodeSync(fs, inner)).ahead);
    assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
    const olderChanges = (await readNodeForEdit(fs, output, { changes: true })).changedSince;
    assert.deepEqual(olderChanges, [{ kind: "goal", nodeId: inner, name: "Inner" }]);
    let matching: string;
    if (evidence === "confirmation") {
      await confirm(other);
      matching = other;
    } else {
      matching = await createNode(env, {
        parentPath: "Outer/Inner",
        name: "Current",
        type: "output",
        body: "Current independent evidence",
      });
    }
    assert.equal((await inspectNodeSync(fs, outer)).ahead, undefined);
    assert.equal((await inspectNodeSync(fs, inner)).ahead, undefined);
    const card = (await listCardDocuments(fs)).items[0]!;
    assert.equal(card.state, "consumed");
    assert.equal("progress" in card, false);
    assert.equal("outputNodeIds" in card, false);
    assert.deepEqual(
      (await readNodeForEdit(fs, output, { changes: true })).changedSince,
      olderChanges,
    );
    await writeNodeDocument(fs, matching, {
      baseEtag: (await readNodeForEdit(fs, matching)).etag,
      frontmatter: { status: "deprecated" },
    });
    assert.ok((await inspectNodeSync(fs, outer)).ahead);
    assert.ok((await inspectNodeSync(fs, inner)).ahead);
    assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
  });
}

test("partial matches from different outputs cannot combine into current evidence", async () => {
  const { fs, env, output, outer, inner, confirm } = await fixture("evidence");
  const originalBody = (await readNodeForEdit(fs, outer)).body;
  await writeNodeDocument(fs, outer, {
    baseEtag: (await readNodeForEdit(fs, outer)).etag,
    body: "Second direction",
  });
  await fs.writeFile("../outer.txt", "second");
  const other = await createNode(env, {
    parentPath: "Outer/Inner",
    name: "Other",
    type: "output",
    body: "Evidence for the second body and material",
  });
  await writeNodeDocument(fs, outer, {
    baseEtag: (await readNodeForEdit(fs, outer)).etag,
    body: originalBody,
  });
  assert.ok((await inspectNodeSync(fs, outer)).ahead);
  assert.equal((await inspectNodeSync(fs, inner)).ahead, undefined);
  assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
  await confirm(output);
  assert.equal((await inspectNodeSync(fs, outer)).ahead, undefined);
  assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
  assert.deepEqual((await readNodeForEdit(fs, other, { changes: true })).changedSince, undefined);
});

test("an imported output without a goal baseline cannot establish current evidence", async () => {
  const { fs, env, confirm } = await fixture("evidence");
  const goal = await createNode(env, { parentPath: "", name: "ImportedGoal", type: "goal" });
  const imported = "node-imported";
  await fs.writeFile(
    "ImportedGoal/Imported/Imported.md",
    `---\nid: ${imported}\ntype: output\n---\nImported result\n`,
  );
  assert.ok((await inspectNodeSync(fs, goal)).ahead);
  assert.equal((await inspectNodeSync(fs, imported)).behind, undefined);
  assert.equal((await readNodeForEdit(fs, imported, { changes: true })).changedSince, undefined);
  await confirm(imported);
  assert.equal((await inspectNodeSync(fs, goal)).ahead, undefined);
});

test("unavailable goal material cannot establish a match or claim a known change", async () => {
  const { fs, output, outer } = await fixture("evidence");
  const head = await fs.history.currentCommit();
  await fs.remove("../outer.txt");
  assert.ok((await inspectNodeSync(fs, outer)).ahead);
  assert.equal((await inspectNodeSync(fs, output)).behind, undefined);
  assert.equal((await readNodeForEdit(fs, output, { changes: true })).changedSince, undefined);
  assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
  await fs.writeFile("../outer.txt", "first");
  assert.equal((await inspectNodeSync(fs, outer)).ahead, undefined);
  assert.equal((await listCardDocuments(fs)).items[0]!.state, "consumed");
  assert.equal(await fs.history.currentCommit(), head);
});

test("only explicit expiry makes a frozen output behind, and confirmation does not clear expiry", async () => {
  const { fs, output, confirm } = await fixture("asset");
  const edit = await readNodeForEdit(fs, output);
  await writeNodeDocument(fs, output, {
    baseEtag: edit.etag,
    frontmatter: { stale_after: "2026-10-07T00:00:00Z" },
  });
  await fs.writeFile("../result.txt", "changed");
  assert.equal((await inspectNodeSync(fs, output, "2026-10-06T23:59:59Z")).behind, undefined);
  const expired = await inspectNodeSync(fs, output, "2026-10-07T00:00:00Z");
  assert.deepEqual(expired.behind?.reasons, ["Content is stale on or after 2026-10-07T00:00:00Z"]);
  await confirm(output);
  assert.ok((await inspectNodeSync(fs, output, "2026-10-07T00:00:00Z")).behind);
});

test("output change metadata survives a complete CLI page and is omitted from partial pages", () => {
  const changedSince = [{ kind: "goal" as const, nodeId: "node-goal", name: "Goal" }];
  const full = {
    nodeId: "node-output",
    etag: "etag",
    view: "body",
    text: "result",
    range: { unit: "utf16" as const, start: 0, end: 6 },
    viewLength: 6,
    changedSince,
  };
  assert.deepEqual(pageText(full, "node.get:node-output").changedSince, changedSince);
  const partial = pageText(full, "node.get:node-output", { end: 3 });
  assert.equal(partial.changedSince, undefined);
  assert.equal(partial.partial, true);
});
