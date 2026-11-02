import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFs } from "../src/fs/node-fs.js";
import { isCoverageGoal } from "../src/core/base/material-coverage.js";
import { createNode, renameNode } from "../src/core/graph/ops.js";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { writeNodesBatch } from "../src/core/write/node-write-batch.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { childRulesBody, convertModuleGoals } from "../scripts/one-off/convert-module-goals.js";

test("coverage goals use Workspace directories and prefixes, never reference files or Tent documents", () => {
  const root = path.resolve(testScratchRoot(), "coverage-domain");
  const own = "Goal/Goal.md";
  for (const resource of ["../../src/", "../../src/code-*", pathToFileURL(root + "/docs/").href]) {
    assert.equal(isCoverageGoal({ type: "goal", resource }, own, root), true);
    assert.equal(isCoverageGoal({ type: "goal", sources: [{ resource }] }, own, root), true);
    assert.equal(isCoverageGoal({ type: "prompt", resource }, own, root), false);
  }
  for (const resource of [
    "../../src/code.ts",
    "../Other/Other.md",
    "../roles/role-main.md",
    "../Other/",
    "https://example.com/code/",
    "../../src/a*b*",
    "../../src/../.tent/",
    "../../src/a-*#part",
    pathToFileURL(path.resolve(root, "../external/")).href + "/",
  ])
    assert.equal(isCoverageGoal({ type: "goal", resource }, own, root), false, resource);
  assert.equal(isCoverageGoal({ type: "goal", resource: "../../src/" }, own, undefined), false);
});

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "coverage-goals-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await git(workspace, "init", "-b", "main");
  await scaffoldInWorkspace(openTestFs(workspace), { name: "Coverage" });
  await fs.writeFile(path.join(workspace, ".tent/.gitignore"), "*\n");
  const system = path.join(workspace, ".tent");
  await initializeFixtureHistory(system);
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "shared"));
  await fs.writeFile(path.join(workspace, "src/a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(workspace, "shared/b.ts"), "export const b = 2;\n");
  const adapter = openTestFs(system);
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-17T00:00:00.000Z" },
    tentName: "Coverage",
  };
  const edit = async (id: string, changes: Parameters<typeof writeNodeDocument>[2]) =>
    writeNodeDocument(adapter, id, {
      baseEtag: (await readNodeForEdit(adapter, id)).etag,
      ...changes,
    });
  return { workspace, system, adapter, env, edit };
}

test("module conversion previews, preserves identity and children, keeps rules and is idempotent", async (t) => {
  const { workspace, system, adapter, env } = await fixture(t);
  const closedAdapters: NodeFs[] = [],
    close = NodeFs.prototype.close;
  t.mock.method(NodeFs.prototype, "close", async function (this: NodeFs) {
    await close.call(this);
    closedAdapters.push(this);
  });
  const body =
    "Rules\n\n[File](../../src/a.ts#part) and [root](/Other/Other.md) and [web](https://example.com/).\n\n[ref][1]\n\n[1]: ../../shared/b.ts\n";
  const id = await createNode(env, {
    parentPath: "",
    name: "Module",
    type: "prompt",
    sources: [{ resource: "../../src/" }],
    body,
  });
  const childId = await createNode(env, {
    parentPath: "Module",
    name: "Existing",
    type: "prompt",
    body: "Preserve me\n",
  });
  const before = await readNodeForEdit(adapter, id);
  const childBefore = await readNodeForEdit(adapter, childId);
  const head = await historyHead(system);
  const entry = {
    nodeId: id,
    baseEtag: before.etag,
    goalBody: "Own this code and its intent.\n",
    rulesName: "Rules",
    rulesTags: ["spec", "core"],
    rulesBody: childRulesBody(body),
  };
  assert.match(entry.rulesBody, /\(\.\.\/\.\.\/\.\.\/src\/a.ts#part\)/);
  assert.match(entry.rulesBody, /\[1\]: \.\.\/\.\.\/\.\.\/shared\/b.ts/);
  assert.match(entry.rulesBody, /\(\/Other\/Other.md\)/);
  const dry = await convertModuleGoals(workspace, [entry]);
  assert.equal(dry.applied, false);
  assert.equal(await historyHead(system), head);
  assert.equal((await readNodeForEdit(adapter, id)).raw, before.raw);
  await assert.rejects(
    convertModuleGoals(workspace, [{ ...entry, baseEtag: "stale" }], true),
    /Stale manifest/,
  );
  assert.equal(closedAdapters.length, 2, "dry-run and rejected manifest release their adapters");
  const applied = await convertModuleGoals(workspace, [entry], true);
  assert.equal(applied.applied, true);
  const after = await readNodeForEdit(adapter, id);
  assert.equal(after.type, "goal");
  assert.equal(after.path, before.path);
  assert.deepEqual(after.frontmatter.sources, before.frontmatter.sources);
  assert.equal((await readNodeForEdit(adapter, childId)).raw, childBefore.raw);
  const committed = await historyHead(system);
  assert.equal((await convertModuleGoals(workspace, [entry], true)).applied, false);
  assert.equal(await historyHead(system), committed);
  assert.equal(closedAdapters.length, 4, "apply and idempotent return release their adapters");
  assert.equal(new Set(closedAdapters).size, 4);
  for (const closed of closedAdapters)
    await assert.rejects(closed.readFile("index.md"), /connection is closed/);
});
