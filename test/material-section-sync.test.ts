import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { readNodeSection } from "../src/core/node-lightwrite.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import { confirmNodeSync, inspectNodeSync } from "../src/core/node-sync.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { nodeSemanticFingerprint } from "../src/core/node-sync-record.js";
import { loadNodeCatalog } from "../src/core/node-catalog.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function nodeSectionDigest(fs: NodeFs, id: string, section: string) {
  const read = await readNodeForEdit(fs, id);
  const selected = await readNodeSection(fs, id, section);
  return nodeSemanticFingerprint(
    read.frontmatter,
    selected.text,
    `${read.path}/${read.path.split("/").at(-1)}.md`,
    (await loadNodeCatalog(fs)).byId,
  );
}

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(path.join(testScratchRoot(), "material-section-sync-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Sections" });
  const root = path.join(workspace, ".tent"),
    fs = new NodeFs(root);
  await git(root, "init", "--initial-branch=main");
  const env = { fs, clock: { now: () => "2026-10-05T00:00:00.000Z" }, tentName: "Sections" };
  async function edit(id: string, patch: Parameters<typeof writeNodeDocument>[2]) {
    const current = await readNodeForEdit(fs, id);
    return writeNodeDocument(fs, id, { baseEtag: current.etag, ...patch });
  }
  async function confirm(id: string) {
    const current = await readNodeForEdit(fs, id);
    return confirmNodeSync(fs, id, { baseEtag: current.etag });
  }
  return { workspace, root, fs, env, edit, confirm };
}

test("resource and sources synchronize only selected Markdown sections and cannot confirm missing headings", async (t) => {
  const { workspace, root, fs, env, edit, confirm } = await fixture(t);
  await mkdir(path.join(workspace, "设计"));
  const filename = path.join(workspace, "设计", "设计.md");
  const selected = "## 状态\n\n状态一。\n\n### 细节\n\n细节一。\n\n";
  const raw = (section: string, other: string) => "# 设计\n\n" + section + "## 其他\n\n" + other;
  await writeFile(filename, raw(selected, "其他一。\n"));
  const address = "../../设计/设计.md#状态";
  const ids = [
    await createNode(env, { parentPath: "", name: "Resource", type: "prompt", resource: address }),
    await createNode(env, {
      parentPath: "",
      name: "Sources",
      type: "prompt",
      sources: [{ resource: address }],
    }),
  ];
  for (const id of ids) {
    const sync = await inspectNodeSync(fs, id);
    assert.equal(sync.state, "synced");
    assert.equal(sync.materials[0]!.recordedVersion, digest(selected));
  }
  await writeFile(filename, raw(selected, "其他内容修改，目标不变。\n"));
  for (const id of ids) {
    assert.equal((await inspectNodeSync(new NodeFs(root), id)).state, "synced");
    await edit(id, { body: "普通 Node 保存。\n" });
    assert.equal((await inspectNodeSync(fs, id)).materials[0]!.recordedVersion, digest(selected));
  }
  const changed = selected.replace("细节一", "细节更新");
  await writeFile(filename, raw(changed, "其他内容。\n"));
  for (const id of ids) {
    assert.equal((await inspectNodeSync(fs, id)).state, "behind");
    await edit(id, { body: "继续普通保存。\n" });
    assert.equal((await inspectNodeSync(fs, id)).materials[0]!.recordedVersion, digest(selected));
    await confirm(id);
    assert.equal((await inspectNodeSync(fs, id)).state, "synced");
    assert.equal((await inspectNodeSync(fs, id)).materials[0]!.recordedVersion, digest(changed));
  }
  for (const unavailable of [
    "# 设计\n\n## 其他\n\n目标删除。\n",
    raw(changed, "其他。\n") + "\n## 状态\n重复。\n",
  ]) {
    await writeFile(filename, unavailable);
    for (const id of ids) {
      await confirm(id);
      const sync = await inspectNodeSync(fs, id);
      assert.equal(sync.state, "behind");
      assert.equal(sync.materials[0]!.state, "unavailable");
      assert.equal(sync.materials[0]!.recordedVersion, digest(changed));
      assert.match(sync.materials[0]!.reason!, /not found|duplicated/);
    }
  }
});

test("atomic batches record final peer and self sections, including missing-section confirmation", async (t) => {
  const { fs, env } = await fixture(t);
  const peerBody = "## 状态\n\n同批最终材料。\n\n## 其他\n\n无关内容。\n";
  const selfBody = "## 状态\n\n自身材料。\n\n## 其他\n\n自身其他内容。\n";
  const saved = await writeNodesBatch(env, {
    items: [
      {
        op: "create",
        ref: "consumer",
        name: "Consumer",
        type: "prompt",
        sources: [{ resource: "@peer#状态" }],
      },
      {
        op: "create",
        ref: "self",
        name: "Self",
        type: "prompt",
        resource: "@self#状态",
        body: selfBody,
      },
      { op: "create", ref: "peer", name: "Peer", type: "prompt", body: peerBody },
    ],
  });
  const consumer = saved.results[0]!.nodeId,
    self = saved.results[1]!.nodeId,
    peer = saved.results[2]!.nodeId;
  const peerSection = await readNodeSection(fs, peer, "状态"),
    selfSection = await readNodeSection(fs, self, "状态");
  for (const [id, text] of [
    [consumer, peerSection.text],
    [self, selfSection.text],
  ]) {
    const sync = await inspectNodeSync(fs, id!);
    assert.equal(sync.state, "synced");
    assert.equal(
      sync.materials[0]!.recordedVersion,
      await nodeSectionDigest(fs, id === consumer ? peer : self, "状态"),
    );
  }
  const reads = await Promise.all([consumer, self, peer].map((id) => readNodeForEdit(fs, id)));
  await writeNodesBatch(env, {
    items: [
      { op: "update", nodeId: consumer, baseEtag: reads[0]!.etag, confirm: true },
      {
        op: "update",
        nodeId: self,
        baseEtag: reads[1]!.etag,
        confirm: true,
        body: selfBody.replace("自身材料", "自身已更新材料"),
      },
      {
        op: "update",
        nodeId: peer,
        baseEtag: reads[2]!.etag,
        body: peerBody.replace("同批最终材料", "更新后的最终材料"),
      },
    ],
  });
  for (const [id, materialId] of [
    [consumer, peer],
    [self, self],
  ]) {
    const sync = await inspectNodeSync(fs, id!);
    assert.equal(sync.state, "synced");
    const selected = await readNodeSection(fs, materialId!, "状态");
    assert.equal(
      sync.materials[0]!.recordedVersion,
      await nodeSectionDigest(fs, materialId!, "状态"),
    );
  }
  const beforeMissing = await inspectNodeSync(fs, consumer);
  const consumerRead = await readNodeForEdit(fs, consumer),
    peerRead = await readNodeForEdit(fs, peer);
  await writeNodesBatch(env, {
    items: [
      { op: "update", nodeId: consumer, baseEtag: consumerRead.etag, confirm: true },
      { op: "update", nodeId: peer, baseEtag: peerRead.etag, body: "## 其他\n\n目标小节删除。\n" },
    ],
  });
  const missing = await inspectNodeSync(fs, consumer);
  assert.equal(missing.state, "behind");
  assert.equal(missing.materials[0]!.state, "unavailable");
  assert.equal(missing.materials[0]!.recordedVersion, beforeMissing.materials[0]!.recordedVersion);
  assert.match(missing.materials[0]!.reason!, /not found/);
});

test("single self-reference save observes its final selected body and ignores other-section changes", async (t) => {
  const { fs, env, edit } = await fixture(t);
  const body = "## 状态\n\n状态材料。\n\n## 其他\n\n其他内容。\n";
  const id = await createNode(env, {
    parentPath: "",
    name: "Self",
    type: "prompt",
    resource: "./Self.md#状态",
    body,
  });
  const initial = await inspectNodeSync(fs, id);
  assert.equal(initial.state, "synced");
  assert.equal(initial.materials[0]!.recordedVersion, await nodeSectionDigest(fs, id, "状态"));
  await edit(id, { body: body.replace("其他内容", "其他新内容") });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  await edit(id, { body: body.replace("状态材料", "状态新材料") });
  assert.equal((await inspectNodeSync(fs, id)).state, "behind");
  await edit(id, { confirm: true });
  assert.equal((await inspectNodeSync(fs, id)).state, "synced");
  assert.equal(
    (await inspectNodeSync(fs, id)).materials[0]!.recordedVersion,
    await nodeSectionDigest(fs, id, "状态"),
  );
  await edit(id, { body: "## 其他\n\n缺少目标小节。\n", confirm: true });
  assert.equal((await inspectNodeSync(fs, id)).state, "behind");
});
