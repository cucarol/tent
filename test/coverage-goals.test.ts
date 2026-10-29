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
import { nodeBasisRecordSchema } from "../src/core/base/node-basis-record.js";
import { createNode, renameNode } from "../src/core/graph/ops.js";
import {
  inspectNodeSync,
  inspectWorkspaceSync,
  confirmNodeSync,
} from "../src/core/graph/node-sync.js";
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
  assert.equal(
    nodeBasisRecordSchema.safeParse({
      v: 1,
      materials: [],
      goalBasis: { version: "bad", fingerprintVersion: 2 },
    }).success,
    false,
  );
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
  const confirm = async (id: string) =>
    confirmNodeSync(adapter, id, { baseEtag: (await readNodeForEdit(adapter, id)).etag });
  const check = (id: string) => inspectNodeSync(openTestFs(system), id);
  return { workspace, system, adapter, env, edit, confirm, check };
}

test("module conversion previews, preserves identity and children, keeps rules and is idempotent", async (t) => {
  const { workspace, system, adapter, env, check } = await fixture(t);
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
  assert.equal((await check(id)).ahead, undefined);
  const committed = await historyHead(system);
  assert.equal((await convertModuleGoals(workspace, [entry], true)).applied, false);
  assert.equal(await historyHead(system), committed);
  assert.equal(closedAdapters.length, 4, "apply and idempotent return release their adapters");
  assert.equal(new Set(closedAdapters).size, 4);
  for (const closed of closedAdapters)
    await assert.rejects(closed.readFile("index.md"), /connection is closed/);
});

test("group goals acquire their own intent basis from the final batch's descendant goals", async (t) => {
  const { workspace, adapter, env, edit, confirm, check } = await fixture(t);
  const created = await writeNodesBatch(env, {
    items: [
      { op: "create", ref: "group", name: "Group", type: "goal", body: "Overall intent\n" },
      {
        op: "create",
        ref: "nested",
        parent: "@group",
        name: "Nested",
        type: "goal",
        body: "Nested intent\n",
      },
      {
        op: "create",
        ref: "bridge",
        parent: "@nested",
        name: "Bridge",
        type: "prompt",
        body: "Rules\n",
      },
      {
        op: "create",
        ref: "leaf",
        parent: "@bridge",
        name: "Leaf",
        type: "goal",
        body: "Leaf intent\n",
        resource: pathToFileURL(workspace + "/src/").href,
      },
    ],
  });
  const [group, nested, bridge, leaf] = created.results.map((result) => result.nodeId);
  const records = await adapter.history.nodeRecords();
  for (const id of [group!, nested!, leaf!]) {
    assert.ok(records[id]?.goalBasis);
    assert.equal((await check(id)).ahead, undefined);
  }
  assert.equal(records[bridge!]?.goalBasis, undefined);
  await edit(group!, { body: "Changed group intent\n" });
  assert.ok((await check(group!)).ahead);
  assert.equal((await check(nested!)).ahead, undefined);
  await confirm(group!);
  assert.equal((await check(group!)).ahead, undefined);
  const baseline = (await adapter.history.nodeRecords())[group!]!.goalBasis;
  const current = await readNodeForEdit(adapter, group!);
  await adapter.writeFile(
    `${current.path}/${current.name}.md`,
    current.raw.replace("Changed group intent", "Native group intent"),
  );
  await captureNativeNodeEdits(adapter);
  assert.deepEqual((await adapter.history.nodeRecords())[group!]!.goalBasis, baseline);
  assert.ok((await check(group!)).ahead);
  await edit(leaf!, { frontmatter: { status: "deprecated" } });
  await confirm(group!);
  assert.ok(
    (await check(group!)).ahead,
    "a deprecated descendant cannot make an otherwise ordinary goal a coverage group",
  );
});

test("adding a coverage child never invents its existing group's missing basis", async (t) => {
  const { workspace, env, adapter, edit, confirm, check } = await fixture(t);
  const group = await createNode(env, {
    parentPath: "",
    name: "Group",
    type: "goal",
    body: "Group intent\n",
  });
  const child = await createNode(env, {
    parentPath: "Group",
    name: "Leaf",
    type: "prompt",
    resource: pathToFileURL(workspace + "/src/").href,
  });
  await confirm(group);
  assert.equal((await adapter.history.nodeRecords())[group]?.goalBasis, undefined);
  await edit(child, { frontmatter: { type: "goal" }, confirm: true });
  assert.equal((await adapter.history.nodeRecords())[group]?.goalBasis, undefined);
  assert.ok((await check(group)).ahead);
  await confirm(group);
  assert.ok((await adapter.history.nodeRecords())[group]?.goalBasis);
  assert.equal((await check(group)).ahead, undefined);
  await edit(group, { body: "New group intent\n" });
  assert.ok((await check(group)).ahead);
  await createNode(env, {
    parentPath: "Group/Leaf",
    name: "Done",
    type: "output",
    body: "Current result\n",
  });
  assert.equal((await check(group)).ahead, undefined);
});

test("final batch deprecation cannot establish a grouping basis for a later ordinary restoration", async (t) => {
  const { adapter, env, edit, check } = await fixture(t);
  const group = await createNode(env, {
    parentPath: "",
    name: "Group",
    type: "goal",
    body: "Group intent",
  });
  const leaf = await createNode(env, {
    parentPath: "Group",
    name: "Part",
    type: "goal",
    resource: "../../../src/",
  });
  assert.equal((await adapter.history.nodeRecords())[group]?.goalBasis, undefined);
  const groupBefore = await readNodeForEdit(adapter, group);
  const leafBefore = await readNodeForEdit(adapter, leaf);
  await writeNodesBatch(env, {
    items: [
      { op: "update", nodeId: group, baseEtag: groupBefore.etag, confirm: true },
      {
        op: "update",
        nodeId: leaf,
        baseEtag: leafBefore.etag,
        frontmatter: { status: "deprecated" },
      },
    ],
  });
  assert.equal((await adapter.history.nodeRecords())[group]?.goalBasis, undefined);
  assert.ok((await check(group)).ahead);
  await edit(leaf, { frontmatter: { status: "stable" } });
  assert.equal((await adapter.history.nodeRecords())[group]?.goalBasis, undefined);
  assert.ok((await check(group)).ahead, "ordinary restoration must not confirm the parent");
});

test("deprecated intermediary preserves the active descendant scope of a grouping goal", async (t) => {
  const { adapter, env, edit, confirm, check } = await fixture(t);
  const group = await createNode(env, {
    parentPath: "",
    name: "Group",
    type: "goal",
    body: "Group intent",
  });
  const bridge = await createNode(env, {
    parentPath: "Group",
    name: "Bridge",
    type: "prompt",
    body: "Local rules",
  });
  const leaf = await createNode(env, {
    parentPath: "Group/Bridge",
    name: "Part",
    type: "goal",
    resource: "../../../../src/",
  });
  await edit(bridge, { frontmatter: { status: "deprecated" } });
  await confirm(group);
  assert.ok((await adapter.history.nodeRecords())[group]?.goalBasis);
  assert.equal((await adapter.history.nodeRecords())[bridge]?.goalBasis, undefined);
  assert.equal((await check(group)).ahead, undefined);
  assert.equal((await check(leaf)).state, "synced");
});

test("conversion can confirm a grouping prompt with children converted in the same batch", async (t) => {
  const { workspace, env, adapter, check } = await fixture(t);
  const group = await createNode(env, {
    parentPath: "",
    name: "Core",
    type: "prompt",
    body: "Core rules\n",
  });
  const leaf = await createNode(env, {
    parentPath: "Core",
    name: "Part",
    type: "prompt",
    body: "Part rules\n",
    resource: pathToFileURL(workspace + "/src/").href,
  });
  const entries = [];
  for (const id of [group, leaf]) {
    const current = await readNodeForEdit(adapter, id);
    entries.push({
      nodeId: id,
      baseEtag: current.etag,
      goalBody: `${current.name} intent\n`,
      rulesName: `${current.name} rules`,
      rulesTags: ["spec"],
      rulesBody: childRulesBody(current.body),
    });
  }
  await convertModuleGoals(workspace, entries, true);
  for (const id of [group, leaf]) {
    assert.ok((await adapter.history.nodeRecords())[id]?.goalBasis);
    assert.equal((await check(id)).ahead, undefined);
  }
  assert.equal((await convertModuleGoals(workspace, entries, true)).applied, false);
});

test("coverage goal intent survives ordinary and native saves; confirmation or matching output clears ahead", async (t) => {
  const { system, adapter, env, edit, confirm, check } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Code",
    type: "goal",
    body: "Purpose A\n",
    sources: [{ resource: "../../src/" }],
  });
  const original = (await adapter.history.nodeRecords())[id]!.goalBasis;
  assert.ok(original);
  assert.equal((await check(id)).state, "synced");
  assert.deepEqual((await inspectWorkspaceSync(adapter)).requirementsWithoutOutputs, []);
  await edit(id, { frontmatter: { tags: ["custom", "topic"] } });
  assert.equal((await check(id)).ahead, undefined);
  await renameNode(env, id, "Renamed");
  assert.equal((await check(id)).ahead, undefined);
  await edit(id, { body: "Purpose B\n" });
  assert.ok((await check(id)).ahead);
  assert.deepEqual((await adapter.history.nodeRecords())[id]!.goalBasis, original);
  const raw = await adapter.readFile("Renamed/Renamed.md");
  await adapter.writeFile("Renamed/Renamed.md", raw.replace("Purpose B", "Purpose C"));
  assert.deepEqual((await captureNativeNodeEdits(adapter)).invalidNodes, []);
  assert.deepEqual((await adapter.history.nodeRecords())[id]!.goalBasis, original);
  assert.ok((await check(id)).ahead);
  const output = await createNode(env, {
    parentPath: "Renamed",
    name: "Evidence",
    type: "output",
    body: "Observed C",
  });
  assert.equal((await check(id)).ahead, undefined);
  assert.deepEqual((await adapter.history.nodeRecords())[id]!.goalBasis, original);
  await edit(id, { body: "Purpose D\n" });
  assert.ok((await check(id)).ahead);
  await confirm(id);
  assert.equal((await check(id)).ahead, undefined);
  assert.ok((await check(output)).materials.some((m) => m.goalId === id && m.state === "changed"));
  const confirmed = (await adapter.history.nodeRecords())[id]!.goalBasis;
  await edit(id, { frontmatter: { sources: [{ resource: "../../shared/" }] } });
  assert.ok((await check(id)).ahead);
  assert.deepEqual((await adapter.history.nodeRecords())[id]!.goalBasis, confirmed);
  const seen = await readNodeForEdit(adapter, id);
  await writeNodesBatch(env, {
    items: [{ op: "update", nodeId: id, baseEtag: seen.etag, body: "Purpose E\n", confirm: true }],
  });
  assert.equal((await check(id)).ahead, undefined);
  const head = await historyHead(system);
  await check(id);
  assert.equal(await historyHead(system), head);
});

test("type conversion requires explicit intent confirmation and file goals still need outputs", async (t) => {
  const { adapter, env, edit, confirm, check } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Old",
    type: "prompt",
    body: "Existing purpose",
    resource: "../../src/",
  });
  await edit(id, { frontmatter: { type: "goal" } });
  assert.equal((await adapter.history.nodeRecords())[id]!.goalBasis, undefined);
  assert.ok((await check(id)).ahead);
  await edit(id, { body: "Reviewed purpose" });
  assert.ok((await check(id)).ahead);
  await confirm(id);
  assert.equal((await check(id)).ahead, undefined);
  const file = await createNode(env, {
    parentPath: "",
    name: "Requirement",
    type: "goal",
    resource: "../../src/a.ts",
  });
  await confirm(file);
  assert.ok((await check(file)).ahead);
  assert.equal((await adapter.history.nodeRecords())[file]!.goalBasis, undefined);
  assert.deepEqual((await inspectWorkspaceSync(adapter)).requirementsWithoutOutputs, [file]);
});

test("matching intent does not clear structural behind and an edited intent can be ahead at the same time", async (t) => {
  const { workspace, env, edit, check, confirm } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Module",
    type: "goal",
    body: "Expose A",
    sources: [{ resource: "../../src/", track: "structure" }],
  });
  assert.equal((await check(id)).state, "synced");
  await fs.writeFile(path.join(workspace, "src/a.ts"), "export { b } from '../shared/b';\n");
  assert.ok((await check(id)).behind);
  assert.equal((await check(id)).ahead, undefined);
  await edit(id, { body: "Expose B" });
  const changed = await check(id);
  assert.ok(changed.ahead);
  assert.ok(changed.behind);
  await confirm(id);
  const cleared = await check(id);
  assert.equal(cleared.ahead, undefined);
  assert.equal(cleared.behind, undefined);
});
