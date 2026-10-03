import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode, renameNode } from "../src/core/ops.js";
import {
  readAnnotations,
  writeAnnotations,
  AnnotationWriteError,
} from "../src/core/annotations.js";
import { readWorkspaceRevision } from "../src/core/workspace-revision.js";
import { listWorkspaceRelations } from "../src/core/workspace-relations.js";
import { listHistoryChanges } from "../src/core/history-query.js";
import { readDocumentVersion, readDocumentDiff } from "../src/core/document-diff.js";
import { createCardDocument } from "../src/core/card-document.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "core-ui-"));
  t.after(async () => {
    assert.equal(path.dirname(workspace), path.resolve(testScratchRoot()));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  await initializeTentWorkspace(workspace);
  const root = path.join(workspace, ".tent");
  const adapter = new NodeFs(root, "ui");
  const env = {
    fs: adapter,
    tentRoot: root,
    tentName: "UI",
    clock: { now: () => new Date().toISOString() },
  };
  return { workspace, root, adapter, env };
}

const drawing = () => ({
  schemaVersion: 1,
  map: {
    elements: [
      JSON.parse(
        '{"id":"a","type":"freedraw","points":[[0,0],[2,3]],"customData":{"__proto__":{"kept":true}}}',
      ),
      { id: "b", type: "arrow", isDeleted: true },
    ],
    anchors: { a: { node: "node-gone", x: 2, y: 4 }, b: { node: "node-gone", x: 3, y: 5 } },
  },
});

test("annotations share CAS/history, retain unknown JSON, and record stroke-sized diffs without no-op commits", async (t) => {
  const { adapter } = await fixture(t);
  assert.deepEqual(await readAnnotations(adapter), { etag: null, document: null });
  const first = await writeAnnotations(adapter, { baseEtag: null, document: drawing() });
  const read = await readAnnotations(adapter);
  assert.equal(read.etag, first.etag);
  assert.equal(read.document!.map.elements.length, 1);
  assert.equal(read.document!.map.anchors.a!.node, "node-gone");
  assert.equal(read.document!.map.anchors.b, undefined);
  assert.deepEqual(
    read.document!.map.elements[0]!.customData as object,
    JSON.parse('{"__proto__":{"kept":true}}'),
  );
  const firstRaw = await adapter.readFile("annotations.json");
  assert.equal(firstRaw.split("\n").filter((l) => l.includes('"id":')).length, 1);
  await writeAnnotations(adapter, { baseEtag: first.etag, document: drawing() });
  assert.equal((await listHistoryChanges(adapter)).length, 1);
  const updated = drawing();
  updated.map.elements[0].x = 80;
  const second = await writeAnnotations(adapter, { baseEtag: first.etag, document: updated });
  await assert.rejects(
    () => writeAnnotations(adapter, { baseEtag: first.etag, document: drawing() }),
    (e: unknown) => e instanceof AnnotationWriteError && e.code === "ETAG_CONFLICT",
  );
  await assert.rejects(
    () => writeAnnotations(adapter, { baseEtag: null, document: drawing() }),
    /Annotations changed/,
  );
  const history = await listHistoryChanges(adapter);
  assert.deepEqual(
    history.map((h) => [h.operation, h.entry, h.objectIds]),
    [
      ["annotations.write", "ui", []],
      ["annotations.write", "ui", []],
    ],
  );
  assert.ok(history.every((h) => h.time === new Date(h.time).toISOString()));
  const from = history[0]!.changes[0]!.after!,
    to = history[1]!.changes[0]!.after!;
  assert.equal((await readDocumentVersion(adapter, from)).raw, firstRaw);
  assert.equal(
    (await readDocumentDiff(adapter, { from, to })).text
      .split("\n")
      .filter((l) => /^[+-]\s+\{"/.test(l)).length,
    2,
  );
  assert.equal(second.etag, (await readAnnotations(adapter)).etag);
  const card = await createCardDocument(adapter, {
    prompt: "Read annotations",
    sources: [{ resource: "/annotations.json" }],
  });
  const sources = parseFrontmatter(await adapter.readFile(card.path)).data.sources as Array<{
    version?: unknown;
  }>;
  assert.equal(
    sources[0]!.version,
    undefined,
    "annotations are a material pointer, not a captured Node/Role source",
  );
  await assert.rejects(
    () => readDocumentVersion(adapter, { ...from, path: "settings.json" }),
    /Not a Tent history document/,
  );
});

test("invalid annotations fail before mutation and concurrent writers cannot both use one basis", async (t) => {
  const { adapter, root } = await fixture(t);
  for (const document of [
    {},
    { ...drawing(), schemaVersion: 2 },
    {
      schemaVersion: 1,
      map: {
        elements: [
          { id: "same", type: "line" },
          { id: "same", type: "text" },
        ],
        anchors: {},
      },
    },
    {
      schemaVersion: 1,
      map: { elements: [{ id: "x", type: "text", value: Infinity }], anchors: {} },
    },
  ]) {
    await assert.rejects(
      async () => writeAnnotations(adapter, { baseEtag: null, document }),
      (e: unknown) => e instanceof AnnotationWriteError && e.code === "INVALID_INPUT",
    );
    assert.equal(await adapter.exists("annotations.json"), false);
  }
  const result = await Promise.allSettled([
    writeAnnotations(adapter, { baseEtag: null, document: drawing() }),
    writeAnnotations(new NodeFs(root, "ui"), { baseEtag: null, document: drawing() }),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await listHistoryChanges(adapter)).length, 1);
  await adapter.writeFile("annotations.json", "broken");
  await assert.rejects(() => readAnnotations(adapter), /Invalid annotations JSON/);
  assert.equal(await adapter.readFile("annotations.json"), "broken");
});

test("workspace revision observes exact external bytes, identity paths, registries and HEAD without capturing", async (t) => {
  const { adapter, env, root } = await fixture(t);
  const revisions = [await readWorkspaceRevision(adapter)];
  await createNode(env, { name: "Alpha", type: "prompt", parentPath: "", body: "one" });
  revisions.push(await readWorkspaceRevision(adapter));
  const file = path.join(root, "Alpha/Alpha.md"),
    stat = await fs.stat(file);
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("one", "two"));
  await fs.utimes(file, stat.atime, stat.mtime);
  const head = await adapter.history.currentCommit();
  revisions.push(await readWorkspaceRevision(adapter));
  assert.equal(await adapter.history.currentCommit(), head);
  for (const [file, raw] of [
    ["roles/role-view.md", "a"],
    ["cards/card-view.md", "a"],
    ["order.json", "{}"],
    ["annotations.json", "{}"],
  ]) {
    await adapter.writeFile(file!, raw!);
    revisions.push(await readWorkspaceRevision(adapter));
  }
  await git(root, "commit", "--allow-empty", "-m", "Empty HEAD move");
  revisions.push(await readWorkspaceRevision(adapter));
  assert.equal(new Set(revisions).size, revisions.length);
  await adapter.writeFile("temp/ignored", "cache");
  assert.equal(await readWorkspaceRevision(adapter), revisions.at(-1));
  await fs.rename(path.join(root, "Alpha"), path.join(root, "Group"));
  assert.notEqual(await readWorkspaceRevision(adapter), revisions.at(-1));
});

test("workspace relations use Markdown occurrences across identities and retained Card targets after moves", async (t) => {
  const { adapter, env, root } = await fixture(t);
  const id = await createNode(env, {
    name: "Alpha",
    type: "prompt",
    parentPath: "",
    body: "[Role](../roles/role-ui.md)\n[external](../../asset.png)\n`[ignored](../roles/role-ui.md)`",
  });
  await adapter.writeFile(
    "roles/role-ui.md",
    serializeFrontmatter(
      {
        id: "role-ui",
        type: "role",
        sources: [{ resource: "description" }, { resource: "./bad%GG" }],
      },
      "[Alpha][ref] and [again][ref]\n\n[ref]: ../Alpha/Alpha.md\n\n![image](../Alpha/Alpha.md)\n[[Alpha]]",
    ),
  );
  const card = await createCardDocument(adapter, {
    prompt: "[Role](../roles/role-ui.md)",
    sources: [{ resource: "/Alpha/Alpha.md", title: "Original" }],
  });
  const before = await git(root, "status", "--porcelain");
  const relations = await listWorkspaceRelations(adapter);
  assert.equal(await git(root, "status", "--porcelain"), before);
  assert.equal(relations.filter((r) => r.from.id === "role-ui" && r.via === "link").length, 2);
  assert.deepEqual(relations.find((r) => r.from.id === id && r.via === "link")!.target, {
    kind: "role",
    id: "role-ui",
  });
  assert.deepEqual(relations.find((r) => r.raw === "../../asset.png")!.target, {
    kind: "file",
    workspacePath: "asset.png",
  });
  assert.equal(relations.find((r) => r.raw === "description")!.target.kind, "unresolved");
  assert.equal(relations.find((r) => r.raw === "./bad%GG")!.target.kind, "invalid");
  const pinned = relations.find((r) => r.from.id === card.cardId && r.via === "sources")!;
  assert.equal(pinned.changedSince, false);
  assert.equal(pinned.title, "Original");
  const role = parseFrontmatter(await adapter.readFile("roles/role-ui.md"));
  role.data.sources = [{ resource: "description" }];
  await adapter.writeFile("roles/role-ui.md", serializeFrontmatter(role.data, role.body));
  await renameNode(env, id, "Beta");
  // A new identity at the old path cannot retarget the Card's retained source.
  await createNode(env, { name: "Alpha", type: "prompt", parentPath: "", body: "Replacement" });
  const after = (await listWorkspaceRelations(adapter)).find(
    (r) => r.from.id === card.cardId && r.via === "sources",
  )!;
  assert.deepEqual(after.target, { kind: "node", id });
  assert.equal(after.changedSince, true);
  const retained = await readDocumentVersion(adapter, pinned.version!);
  assert.equal(parseFrontmatter(retained.raw).data.id, id);
});
