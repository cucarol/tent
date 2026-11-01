import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { scaffoldInWorkspace } from "./scaffold.js";
import { createNode } from "../src/core/graph/ops.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { readNodeForEdit, listNodes } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { nodeWriteInputSchema } from "../src/core/write/node-write.js";
import { writeNodesBatch } from "../src/core/write/node-write-batch.js";
import { appendNodeBody } from "../src/core/write/node-lightwrite.js";
import {
  confirmNodeSync,
  inspectNodeSync,
  inspectWorkspaceSync,
  linkNodeOutput,
} from "../src/core/graph/node-sync.js";
import {
  defaultNodeActor,
  nodeActorSchema,
  nodeVerifications,
  assertNodeProvenanceEdit,
  recordNodeVerification,
} from "../src/core/base/node-provenance.js";
import { nodeSemanticFingerprint } from "../src/core/graph/node-sync-record.js";

const createdAt = "2026-10-04T00:00:00.000Z";

async function fixture(t: TestContext) {
  await fs.mkdir(path.resolve(testScratchRoot()), { recursive: true });
  const root = await fs.mkdtemp(path.resolve(testScratchRoot(), "native-provenance-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), {
    name: "Native",
    nodes: [{ id: "node-legacy", name: "Legacy", type: "prompt", body: "## Fact\noriginal\n" }],
  });
  const adapter = openTestFs(path.join(root, ".tent"));
  const env = { fs: adapter, clock: { now: () => createdAt }, tentName: "Native" };
  return { root, adapter, env };
}

test("provenance edits validate verification without reading unknown generated or stale_after fields", () => {
  const unknown = {
    get generated(): never {
      throw new Error("generated must not be read");
    },
    get stale_after(): never {
      throw new Error("stale_after must not be read");
    },
  };
  assert.doesNotThrow(() => assertNodeProvenanceEdit(unknown, unknown));
  assertNodeProvenanceEdit({}, { verified: { by: "human:cuca", at: createdAt } });
  for (const verified of [null, { by: "", at: createdAt }, { by: "human:cuca", at: "2026-10-04" }])
    assert.throws(() => assertNodeProvenanceEdit({}, { verified }));
  const imported = { verified: { by: "invalid", at: "unknown" } };
  assert.doesNotThrow(() => assertNodeProvenanceEdit(imported, { ...imported }));
});

test("native verification accepts a single mapping, deduplicates by actor at the latest instant", () => {
  const data: Record<string, unknown> = {
    generated: { by: "writer/1", at: createdAt },
    verified: { by: "human:cuca", at: createdAt, note: "keep" },
  };
  assert.equal(nodeVerifications(data).length, 1);
  recordNodeVerification(data, "human:cuca", "2026-10-04T01:00:00Z");
  recordNodeVerification(data, "process:nightly", "2026-10-04T02:00:00+01:00");
  recordNodeVerification(data, "process:nightly", "2026-10-03T23:59:59Z");
  assert.equal(nodeVerifications(data).length, 2);
  assert.deepEqual(nodeVerifications(data)[0], {
    by: "human:cuca",
    at: "2026-10-04T01:00:00Z",
    note: "keep",
  });
  assert.equal(nodeVerifications(data)[1]!.at, "2026-10-04T02:00:00+01:00");
  assert.deepEqual(data.generated, { by: "writer/1", at: createdAt });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(defaultNodeActor(), `tent/${pkg.version}`);
});

test("native actors preserve spaces in human and process identities and reject empty identities", () => {
  const data: Record<string, unknown> = {};
  recordNodeVerification(data, "human:Alice Doe", createdAt);
  recordNodeVerification(data, "process:Daily Check", createdAt);
  assert.deepEqual(nodeVerifications(data), [
    { by: "human:Alice Doe", at: createdAt },
    { by: "process:Daily Check", at: createdAt },
  ]);
  for (const actor of ["", " ", "human:", "human:   ", "process:", "process:   "])
    assert.equal(nodeActorSchema.safeParse(actor).success, false);
});

test("Core create and all body write forms leave generated absent or preserve it as unknown metadata", async (t) => {
  const { adapter, env } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Created",
    type: "prompt",
    body: "## Fact\ninitial\n",
  });
  let current = await readNodeForEdit(adapter, id);
  assert.equal(current.frontmatter.generated, undefined);
  const unchanged = await writeNodeDocument(adapter, id, {
    baseEtag: current.etag,
    body: current.body,
  });
  assert.equal(unchanged.raw, current.raw);
  const lifecycle = await writeNodeDocument(adapter, id, {
    baseEtag: unchanged.etag,
    frontmatter: { status: "draft", stale_after: { opaque: true }, generated: "uninterpreted" },
  });
  assert.equal(parseFrontmatter(lifecycle.raw).data.generated, "uninterpreted");
  const appended = await appendNodeBody(adapter, id, {
    heading: "Extra",
    body: "new",
  });
  assert.equal(parseFrontmatter(appended.raw).data.generated, "uninterpreted");
  const replaced = await appendNodeBody(adapter, id, {
    heading: "Fact",
    body: "updated",
  });
  assert.equal(parseFrontmatter(replaced.raw).data.generated, "uninterpreted");
  const metadata = await writeNodeDocument(adapter, id, {
    baseEtag: replaced.etag,
    frontmatter: { description: "semantics changed" },
  });
  assert.equal(parseFrontmatter(metadata.raw).data.generated, "uninterpreted");
  current = await readNodeForEdit(adapter, id);
  const raw = await writeNodeDocument(adapter, id, {
    baseEtag: current.etag,
    raw: serializeFrontmatter(current.frontmatter, current.body + "raw edit"),
  });
  assert.equal(parseFrontmatter(raw.raw).data.generated, "uninterpreted");
  assert.deepEqual(parseFrontmatter(raw.raw).data.stale_after, { opaque: true });
});

test("Core confirm and JSON confirmation update verified; body edits retain old verification", async (t) => {
  const { adapter, env } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Checked",
    type: "prompt",
    body: "original",
  });
  const initial = await readNodeForEdit(adapter, id);
  const first = await confirmNodeSync(adapter, id, { baseEtag: initial.etag, by: "human:cuca" });
  assert.deepEqual(parseFrontmatter(first.raw).data.generated, initial.frontmatter.generated);
  assert.equal((await inspectNodeSync(adapter, id)).state, "synced");
  const second = await confirmNodeSync(adapter, id, { baseEtag: first.etag, by: "human:cuca" });
  assert.equal(nodeVerifications(parseFrontmatter(second.raw).data).length, 1);
  const input = nodeWriteInputSchema.parse({
    baseEtag: second.etag,
    body: "changed and checked",
    confirm: true,
    by: "process:nightly",
  });
  const combined = await writeNodeDocument(adapter, id, input);
  const combinedData = parseFrontmatter(combined.raw).data;
  assert.equal(combinedData.generated, undefined);
  assert.equal(nodeVerifications(combinedData).length, 2);
  const edited = await writeNodeDocument(adapter, id, {
    baseEtag: combined.etag,
    body: "changed again",
  });
  assert.deepEqual(parseFrontmatter(edited.raw).data.verified, combinedData.verified);
  const checked = await writeNodeDocument(adapter, id, { baseEtag: edited.etag, confirm: true });
  assert.deepEqual(
    parseFrontmatter(checked.raw).data.generated,
    parseFrontmatter(edited.raw).data.generated,
  );
  assert.equal(
    nodeVerifications(parseFrontmatter(checked.raw).data).at(-1)?.by,
    defaultNodeActor(),
  );
});

test("batch creation omits generated and update confirmation still records each actor", async (t) => {
  const { adapter, env } = await fixture(t);
  const created = await writeNodesBatch(env, {
    items: [{ op: "create", ref: "a", name: "Batch", type: "prompt", body: "original" }],
  });
  const id = created.results[0]!.nodeId;
  let current = await readNodeForEdit(adapter, id);
  assert.equal(current.frontmatter.generated, undefined);
  await writeNodesBatch(env, {
    items: [
      {
        op: "update",
        nodeId: id,
        baseEtag: current.etag,
        confirm: true,
        by: "human:cuca",
        frontmatter: { generated: false, stale_after: ["opaque"] },
      },
    ],
  });
  current = await readNodeForEdit(adapter, id);
  assert.equal(current.frontmatter.generated, false);
  assert.equal(nodeVerifications(current.frontmatter)[0]!.by, "human:cuca");
  await writeNodesBatch(env, {
    items: [
      {
        op: "update",
        nodeId: id,
        baseEtag: current.etag,
        body: "changed",
        confirm: true,
        by: "writer/2",
      },
    ],
  });
  current = await readNodeForEdit(adapter, id);
  assert.equal(current.frontmatter.generated, false);
  assert.deepEqual(current.frontmatter.stale_after, ["opaque"]);
  assert.deepEqual(
    nodeVerifications(current.frontmatter).map((event) => event.by),
    ["human:cuca", "writer/2"],
  );
});

test("verified anchors sync while every stale_after value remains inert unknown metadata", async (t) => {
  const { adapter, env } = await fixture(t);
  const goal = await createNode(env, { parentPath: "", name: "Plan", type: "goal" });
  let current = await readNodeForEdit(adapter, "node-legacy");
  await writeNodeDocument(adapter, "node-legacy", {
    baseEtag: current.etag,
    frontmatter: { verified: { by: "human:cuca", at: createdAt } },
  });
  for (const stale_after of [createdAt, "bad", null, false, ["opaque"], { at: createdAt }]) {
    current = await readNodeForEdit(adapter, "node-legacy");
    const written = await writeNodeDocument(adapter, "node-legacy", {
      baseEtag: current.etag,
      frontmatter: { stale_after, generated: stale_after },
    });
    assert.deepEqual(parseFrontmatter(written.raw).data.stale_after, stale_after);
    assert.deepEqual(parseFrontmatter(written.raw).data.generated, stale_after);
    const anchored = await inspectNodeSync(adapter, "node-legacy");
    assert.equal(anchored.state, "synced");
    assert.equal("trustTier" in anchored, false);
    assert.equal("stale" in anchored, false);
    const plan = await readNodeForEdit(adapter, goal);
    await writeNodeDocument(adapter, goal, { baseEtag: plan.etag, frontmatter: { stale_after } });
    assert.equal((await inspectNodeSync(adapter, goal)).state, "ahead");
  }
});

test("material-only observation cannot clear behind, and unknown metadata cannot cause output drift", async (t) => {
  const { root, adapter, env } = await fixture(t);
  await initializeFixtureHistory(path.join(root, ".tent"));
  const material = path.join(root, "input.txt"),
    output = path.join(root, "output.txt");
  await fs.writeFile(material, "v1");
  await fs.writeFile(output, "output");
  const resource = pathToFileURL(material).href;
  const id = await createNode(env, {
    parentPath: "",
    name: "Requirement",
    type: "goal",
    body: "original",
    resource,
  });
  let current = await readNodeForEdit(adapter, id);
  const linked = await linkNodeOutput(adapter, id, {
    resource: pathToFileURL(output).href,
  });
  const checked = await confirmNodeSync(adapter, id, { baseEtag: current.etag, by: "human:cuca" });
  const inspection = await inspectNodeSync(adapter, id);
  assert.equal(inspection.state, "synced");
  assert.equal((await inspectNodeSync(adapter, linked.nodeId)).state, "synced");
  const metadataOnly = await writeNodeDocument(adapter, id, {
    baseEtag: checked.etag,
    frontmatter: {
      verified: [{ by: "process:independent", at: createdAt }],
      generated: { by: "import/1", at: createdAt },
      stale_after: { invalid: true },
    },
  });
  assert.equal((await inspectNodeSync(adapter, linked.nodeId)).state, "synced");
  await fs.writeFile(material, "v2");
  current = await readNodeForEdit(adapter, id);
  const observed = await writeNodeDocument(adapter, id, {
    baseEtag: metadataOnly.etag,
    body: current.body,
  });
  assert.deepEqual(parseFrontmatter(observed.raw).data.generated, current.frontmatter.generated);
  assert.equal((await inspectNodeSync(adapter, id)).state, "behind");
  const edited = await writeNodeDocument(adapter, id, {
    baseEtag: observed.etag,
    body: "new scope",
  });
  assert.equal((await inspectNodeSync(adapter, linked.nodeId)).state, "synced");
  assert.ok(
    (await inspectNodeSync(adapter, linked.nodeId)).materials.some(
      (material) => material.state === "changed",
    ),
  );
  assert.deepEqual(
    parseFrontmatter(edited.raw).data.verified,
    parseFrontmatter(observed.raw).data.verified,
  );
  assert.equal(
    nodeSemanticFingerprint({ type: "goal", generated: { by: "writer/1", at: createdAt } }, "same"),
    nodeSemanticFingerprint(
      { type: "goal", verified: [{ by: "human:cuca", at: createdAt }], stale_after: createdAt },
      "same",
    ),
  );
});

test("native declarations validate actor and explicit timezone while deprecated Nodes leave current lists", async (t) => {
  const { adapter } = await fixture(t);
  const initial = await readNodeForEdit(adapter, "node-legacy");
  for (const frontmatter of [
    { verified: [{ by: "", at: createdAt }] },
    { verified: { by: "human:cuca", at: "2026-10-04T00:00:00" } },
  ]) {
    await assert.rejects(
      writeNodeDocument(adapter, "node-legacy", { baseEtag: initial.etag, frontmatter }),
    );
    assert.equal((await readNodeForEdit(adapter, "node-legacy")).raw, initial.raw);
  }
  await assert.rejects(confirmNodeSync(adapter, "node-legacy", { baseEtag: initial.etag, by: "" }));
  const deprecated = await writeNodeDocument(adapter, "node-legacy", {
    baseEtag: initial.etag,
    frontmatter: { status: "deprecated" },
  });
  assert.equal(parseFrontmatter(deprecated.raw).data.generated, undefined);
  const listed = await listNodes(adapter, "ws-test", {});
  assert.equal(listed.items.length, 0);
  assert.equal((await inspectWorkspaceSync(adapter)).nodes.length, 0);
});
