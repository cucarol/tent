import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import {
  materialFields,
  materialLocator,
  isPrefixMaterial,
  validateMaterialAddresses,
  rewriteMaterialPaths,
} from "../src/core/base/material.js";
import { workspaceMaterialFields } from "../src/cli/material-input.js";
import {
  nodeSemanticFingerprint,
  syncMaterialIdentity,
  prepareNodeSyncSave,
} from "../src/core/graph/node-sync-record.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { nodeBasisRecordSchema } from "../src/core/base/node-basis-record.js";
import { structureFingerprint } from "../src/core/base/structure-material.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import {
  observeStructureMaterial,
  withStructureSnapshot,
} from "../src/fs/structure-observation.js";

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
  assert.equal(
    nodeBasisRecordSchema.safeParse({
      v: 1,
      materials: [{ ...material, directoryFiles: "old malformed extension" }],
    }).success,
    true,
  );
  for (const broken of [
    { ...material, version: "0".repeat(64) },
    { ...material, structureDependencies: [...structureDependencies].reverse() },
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
  const adapter = openTestFs(process.cwd());
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
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
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
  await scaffoldInWorkspace(openTestFs(root), { name: "Materials" });
  const systemRoot = path.join(root, ".tent");
  await initializeFixtureHistory(systemRoot);
  const adapter = openTestFs(systemRoot);
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

test("Rust structure members read supporting Cargo/module context and retain unresolved diagnostics", async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, "src/consumer"), { recursive: true });
  await fs.writeFile(path.join(root, "Cargo.toml"), '[package]\nname="sample"\nedition="2021"');
  await fs.writeFile(path.join(root, "src/lib.rs"), "pub mod api; pub mod consumer;");
  await fs.writeFile(path.join(root, "src/api.rs"), "pub struct Api;");
  await fs.writeFile(path.join(root, "src/consumer/mod.rs"), "use crate::api::Api;");
  await git(root, "add", ".");
  const observe = () => observeStructureMaterial(root, "Module/Module.md", "../../src/consumer/");
  const result = await withStructureSnapshot(observe);
  assert.deepEqual(result.structureDependencies, ["src/"]);
  await fs.writeFile(path.join(root, "src/consumer/mod.rs"), "use crate::api::Missing;");
  await assert.rejects(
    withStructureSnapshot(observe),
    /Structure unavailable: src\/consumer\/mod.rs/,
  );
  await fs.writeFile(path.join(root, "src/consumer/mod.rs"), "use crate::api::Api;");
  await fs.writeFile(path.join(root, "Cargo.toml"), "[invalid");
  await assert.rejects(withStructureSnapshot(observe), /Cargo configuration/);
});

test("non-Rust and empty structure materials ignore intentionally unread Rust context", async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, "web"), { recursive: true });
  await fs.writeFile(
    path.join(root, "web/a.ts"),
    'import "../src/other/api"; import "../src/lib.rs?raw";',
  );
  await fs.writeFile(path.join(root, "Cargo.toml"), '[package]\nname="sample"\nedition="2021"');
  await fs.writeFile(path.join(root, "src/lib.rs"), Buffer.from([0xff, 0xfe]));
  await git(root, "add", ".");
  const web = await withStructureSnapshot(() =>
    observeStructureMaterial(root, "Module/Module.md", "../../web/"),
  );
  assert.deepEqual(web.structureDependencies, ["src/", "src/other/"]);
  const empty = await withStructureSnapshot(() =>
    observeStructureMaterial(root, "Module/Module.md", "../../web/missing-*"),
  );
  assert.deepEqual(empty.structureDependencies, []);
});

test("Rust narrow materials ignore independent package bytes but preserve required ancestor failures", async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, "src/consumer"), { recursive: true });
  await fs.mkdir(path.join(root, "tools/unrelated"), { recursive: true });
  await fs.writeFile(path.join(root, "Cargo.toml"), '[package]\nname="sample"\nedition="2021"');
  await fs.writeFile(path.join(root, "src/lib.rs"), "pub mod api; pub mod consumer;");
  await fs.writeFile(path.join(root, "src/api.rs"), "pub struct Api;");
  await fs.writeFile(path.join(root, "src/consumer/mod.rs"), "use crate::api::Api;");
  await git(root, "add", ".");
  const observe = () =>
    withStructureSnapshot(() =>
      observeStructureMaterial(root, "Module/Module.md", "../../src/consumer/"),
    );
  assert.deepEqual((await observe()).structureDependencies, ["src/"]);
  await fs.writeFile(path.join(root, "tools/unrelated/Cargo.toml"), "[invalid");
  await fs.writeFile(path.join(root, "tools/unrelated/broken.rs"), Buffer.from([0xff, 0xfe, 0]));
  await fs.writeFile(path.join(root, "src/lib.rs"), "pub mod api; pub mod consumer; mod unused;");
  await fs.writeFile(path.join(root, "src/unused.rs"), Buffer.from([0xff, 0xfe]));
  assert.deepEqual((await observe()).structureDependencies, ["src/"]);
  await fs.writeFile(path.join(root, "src/lib.rs"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(observe, /encoded data|valid text/i);
});

test("Rust declared path dependency configuration and used source bytes remain required", async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, "src/consumer"), { recursive: true });
  await fs.mkdir(path.join(root, "deps/helper/src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname="sample"\nedition="2021"\n[dependencies]\nhelper={path="deps/helper"}',
  );
  await fs.writeFile(path.join(root, "src/lib.rs"), "pub mod consumer;");
  await fs.writeFile(path.join(root, "src/consumer/mod.rs"), "use helper::Api;");
  const helperCargo = path.join(root, "deps/helper/Cargo.toml");
  const helperSource = path.join(root, "deps/helper/src/lib.rs");
  const manifest = '[package]\nname="helper"\nedition="2021"';
  await fs.writeFile(helperCargo, manifest);
  await fs.writeFile(helperSource, "pub struct Api;");
  await git(root, "add", ".");
  const observe = () =>
    withStructureSnapshot(() =>
      observeStructureMaterial(root, "Module/Module.md", "../../src/consumer/"),
    );
  assert.deepEqual((await observe()).structureDependencies, ["deps/helper/src/"]);
  await fs.writeFile(helperCargo, "[invalid");
  await assert.rejects(observe, /Cargo configuration/);
  await fs.writeFile(helperCargo, manifest);
  await fs.writeFile(helperSource, Buffer.from([0xff, 0xfe]));
  await assert.rejects(observe, /encoded data|valid text/i);
});

test("prefix coverage and structure coexist, and goal confirmation never confirms its output", async (t) => {
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
  assert.equal((await run("check", [content])).state, "unanchored");
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
  assert.equal(check.state, "synced");
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
    !!(await run("check", [goal])).ahead,
    true,
    "removing track changes the goal even if bytes are unchanged",
  );
});

test("same directory with coverage and structure declarations retains only the structure basis", async (t) => {
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
  assert.equal(check.materials.length, 1);
  assert.equal(check.materials[0].state, "current");
  assert.equal(check.materials[0].track, "structure");
});

test("one Node excludes its structure-source union while retaining each material basis", async (t) => {
  const { root, adapter, run, confirm } = await fixture(t);
  await fs.writeFile(path.join(root, "src/core/role-a.ts"), "export const role = 1;\n");
  const goal = (
    await run("create", [
      "Union",
      "--type",
      "goal",
      "--sources-json",
      JSON.stringify([
        { resource: "src/core/card-*", track: "structure" },
        { resource: "src/core/role-*", track: "structure" },
        { resource: "src/other/" },
      ]),
    ])
  ).node.nodeId;
  const separate = (
    await run("create", [
      "Separate",
      "--type",
      "prompt",
      "--sources-json",
      JSON.stringify([{ resource: "src/core/card-*", track: "structure" }]),
    ])
  ).node.nodeId;
  const output = (await run("link-output", [goal, "--resource", "result.txt"])).nodeId;
  await fs.writeFile(path.join(root, "src/core/card-a.ts"), 'import "./role-a.js";\n');
  await fs.writeFile(path.join(root, "src/core/role-a.ts"), 'import "./card-a.js";\n');
  let check = await run("check", [goal]);
  assert.equal(check.state, "synced");
  assert.equal(check.materials.length, 2);
  assert.ok(check.materials.every((material: any) => material.state === "current"));
  assert.equal((await run("check", [output])).state, "synced");
  assert.equal((await run("check", [separate])).state, "behind");

  await fs.writeFile(
    path.join(root, "src/core/card-a.ts"),
    'import "./role-a.js"; import "./shared.js"; import "../other/api.js";\n',
  );
  check = await run("check", [goal]);
  assert.equal(check.state, "behind");
  const cardMaterial = check.materials.find((material: any) =>
    material.resource.endsWith("card-*"),
  );
  assert.deepEqual(cardMaterial.changedDependencies, [
    { target: "src/core/shared.ts", state: "added" },
    { target: "src/other/", state: "added" },
  ]);
  assert.equal(
    check.materials.find((material: any) => material.resource.endsWith("role-*")).state,
    "current",
  );
  const current = await readNodeForEdit(adapter, goal);
  await writeNodeDocument(adapter, goal, { baseEtag: current.etag, body: "Keep existing bases\n" });
  check = await run("check", [goal]);
  assert.equal(check.state, "behind");
  assert.ok(check.ahead, "editing intent still requires review while structure is behind");
  await confirm(goal);
  check = await run("check", [goal]);
  assert.equal(check.state, "synced");
  assert.equal(check.ahead, undefined, "confirmation records the coverage goal's own intent");
  assert.ok(check.materials.every((material: any) => material.state === "current"));
  assert.equal((await run("check", [output])).state, "synced");
  assert.ok(
    (await run("check", [output])).materials.some((material: any) => material.state === "changed"),
  );
});
