import assert from "node:assert/strict";
import test from "node:test";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { appendNodeBody, readNodeSection, writeNodeSection } from "../src/core/node-lightwrite.js";
import { confirmNodeSync, inspectNodeSync } from "../src/core/node-sync.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";

test("an imported output without any retained record cannot gain a baseline from metadata", async () => {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Propagation" });
  const env = { fs, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Propagation" };
  await createNode(env, { parentPath: "", name: "Goal", type: "goal", body: "Intent" });
  const raw = serializeFrontmatter({ id: "node-imported", type: "output" }, "Imported evidence");
  await fs.writeFile("Goal/Imported/Imported.md", raw);
  await fs.history.captureUnlocked([{ path: "Goal/Imported/Imported.md", raw }]);
  assert.ok((await inspectNodeSync(fs, "node-imported")).behind);
  const read = await readNodeForEdit(fs, "node-imported");
  await writeNodeDocument(fs, "node-imported", {
    baseEtag: read.etag,
    frontmatter: { tags: ["metadata"] },
  });
  assert.ok((await inspectNodeSync(fs, "node-imported")).behind);
  assert.equal((await fs.history.nodeRecords())["node-imported"]?.goals, undefined);
  const current = await readNodeForEdit(fs, "node-imported");
  await confirmNodeSync(fs, "node-imported", { baseEtag: current.etag });
  assert.equal((await inspectNodeSync(fs, "node-imported")).behind, undefined);
});

test("output metadata, equivalent newlines and partial edits retain a changed dependency", async () => {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Propagation" });
  const env = { fs, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Propagation" };
  await fs.writeFile("../material.txt", "first\n");
  await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    resource: "../../material.txt",
  });
  const output = await createNode(env, {
    parentPath: "Goal",
    name: "Output",
    type: "output",
    body: "## Result\nOld body.\n",
  });
  await fs.writeFile("../material.txt", "second\n");
  async function edit(patch: Parameters<typeof writeNodeDocument>[2]) {
    const read = await readNodeForEdit(fs, output);
    return writeNodeDocument(fs, output, { baseEtag: read.etag, ...patch });
  }
  const original = await inspectNodeSync(fs, output);
  assert.ok(original.behind);
  await edit({ frontmatter: { tags: ["review", "asset"], type: "output" } });
  assert.ok((await inspectNodeSync(fs, output)).behind);
  const read = await readNodeForEdit(fs, output);
  await edit({ body: read.body.replace(/\n/g, "\r\n") });
  assert.ok((await inspectNodeSync(fs, output)).behind);
  await appendNodeBody(fs, output, { body: "An added detail." });
  assert.ok((await inspectNodeSync(fs, output)).behind);
  const section = await readNodeSection(fs, output, "Result");
  await writeNodeSection(fs, output, {
    heading: "Result",
    baseEtag: section.sectionEtag,
    body: "## Result\nChanged section.\n",
  });
  assert.ok((await inspectNodeSync(fs, output)).behind);
  assert.deepEqual(
    (await fs.history.nodeRecords())[output]?.goals?.[0]?.materials.map((m) => m.version),
    original.materials
      .filter((m) => m.resource.includes("material.txt"))
      .map((m) => m.recordedVersion),
  );
  await edit({ body: "## Result\nRewritten after full review.\n" });
  assert.equal((await inspectNodeSync(fs, output)).behind, undefined);
  assert.equal((await inspectNodeSync(fs, output)).trustTier, "unverified");
});

test("output rewrites acknowledge final output bytes also used by ancestor goal materials", async () => {
  const fs = new PropagationMemoryFs();
  await scaffoldTent(fs, { name: "Propagation" });
  const env = { fs, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Propagation" };
  const batch = await writeNodesBatch(env, {
    items: [
      {
        op: "create",
        ref: "goal",
        name: "Goal",
        type: "goal",
        sources: [{ resource: "@output" }],
        body: "Intent",
      },
      {
        op: "create",
        ref: "output",
        parent: "@goal",
        name: "Output",
        type: "output",
        body: "Initial result",
      },
    ],
  });
  const goal = batch.results[0]!.nodeId,
    output = batch.results[1]!.nodeId;
  assert.equal((await inspectNodeSync(fs, output)).behind, undefined);
  const read = await readNodeForEdit(fs, output);
  await writeNodeDocument(fs, output, { baseEtag: read.etag, body: "Updated result" });
  assert.equal((await inspectNodeSync(fs, output)).behind, undefined);
  assert.ok((await inspectNodeSync(fs, goal)).behind);
  const goalRead = await readNodeForEdit(fs, goal);
  await confirmNodeSync(fs, goal, { baseEtag: goalRead.etag });
  assert.equal((await inspectNodeSync(fs, output)).behind, undefined);
  assert.equal((await inspectNodeSync(fs, goal)).ahead, undefined);
});
