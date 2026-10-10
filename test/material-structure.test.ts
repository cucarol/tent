import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  materialFields,
  materialLocator,
  isPrefixMaterial,
  validateMaterialAddresses,
  rewriteMaterialPaths,
} from "../src/core/material.js";
import { workspaceMaterialFields } from "../src/cli/material-input.js";
import {
  nodeSemanticFingerprint,
  syncMaterialIdentity,
  prepareNodeSyncSave,
} from "../src/core/node-sync-record.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { nodeBasisRecordSchema } from "../src/core/node-basis-record.js";
import { structureFingerprint } from "../src/core/structure-material.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";

test("prefix selectors and explicit tracking preserve address rules", async () => {
  const locator = materialLocator("../../src/card-*", "M/M.md", true);
  assert.equal(isPrefixMaterial(locator), true);
  assert.equal(locator.kind === "path" && locator.target, "../src/card-*");
  assert.equal(isPrefixMaterial(materialLocator("file:///tmp/src/card-%2A", "M/M.md")), true);
  for (const invalid of [
    "../../src/*/a",
    "../../src/a**",
    "../../src/a*b*",
    "../../src/a-*#x",
    "../../src/a-*?x",
    "../../src/a-*/",
  ])
    assert.throws(() => materialLocator(invalid, "M/M.md", true));
  assert.throws(() => materialFields({ sources: [{ resource: "../src/", track: "typo" }] }));
  assert.throws(
    () =>
      validateMaterialAddresses(
        { sources: [{ resource: "../x.ts", track: "structure" }] },
        "index.md",
      ),
    /directory or prefix/,
  );
  assert.throws(
    () =>
      validateMaterialAddresses(
        { sources: [{ resource: "../x.ts", track: "structure" }] },
        "index.md",
        { sources: [{ resource: "../x.ts" }] },
      ),
    /directory or prefix/,
  );
  const fields = await workspaceMaterialFields(
    { sources: [{ resource: "src/card-*", track: "structure" }] },
    "M/M.md",
    process.cwd(),
  );
  assert.deepEqual(fields.sources, [{ resource: "../../src/card-*", track: "structure" }]);
  const data = { sources: [{ resource: "../../src/card-*", track: "structure" }] };
  rewriteMaterialPaths(data, "M/M.md", "Moved/M/M.md", new Map());
  assert.deepEqual(data.sources, [{ resource: "../../../src/card-*", track: "structure" }]);
});

test("track changes meaning and basis identity while ordinary source metadata does not", () => {
  const source = { resource: "../../src/" };
  const content = { sources: [source] };
  const structure = { sources: [{ ...source, track: "structure" }] };
  const original = nodeSemanticFingerprint(content, "rules", "M/M.md");
  assert.equal(
    nodeSemanticFingerprint({ sources: [{ ...source, label: "metadata" }] }, "rules", "M/M.md"),
    original,
  );
  assert.notEqual(nodeSemanticFingerprint(structure, "rules", "M/M.md"), original);
  assert.equal(
    nodeSemanticFingerprint(
      { sources: [{ resource: "../../../src/", track: "structure" }] },
      "rules",
      "Moved/M/M.md",
    ),
    nodeSemanticFingerprint(structure, "rules", "M/M.md"),
  );
  assert.notEqual(
    syncMaterialIdentity(source.resource, "M/M.md"),
    syncMaterialIdentity(source.resource, "M/M.md", undefined, "structure"),
  );
});

test("retained structure dependency sets validate their digest in own and ancestor bases", () => {
  const structureDependencies = ["src/adapter.ts", "src/io/"];
  const material = {
    identity: "structure",
    fingerprintVersion: 2,
    version: structureFingerprint(structureDependencies),
    structureDependencies,
  };
  assert.equal(nodeBasisRecordSchema.safeParse({ v: 1, materials: [material] }).success, true);
  for (const broken of [
    { ...material, version: "0".repeat(64) },
    { ...material, structureDependencies: [...structureDependencies].reverse() },
    { ...material, directoryFiles: [] },
    { ...material, structureDependencies: ["../escape/"] },
  ]) {
    assert.equal(nodeBasisRecordSchema.safeParse({ v: 1, materials: [broken] }).success, false);
    assert.equal(
      nodeBasisRecordSchema.safeParse({
        v: 1,
        materials: [],
        goals: [
          { nodeId: "node-g", fingerprintVersion: 2, version: "a".repeat(64), materials: [broken] },
        ],
      }).success,
      false,
    );
  }
});

test("unavailable structure confirmation retains known and unknown material bases", async () => {
  const adapter = new NodeFs(process.cwd());
  adapter.observeMaterial = async () => {
    throw new Error("Structure unavailable");
  };
  const source = { resource: "../../src/card-*", track: "structure" as const };
  const documentPath = "Module/Module.md";
  const identity = syncMaterialIdentity(source.resource, documentPath, undefined, source.track);
  const raw = serializeFrontmatter(
    { id: "node-material", type: "prompt", sources: [source] },
    "Module\n",
  );
  for (const material of [
    { identity },
    {
      identity,
      fingerprintVersion: 2 as const,
      version: structureFingerprint(["src/other/"]),
      structureDependencies: ["src/other/"],
    },
  ]) {
    const previous = { v: 1 as const, materials: [material] };
    const saved = await prepareNodeSyncSave(adapter, documentPath, raw, {
      confirm: true,
      previous,
      nodes: new Map(),
      records: {},
    });
    assert.deepEqual(saved.record?.materials, previous.materials);
  }
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "material-structure-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(testScratchRoot()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await fs.mkdir(path.join(root, "src/core"), { recursive: true });
  await fs.mkdir(path.join(root, "src/other"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(root, "src/core/card-a.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "src/core/shared.ts"), "export const shared = 1;\n");
  await fs.writeFile(path.join(root, "src/other/api.ts"), "export const api = 1;\n");
  await fs.writeFile(path.join(root, "result.txt"), "evidence\n");
  await git(root, "init", "--quiet");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "test: material fixture");
  await scaffoldInWorkspace(new NodeFs(root), { name: "Materials" });
  const systemRoot = path.join(root, ".tent");
  await git(systemRoot, "init", "--quiet");
  const adapter = new NodeFs(systemRoot);
  const globals = { cwd: root, json: true };
  const run = async (sub: string, args: string[]) => {
    const result = await runNodeCommand(sub, args, globals);
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const confirm = async (id: string) =>
    run("confirm", [id, "--base-etag", (await readNodeForEdit(adapter, id)).etag]);
  return { root, adapter, run, confirm, globals };
}

test("prefix content and structure coexist, and goal confirmation never confirms its output", async (t) => {
  const { root, adapter, run, confirm, globals } = await fixture(t);
  const goal = (
    await run("create", [
      "Module",
      "--type",
      "goal",
      "--sources-json",
      JSON.stringify([{ resource: "src/core/card-*", track: "structure" }]),
    ])
  ).node.nodeId;
  const content = (
    await run("create", ["Content", "--type", "prompt", "--resource", "src/core/card-*"])
  ).node.nodeId;
  const output = (await run("link-output", [goal, "--resource", "result.txt"])).nodeId;
  assert.equal((await run("check", [goal])).state, "synced");
  await fs.writeFile(path.join(root, "src/core/card-a.ts"), "export const value = 2;\n");
  assert.equal((await run("check", [goal])).state, "synced");
  assert.equal((await run("check", [content])).state, "behind");
  await fs.writeFile(path.join(root, "src/core/card-b.ts"), "export const added = true;\n");
  await git(root, "add", "src/core/card-b.ts");
  assert.equal((await run("check", [goal])).state, "synced");
  await fs.writeFile(
    path.join(root, "src/core/card-a.ts"),
    "import { shared } from './shared.js';\nexport const value = shared;\n",
  );
  let check = await run("check", [goal]);
  assert.equal(check.state, "behind");
  assert.deepEqual(check.materials[0].changedDependencies, [
    { target: "src/core/shared.ts", state: "added" },
  ]);
  assert.equal(check.materials[0].changedFiles, undefined);
  const before = await readNodeForEdit(adapter, goal);
  await writeNodeDocument(adapter, goal, {
    baseEtag: before.etag,
    body: "Updated prose without confirming\n",
  });
  assert.equal((await run("check", [goal])).state, "behind");
  await confirm(goal);
  check = await run("check", [output]);
  assert.equal(check.state, "behind");
  assert.deepEqual(
    check.materials.find((m: any) => m.goalId === goal && m.track === "structure")
      .changedDependencies,
    [{ target: "src/core/shared.ts", state: "added" }],
  );
  await confirm(output);
  assert.equal((await run("check", [goal])).state, "synced");
  assert.equal((await run("check", [output])).state, "synced");
  const workspaceCheck = await runWorkspaceCommand("check", [], globals);
  assert.equal(workspaceCheck.exitCode, 0, workspaceCheck.stderr);
  assert.deepEqual(JSON.parse(workspaceCheck.stdout).issues, []);
  assert.deepEqual(JSON.parse(workspaceCheck.stdout).errors, []);
  const current = await readNodeForEdit(adapter, goal);
  await writeNodeDocument(adapter, goal, {
    baseEtag: current.etag,
    frontmatter: { sources: [{ resource: "../../src/core/card-*" }] },
  });
  assert.equal(
    (await run("check", [output])).state,
    "behind",
    "removing track changes the goal even if bytes are unchanged",
  );
});

test("same directory with content and structure declarations retains two independent bases", async (t) => {
  const { root, run } = await fixture(t);
  const id = (
    await run("create", [
      "Both",
      "--type",
      "prompt",
      "--resource",
      "src/core/",
      "--sources-json",
      JSON.stringify([{ resource: "src/core/", track: "structure" }]),
    ])
  ).node.nodeId;
  await fs.writeFile(path.join(root, "src/core/card-a.ts"), "export const value = 99;\n");
  const check = await run("check", [id]);
  assert.equal(check.materials.length, 2);
  assert.equal(check.materials[0].state, "changed");
  assert.equal(check.materials[1].state, "current");
  assert.equal(check.materials[1].track, "structure");
});
