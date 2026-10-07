import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode, moveNode, renameNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { writeNodesBatch } from "../src/core/node-write-batch.js";
import { confirmNodeSync, inspectNodeSync, linkNodeOutput } from "../src/core/node-sync.js";
import { migrateNodeRecords } from "../src/core/node-record-migration.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { nodeNotePath } from "../src/core/paths.js";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";
import { nodeSemanticFingerprint } from "../src/core/node-sync-record.js";
import type { CatalogNode } from "../src/core/node-catalog.js";

test("goal versions retain link query and anchor semantics while Node paths relocate", () => {
  const node = { nodeId: "node-target", path: "Target" } as CatalogNode;
  const moved = { ...node, path: "Moved/Target" };
  const before = new Map([[node.nodeId, node]]),
    after = new Map([[moved.nodeId, moved]]);
  const fingerprint = (body: string, nodes = before) =>
    nodeSemanticFingerprint({ type: "goal" }, body, "Goal/Goal.md", nodes);
  const original = fingerprint("[target](../Target/Target.md#first)");
  assert.notEqual(original, fingerprint("[target](../Target/Target.md#second)"));
  assert.notEqual(original, fingerprint("[target](../Target/Target.md?query=1#first)"));
  assert.equal(original, fingerprint("[target](../Moved/Target/Target.md#first)", after));
});

async function fixture(t: TestContext) {
  await fs.mkdir(testScratchRoot(), { recursive: true });
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-records-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Records" });
  const system = path.join(root, ".tent"),
    adapter = new NodeFs(system);
  await git(system, "init", "--initial-branch=main");
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-05T00:00:00.000Z" },
    tentName: "Records",
  };
  const material = path.join(root, "material.txt");
  await fs.writeFile(material, "v1");
  const resource = pathToFileURL(material).href;
  return { root, system, adapter, env, material, resource };
}

test("first intent time comes from retained identity history including manual commits and survives rename", async (t) => {
  const { adapter, system, env } = await fixture(t);
  const id = "node-intent";
  await adapter.mkdir("Intent");
  await adapter.writeFile(
    "Intent/Intent.md",
    serializeFrontmatter({ id, type: "goal" }, "original intent"),
  );
  await git(system, "-c", "core.autocrlf=false", "add", "--", "Intent/Intent.md");
  await git(system, "commit", "-m", "User intent");
  const head = await adapter.history.currentCommit(),
    expected = await adapter.history.commitTime(head!);
  assert.equal((await inspectNodeSync(adapter, id)).aheadSince, expected);
  await renameNode(env, id, "Renamed Intent");
  assert.equal((await inspectNodeSync(adapter, id)).aheadSince, expected);
});

test("Node and material baselines are one commit, read capture retains them, reset rolls both back", async (t) => {
  const { adapter, system, env, material, resource } = await fixture(t);
  const id = await createNode(env, {
    parentPath: "",
    name: "Fact",
    type: "prompt",
    resource,
    body: "original",
  });
  const initial = await readNodeForEdit(adapter, id),
    head = await adapter.history.currentCommit();
  const record = (await adapter.history.nodeRecords())[id]!;
  assert.equal(record.materials[0]!.version, createHash("sha256").update("v1").digest("hex"));
  const message = await git(system, "show", "-s", "--format=%B", head!);
  assert.ok(message.includes(`Tent-Node-Record: ["${id}"`));
  assert.equal(await git(system, "show", `${head}:${nodeNotePath(initial.path)}`), initial.raw);
  const tree = await git(system, "ls-tree", "-r", "--name-only", head!);
  assert.equal(tree.trim(), "Fact/Fact.md");
  assert.equal(parseFrontmatter(initial.raw).data.sync, undefined);
  await fs.writeFile(material, "v2");
  // External edits captured by a read never acknowledge changed material bytes.
  const external = initial.raw + "\nexternal\n";
  await adapter.writeFile(nodeNotePath(initial.path), external);
  await readNodeForEdit(adapter, id);
  assert.deepEqual((await adapter.history.nodeRecords())[id], record);
  const updated = await confirmNodeSync(adapter, id, {
    baseEtag: (await readNodeForEdit(adapter, id)).etag,
  });
  assert.notDeepEqual((await adapter.history.nodeRecords())[id], record);
  await git(system, "-c", "core.autocrlf=false", "reset", "--hard", head!);
  assert.equal(await adapter.readFile(nodeNotePath(initial.path)), initial.raw);
  assert.deepEqual((await adapter.history.nodeRecords())[id], record);
  assert.notEqual(await adapter.history.currentCommit(), updated.version!.commit);
});

test("single save, confirm, creation and new output roll back files and records when capture fails", async (t) => {
  const { adapter, env, resource } = await fixture(t);
  const id = await createNode(env, { parentPath: "", name: "Fact", type: "prompt", resource });
  const goal = await createNode(env, { parentPath: "", name: "Goal", type: "goal" });
  const current = await readNodeForEdit(adapter, id);
  const records = await adapter.history.nodeRecords(),
    head = await adapter.history.currentCommit();
  const order = await adapter.readFile("order.json");
  const capture = adapter.history.captureUnlocked.bind(adapter.history);
  adapter.history.captureUnlocked = async (changes, metadata) => {
    if (metadata?.operation !== "document.external-capture") throw new Error("capture injection");
    return capture(changes, metadata);
  };
  await assert.rejects(
    writeNodeDocument(adapter, id, { baseEtag: current.etag, body: "new", confirm: true }),
    /capture injection/,
  );
  assert.equal(await adapter.readFile(nodeNotePath(current.path)), current.raw);
  await assert.rejects(
    confirmNodeSync(adapter, id, { baseEtag: current.etag }),
    /capture injection/,
  );
  assert.equal(await adapter.readFile(nodeNotePath(current.path)), current.raw);
  await assert.rejects(
    createNode(env, { parentPath: "", name: "Failed", type: "prompt", resource }),
    /capture injection/,
  );
  assert.equal(await adapter.exists("Failed"), false);
  await assert.rejects(
    linkNodeOutput(adapter, goal, { resource, name: "Failed Output" }),
    /capture injection/,
  );
  assert.equal(await adapter.exists("Goal/Failed Output"), false);
  assert.equal(await adapter.readFile("order.json"), order);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await adapter.history.nodeRecords(), records);
});

test("batch capture failure retains exact preimages and all baseline records", async (t) => {
  const { adapter, env, resource } = await fixture(t);
  const id = await createNode(env, { parentPath: "", name: "Fact", type: "prompt", resource });
  const current = await readNodeForEdit(adapter, id),
    records = await adapter.history.nodeRecords(),
    head = await adapter.history.currentCommit();
  adapter.history.captureUnlocked = async () => {
    throw new Error("batch capture injection");
  };
  await assert.rejects(
    writeNodesBatch(env, {
      items: [
        { op: "update", nodeId: id, baseEtag: current.etag, body: "new", confirm: true },
        { op: "create", ref: "new", name: "New", type: "goal", resource },
      ],
    }),
    /batch capture injection/,
  );
  assert.equal(await adapter.readFile(nodeNotePath(current.path)), current.raw);
  assert.equal(await adapter.exists("New"), false);
  assert.deepEqual(await adapter.history.nodeRecords(), records);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("material cache survives short-lived processes and invalidates on byte changes", async (t) => {
  const { root, system, adapter, material, resource } = await fixture(t);
  const first = await adapter.observeMaterial(resource, "Fact/Fact.md");
  assert.equal(first.cacheHit, false);
  assert.equal((await new NodeFs(system).observeMaterial(resource, "Fact/Fact.md")).cacheHit, true);
  const script = path.join(root, "observe.mjs");
  await fs.writeFile(
    script,
    `import {NodeFs} from ${JSON.stringify(pathToFileURL(path.resolve("src/fs/node-fs.ts")).href)}; console.log(JSON.stringify(await new NodeFs(${JSON.stringify(system)}).observeMaterial(${JSON.stringify(resource)},"Fact/Fact.md")));`,
  );
  const child = new Promise<string>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", script], {
      cwd: globalThis.process.cwd(),
      windowsHide: true,
    });
    let out = "",
      err = "";
    process.stdout.on("data", (s) => (out += s));
    process.stderr.on("data", (s) => (err += s));
    process.once("error", reject);
    process.once("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
  });
  assert.equal(JSON.parse(await child).cacheHit, true);
  await fs.writeFile(material, "v2");
  const changed = await new NodeFs(system).observeMaterial(resource, "Fact/Fact.md");
  assert.equal(changed.cacheHit, false);
  assert.notEqual(changed.observedVersion, first.observedVersion);
  await fs.writeFile(
    path.join(
      system,
      ".git",
      "tent-material-cache",
      createHash("sha256").update(changed.canonicalPath).digest("hex") + ".json",
    ),
    "corrupt",
  );
  assert.equal(
    (await new NodeFs(system).observeMaterial(resource, "Fact/Fact.md")).observedVersion,
    changed.observedVersion,
  );
});

test("renames and moves retain Node-ID material baselines without refreshing known behind", async (t) => {
  const { adapter, env, resource, material } = await fixture(t);
  const parent = await createNode(env, { parentPath: "", name: "Parent", type: "prompt" });
  const id = await createNode(env, { parentPath: "", name: "Fact", type: "prompt", resource });
  const records = await adapter.history.nodeRecords();
  await fs.writeFile(material, "changed");
  await renameNode(env, id, "Renamed");
  await moveNode(env, id, parent, { mode: "inside" });
  assert.deepEqual((await adapter.history.nodeRecords())[id], records[id]);
  assert.equal((await inspectNodeSync(adapter, id)).state, "behind");
});

test("relocation retains changed attachment baselines and link-output normalizes its actual name", async (t) => {
  const { adapter, system, env } = await fixture(t);
  const goal = await createNode(env, { parentPath: "", name: "Goal", type: "goal" });
  const id = await createNode(env, { parentPath: "", name: "Fact", type: "prompt" });
  await fs.writeFile(path.join(system, "Fact", "attachment.txt"), "v1");
  const current = await readNodeForEdit(adapter, id);
  await writeNodeDocument(adapter, id, {
    baseEtag: current.etag,
    frontmatter: { resource: "./attachment.txt" },
  });
  const before = (await inspectNodeSync(adapter, id)).materials[0]!.recordedVersion;
  await fs.writeFile(path.join(system, "Fact", "attachment.txt"), "changed");
  await renameNode(env, id, "Renamed");
  await moveNode(env, id, goal, { mode: "inside" });
  const inspection = await inspectNodeSync(adapter, id);
  assert.equal(inspection.state, "behind");
  assert.equal(inspection.materials[0]!.recordedVersion, before);
  const output = await linkNodeOutput(adapter, goal, {
    resource: ".tent/Goal/Renamed/attachment.txt",
    name: "  Result  ",
  });
  assert.equal(output.path, "Goal/Result");
  assert.equal((await inspectNodeSync(adapter, output.nodeId)).state, "synced");
  assert.equal(
    (await readNodeForEdit(adapter, output.nodeId)).frontmatter.resource,
    "../Renamed/attachment.txt",
  );
});

test("migration transfers exact legacy hashes in one commit, preserves meaning, reports counts and is idempotent", async (t) => {
  const { adapter, system, env, resource, material } = await fixture(t);
  const goal = await createNode(env, { parentPath: "", name: "Goal", type: "goal" });
  const id = await createNode(env, { parentPath: "Goal", name: "Legacy", type: "output" });
  const current = await readNodeForEdit(adapter, id);
  const legacy = serializeFrontmatter(
    {
      ...current.frontmatter,
      resource,
      sync: {
        materials: [{ resource, version: createHash("sha256").update("old").digest("hex") }],
      },
      planned: true,
      custom: { keep: true },
    },
    "exact body\n",
  );
  await adapter.writeFile(nodeNotePath(current.path), legacy);
  await readNodeForEdit(adapter, id);
  const migrated = await migrateNodeRecords(adapter);
  assert.deepEqual(
    { ...migrated, commit: undefined },
    { scanned: 2, migrated: 1, materials: 1, removedFields: 2, commit: undefined },
  );
  const saved = await readNodeForEdit(adapter, id),
    parsed = parseFrontmatter(saved.raw);
  assert.equal(parsed.body, "exact body\n");
  assert.deepEqual(parsed.data.generated, current.frontmatter.generated);
  assert.deepEqual(parsed.data.custom, { keep: true });
  assert.equal(parsed.data.sync, undefined);
  assert.equal(parsed.data.planned, undefined);
  assert.equal((await inspectNodeSync(adapter, id)).state, "behind");
  assert.match(
    await git(system, "show", "-s", "--format=%B", migrated.commit!),
    /Tent-Node-Record:/,
  );
  assert.equal(
    await git(system, "show", `${migrated.commit}:${nodeNotePath(current.path)}`),
    saved.raw,
  );
  assert.deepEqual(await migrateNodeRecords(adapter), {
    scanned: 2,
    migrated: 0,
    materials: 0,
    removedFields: 0,
  });
  assert.equal((await adapter.history.nodeRecords())[id]!.goal!.nodeId, goal);
  await fs.writeFile(material, "old");
  assert.equal((await inspectNodeSync(adapter, id)).state, "synced");
  const goalCurrent = await readNodeForEdit(adapter, goal);
  await writeNodeDocument(adapter, goal, { baseEtag: goalCurrent.etag, body: "changed goal" });
  assert.equal((await inspectNodeSync(adapter, id)).state, "behind");
});

test("migration failure restores every legacy document and never publishes new baseline records", async (t) => {
  const { adapter, env, resource } = await fixture(t);
  const id = await createNode(env, { parentPath: "", name: "Legacy", type: "prompt" });
  const current = await readNodeForEdit(adapter, id);
  const legacy = serializeFrontmatter(
    {
      ...current.frontmatter,
      sync: { materials: [{ resource, version: "a".repeat(64) }] },
      planned: true,
    },
    current.body,
  );
  await adapter.writeFile(nodeNotePath(current.path), legacy);
  await readNodeForEdit(adapter, id);
  const head = await adapter.history.currentCommit(),
    records = await adapter.history.nodeRecords();
  adapter.history.captureUnlocked = async () => {
    throw new Error("migration capture injection");
  };
  await assert.rejects(migrateNodeRecords(adapter), /migration capture injection/);
  assert.equal(await adapter.readFile(nodeNotePath(current.path)), legacy);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await adapter.history.nodeRecords(), records);
});
