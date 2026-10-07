import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { readNodeForEdit, listNodes } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { nodeWriteInputSchema } from "../src/core/node-write.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import { appendNodeBody, readNodeSection, writeNodeSection } from "../src/core/node-lightwrite.js";
import {
  confirmNodeSync,
  inspectNodeSync,
  inspectWorkspaceSync,
  linkNodeOutput,
} from "../src/core/node-sync.js";
import {
  defaultNodeActor,
  nodeActorSchema,
  nodeTrustTier,
  nodeVerifications,
  nodeIsStale,
  prepareNodeProvenanceSave,
  recordNodeVerification,
} from "../src/core/node-provenance.js";
import { nodeSemanticFingerprint } from "../src/core/node-sync-record.js";
import { git } from "./helpers.js";

const createdAt = "2026-10-04T00:00:00.000Z";

async function fixture(t: TestContext) {
  await fs.mkdir(path.resolve(".scratch"), { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".scratch/native-provenance-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), {
    name: "Native",
    nodes: [{ id: "node-legacy", name: "Legacy", type: "prompt", body: "## Fact\noriginal\n" }],
  });
  const adapter = new NodeFs(path.join(root, ".tent"));
  const env = { fs: adapter, clock: { now: () => createdAt }, tentName: "Native" };
  return { root, adapter, env };
}

test("native generated records meaningful production and preserves lifecycle, imported fields and verification independence", () => {
  const initialData = {
    id: "node-test",
    type: "prompt",
    description: "original",
    generated: { by: "writer/1", at: createdAt, custom: "keep" },
    verified: { by: "human:cuca", at: createdAt, scope: "keep" },
  };
  const original = serializeFrontmatter(initialData, "fact\n");
  const observedAt = "2026-10-04T02:00:00+02:00";
  for (const patch of [
    { status: "deprecated" },
    { stale_after: "2026-10-05T00:00:00Z" },
    { title: "renamed" },
    { generated: { by: "import/1", at: observedAt } },
    { verified: [{ by: "process:check", at: observedAt }] },
  ]) {
    const edited = serializeFrontmatter({ ...initialData, ...patch }, "fact\n");
    assert.equal(prepareNodeProvenanceSave(edited, original, "observer/1", observedAt), edited);
  }
  const bodyEdit = prepareNodeProvenanceSave(
    serializeFrontmatter(initialData, "changed\n"),
    original,
    "writer/2",
    observedAt,
  );
  assert.deepEqual(parseFrontmatter(bodyEdit).data.generated, {
    by: "writer/2",
    at: observedAt,
    custom: "keep",
  });
  assert.deepEqual(parseFrontmatter(bodyEdit).data.verified, initialData.verified);
  const semanticEdit = prepareNodeProvenanceSave(
    serializeFrontmatter({ ...initialData, description: "changed" }, "fact\n"),
    original,
    "writer/2",
    observedAt,
  );
  assert.equal((parseFrontmatter(semanticEdit).data.generated as { by: string }).by, "writer/2");
  assert.equal(prepareNodeProvenanceSave(original, original, "observer/1", observedAt), original);
  assert.equal(
    prepareNodeProvenanceSave(
      serializeFrontmatter({ id: "node-test", type: "prompt" }, "fact"),
      serializeFrontmatter({ id: "node-test", type: "prompt" }, "fact"),
      "observer/1",
      observedAt,
    ).includes("generated"),
    false,
  );
});

test("native verification accepts a single mapping, deduplicates by actor at the latest instant and infers only human prefix", () => {
  const data: Record<string, unknown> = {
    generated: { by: "writer/1", at: createdAt },
    verified: { by: "human:cuca", at: createdAt, note: "keep" },
  };
  assert.equal(nodeVerifications(data).length, 1);
  assert.equal(nodeTrustTier(data), "human-reviewed");
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
  assert.equal(
    nodeTrustTier({ verified: { by: "humanish/1", at: createdAt } }),
    "machine-confirmed",
  );
  assert.equal(
    nodeTrustTier({ verified: { by: "process:human:cuca", at: createdAt } }),
    "machine-confirmed",
  );
  assert.equal(nodeTrustTier({}), "unverified");
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
  assert.equal(nodeTrustTier(data), "human-reviewed");
  for (const actor of ["", " ", "human:", "human:   ", "process:", "process:   "])
    assert.equal(nodeActorSchema.safeParse(actor).success, false);
});

test("Core create and all body write forms set explicit actor; no-op and lifecycle edits do not regenerate", async (t) => {
  const { adapter, env } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Created",
    type: "prompt",
    body: "## Fact\ninitial\n",
    by: "human:cuca",
  });
  let current = await readNodeForEdit(adapter, id);
  assert.deepEqual(current.frontmatter.generated, { by: "human:cuca", at: createdAt });
  const unchanged = await writeNodeDocument(adapter, id, {
    baseEtag: current.etag,
    body: current.body,
    by: "observer/1",
  });
  assert.equal(unchanged.raw, current.raw);
  const lifecycle = await writeNodeDocument(adapter, id, {
    baseEtag: unchanged.etag,
    frontmatter: { status: "draft", stale_after: "2099-01-01T00:00:00Z" },
    by: "observer/1",
  });
  assert.deepEqual(parseFrontmatter(lifecycle.raw).data.generated, current.frontmatter.generated);
  const appended = await appendNodeBody(adapter, id, {
    heading: "Extra",
    body: "new",
    by: "writer/2",
  });
  assert.equal((parseFrontmatter(appended.raw).data.generated as { by: string }).by, "writer/2");
  const section = await readNodeSection(adapter, id, "Fact");
  const replaced = await writeNodeSection(adapter, id, {
    heading: "Fact",
    baseEtag: section.sectionEtag,
    body: "## Fact\nupdated",
    by: "writer/3",
  });
  assert.equal((parseFrontmatter(replaced.raw).data.generated as { by: string }).by, "writer/3");
  const metadata = await writeNodeDocument(adapter, id, {
    baseEtag: replaced.etag,
    frontmatter: { description: "semantics changed" },
    by: "writer/4",
  });
  assert.equal((parseFrontmatter(metadata.raw).data.generated as { by: string }).by, "writer/4");
  current = await readNodeForEdit(adapter, id);
  const raw = await writeNodeDocument(adapter, id, {
    baseEtag: current.etag,
    raw: serializeFrontmatter(current.frontmatter, current.body + "raw edit"),
    by: "writer/5",
  });
  assert.equal((parseFrontmatter(raw.raw).data.generated as { by: string }).by, "writer/5");
});

test("Core confirm and JSON confirmation update verified without regenerating, body edits retain old verification", async (t) => {
  const { adapter, env } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Checked",
    type: "prompt",
    body: "original",
    by: "writer/1",
  });
  const initial = await readNodeForEdit(adapter, id);
  const first = await confirmNodeSync(adapter, id, { baseEtag: initial.etag, by: "human:cuca" });
  assert.deepEqual(parseFrontmatter(first.raw).data.generated, initial.frontmatter.generated);
  assert.equal((await inspectNodeSync(adapter, id)).trustTier, "human-reviewed");
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
  assert.equal((combinedData.generated as { by: string }).by, "process:nightly");
  assert.equal(nodeVerifications(combinedData).length, 2);
  const edited = await writeNodeDocument(adapter, id, {
    baseEtag: combined.etag,
    body: "changed again",
    by: "writer/2",
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

test("batch creation and update use each item's actor and confirmation is independent of generation", async (t) => {
  const { adapter, env } = await fixture(t);
  const created = await writeNodesBatch(env, {
    items: [
      { op: "create", ref: "a", name: "Batch", type: "prompt", body: "original", by: "writer/1" },
    ],
  });
  const id = created.results[0]!.nodeId;
  let current = await readNodeForEdit(adapter, id);
  assert.deepEqual(current.frontmatter.generated, { by: "writer/1", at: createdAt });
  await writeNodesBatch(env, {
    items: [{ op: "update", nodeId: id, baseEtag: current.etag, confirm: true, by: "human:cuca" }],
  });
  current = await readNodeForEdit(adapter, id);
  assert.deepEqual(current.frontmatter.generated, { by: "writer/1", at: createdAt });
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
  assert.deepEqual(current.frontmatter.generated, { by: "writer/2", at: createdAt });
  assert.deepEqual(
    nodeVerifications(current.frontmatter).map((event) => event.by),
    ["human:cuca", "writer/2"],
  );
});

test("native expiry uses an absolute timezone instant at equality, precedes ahead, and verification anchors without sync", async (t) => {
  const { adapter, env } = await fixture(t);
  const id = await createNode(env, { parentPath: "", name: "Plan", type: "goal" });
  const current = await readNodeForEdit(adapter, id);
  await writeNodeDocument(adapter, id, {
    baseEtag: current.etag,
    frontmatter: { stale_after: "2026-10-04T08:00:00+08:00" },
  });
  assert.equal((await inspectNodeSync(adapter, id, "2026-10-03T23:59:59.999Z")).state, "ahead");
  const expired = await inspectNodeSync(adapter, id, createdAt);
  assert.equal(expired.state, "behind");
  assert.equal(expired.stale, true);
  assert.equal(nodeIsStale({ stale_after: "2026-10-04T08:00:00+08:00" }, createdAt), true);
  const legacy = await readNodeForEdit(adapter, "node-legacy");
  const imported = await writeNodeDocument(adapter, "node-legacy", {
    baseEtag: legacy.etag,
    frontmatter: { verified: { by: "human:cuca", at: createdAt } },
  });
  assert.equal(parseFrontmatter(imported.raw).data.sync, undefined);
  const anchored = await inspectNodeSync(adapter, "node-legacy", createdAt);
  assert.equal(anchored.state, "synced");
  assert.equal(anchored.trustTier, "human-reviewed");
  assert.equal(Array.isArray(parseFrontmatter(imported.raw).data.verified), false);
  const overdue = await writeNodeDocument(adapter, "node-legacy", {
    baseEtag: imported.etag,
    frontmatter: { stale_after: createdAt },
  });
  assert.equal((await inspectNodeSync(adapter, "node-legacy", createdAt)).state, "behind");
  const ordinary = await writeNodeDocument(adapter, "node-legacy", {
    baseEtag: overdue.etag,
    body: legacy.body,
  });
  assert.equal((await inspectNodeSync(adapter, "node-legacy", createdAt)).state, "behind");
  const confirmed = await confirmNodeSync(adapter, "node-legacy", {
    baseEtag: ordinary.etag,
    by: "human:cuca",
  });
  assert.equal((await inspectNodeSync(adapter, "node-legacy", createdAt)).state, "behind");
  assert.equal(nodeVerifications(parseFrontmatter(confirmed.raw).data).length, 1);
});

test("material-only observation does not regenerate or clear behind, and native metadata cannot cause output drift", async (t) => {
  const { root, adapter, env } = await fixture(t);
  await git(path.join(root, ".tent"), "init", "--initial-branch=main");
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
    by: "writer/1",
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
      stale_after: "2099-01-01T00:00:00Z",
    },
  });
  assert.equal((await inspectNodeSync(adapter, linked.nodeId)).state, "synced");
  await fs.writeFile(material, "v2");
  current = await readNodeForEdit(adapter, id);
  const observed = await writeNodeDocument(adapter, id, {
    baseEtag: metadataOnly.etag,
    body: current.body,
    by: "observer/1",
  });
  assert.deepEqual(parseFrontmatter(observed.raw).data.generated, current.frontmatter.generated);
  assert.equal((await inspectNodeSync(adapter, id)).state, "behind");
  const edited = await writeNodeDocument(adapter, id, {
    baseEtag: observed.etag,
    body: "new scope",
    by: "writer/2",
  });
  assert.equal((await inspectNodeSync(adapter, linked.nodeId)).state, "behind");
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
    { stale_after: "2026-10-04T00:00:00" },
    { generated: { by: "human:cuca", at: "2026-10-04" } },
    { verified: [{ by: "", at: createdAt }] },
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
