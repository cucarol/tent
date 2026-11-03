import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { initializeFixtureWorkspace } from "./scratch.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode } from "../src/core/graph/ops.js";
import { listWorkspaceRelations } from "../src/core/graph/workspace-relations.js";
import { createCardDocument } from "../src/core/graph/card-document.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "workspace-relations-"));
  t.after(async () => {
    assert.equal(path.dirname(workspace), path.resolve(testScratchRoot()));
    await removeTestFixture(workspace, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    });
  });
  await initializeFixtureWorkspace(workspace);
  const root = path.join(workspace, ".tent");
  const adapter = openTestFs(root);
  const env = {
    fs: adapter,
    tentRoot: root,
    tentName: "Relations",
    clock: { now: () => new Date().toISOString() },
  };
  return { workspace, root, adapter, env };
}

test("workspace relations use Markdown occurrences across identities and Card source addresses", async (t) => {
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
    target: "role-ui",
    sources: [{ resource: "/Alpha/Alpha.md", title: "Original" }],
  });
  const before = await fs.readFile(path.join(root, ".git/history.sqlite"), "hex");
  const relations = await listWorkspaceRelations(adapter);
  assert.equal(await fs.readFile(path.join(root, ".git/history.sqlite"), "hex"), before);
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
  const source = relations.find((r) => r.from.id === card.cardId && r.via === "sources")!;
  assert.deepEqual(source.target, { kind: "node", id });
  assert.equal(source.title, "Original");
});
