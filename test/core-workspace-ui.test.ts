import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode, renameNode } from "../src/core/ops.js";
import { readWorkspaceRevision } from "../src/core/workspace-revision.js";
import { listWorkspaceRelations } from "../src/core/workspace-relations.js";
import { readDocumentVersion } from "../src/core/document-diff.js";
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

test("workspace revision keeps deterministic bytes while bounded reads complete out of order", async (t) => {
  const { adapter } = await fixture(t);
  for (let index = 0; index < 17; index++)
    await adapter.writeFile(`roles/role-${String(index).padStart(2, "0")}.md`, `role ${index}\n`);
  const expected = await readWorkspaceRevision(adapter);
  const original = adapter.readBinary.bind(adapter);
  let active = 0,
    maximum = 0;
  const finished: string[] = [];
  adapter.readBinary = async (file) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, file.endsWith("00.md") ? 40 : 1));
      const bytes = await original(file);
      finished.push(file);
      return bytes;
    } finally {
      active--;
    }
  };
  assert.equal(await readWorkspaceRevision(adapter), expected);
  assert.ok(maximum > 1 && maximum <= 8);
  assert.ok(finished.indexOf("roles/role-01.md") < finished.indexOf("roles/role-00.md"));
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
