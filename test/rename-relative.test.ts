import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { checkGraph } from "../src/core/check/graph-check.js";
import { buildNodeIndex } from "../src/core/base/okf.js";
import { resolveOutLink } from "../src/core/base/links.js";
import { createNode, renameNode } from "../src/core/graph/ops.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { loadTent } from "../src/core/store/tree.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "rename-relative-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  const adapter = openTestFs(path.join(workspace, ".tent"));
  await scaffoldTent(adapter, { name: "x" });
  let n = 0;
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-29T00:00:00.000Z" },
    tentName: "x",
    rand: () => (++n * 0.17) % 1,
  };
  const create = (parentPath: string, name: string) =>
    createNode(env, { parentPath, name, type: "prompt" });
  const write = (file: string, id: string, body: string) =>
    adapter.writeFile(file, `---\nid: ${id}\ntype: prompt\n---\n\n${body}`);
  const checkLinks = async () => {
    const result = await checkGraph(adapter, workspace, async (filename, directory = false) => {
      try {
        const stat = await fs.stat(filename);
        return directory ? stat.isDirectory() : stat.isFile();
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)))
          return false;
        throw error;
      }
    });
    assert.deepEqual(result.errors, []);
    return result.issues.filter((issue) => issue.kind === "unresolved-link");
  };
  return { adapter, env, create, write, checkLinks };
}

test("renameNode preserves valid document-relative child links without a dot prefix", async (t) => {
  const { adapter, env, create, write, checkLinks } = await fixture(t);
  const owner = await create("", "Owner");
  await create("", "清单");
  const oldName = "清单20261029";
  const target = await create("Owner", oldName);
  const encoded = encodeURIComponent(oldName);
  const body = [
    `[Child](${oldName}/${oldName}.md)`,
    `[Encoded][child]`,
    ``,
    `[child]: <${encoded}/${encoded}.md?mode=read#%E7%8A%B6%E6%80%81> "Keep title"`,
    `[Explicit](./${oldName}/${oldName}.md)`,
    `[Bundle](/Owner/${oldName}/${oldName}.md)`,
    `[Stable](${target}) [Remote](https://example.com/${oldName}) [Anchor](#local)`,
    `\`[Example](${oldName}/${oldName}.md)\``,
    ``,
  ].join("\n");
  await write("Owner/Owner.md", owner, body);
  assert.deepEqual(await checkLinks(), [], "the original document-relative links are valid");

  await renameNode(env, target, "清单");

  assert.deepEqual(await checkLinks(), [], "rename must not introduce unresolved links");
  const after = (await loadTent(adapter)).byId.get(owner)!.body;
  const tree = await loadTent(adapter);
  assert.equal(
    resolveOutLink(
      buildNodeIndex(tree.byPath.values()),
      { raw: after.match(/\[Child\]\(([^)]+)\)/)![1]!, kind: "md" },
      "Owner/Owner.md",
    ).targetNodeId,
    target,
    "a renamed local child must not switch to a root shorthand with the new name",
  );
  assert.ok(after.includes("[Child](./清单/清单.md)"));
  assert.ok(
    after.includes(
      '<./%E6%B8%85%E5%8D%95/%E6%B8%85%E5%8D%95.md?mode=read#%E7%8A%B6%E6%80%81> "Keep title"',
    ),
  );
  assert.ok(after.includes("[Explicit](./清单/清单.md)"));
  assert.ok(after.includes("[Bundle](/Owner/清单/清单.md)"));
  assert.ok(
    after.includes(`[Stable](${target}) [Remote](https://example.com/${oldName}) [Anchor](#local)`),
  );
  assert.ok(after.includes(`\`[Example](${oldName}/${oldName}.md)\``));

  await renameNode(env, owner, "OwnerNew");
  assert.deepEqual(await checkLinks(), [], "moving the author and its child keeps the links valid");
  assert.equal(
    (await loadTent(adapter)).byId.get(owner)!.body,
    after.replace("/Owner/", "/OwnerNew/"),
    "document-relative destinations keep their original relation and style",
  );
});

test("renameNode keeps root shorthand precedence over a colliding local child path", async (t) => {
  const { adapter, env, create, write, checkLinks } = await fixture(t);
  const root = await create("", "Child20261029");
  const owner = await create("", "Owner");
  const child = await create("Owner", "Child20261029");
  const body = "[Root](Child20261029/Child20261029.md)\n";
  await write("Owner/Owner.md", owner, body);
  const savedBody = (await loadTent(adapter)).byId.get(owner)!.body;
  const resolve = async () => {
    const tree = await loadTent(adapter);
    const raw = tree.byId.get(owner)!.body.match(/\[Root\]\(([^)]+)\)/)![1]!;
    return resolveOutLink(
      buildNodeIndex(tree.byPath.values()),
      { raw, kind: "md" },
      "Owner/Owner.md",
    );
  };
  assert.equal((await resolve()).targetNodeId, root);
  assert.deepEqual(await checkLinks(), []);
  await renameNode(env, child, "Local");
  assert.equal((await loadTent(adapter)).byId.get(owner)!.body, savedBody);
  assert.equal((await resolve()).targetNodeId, root);
  await renameNode(env, root, "Root");
  assert.equal(
    (await loadTent(adapter)).byId.get(owner)!.body,
    savedBody.replaceAll("Child20261029", "Root"),
  );
  assert.equal((await resolve()).targetNodeId, root);
  assert.deepEqual(await checkLinks(), []);
});
