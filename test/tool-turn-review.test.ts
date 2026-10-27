import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import {
  structureMaterialCoverage,
  materialCoverageContains,
} from "../src/core/base/material-coverage.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { modulesForIndexedTurn } from "../src/core/return/tool-turn-review.js";
import {
  type StopMaterialIndex,
  buildStopMaterialIndex,
} from "../src/core/return/stop-material-index.js";
import { createHash } from "node:crypto";
import { isUsableNode } from "../src/core/store/tree.js";

const event = (files: string[] = []): Parameters<typeof modulesForIndexedTurn>[1] => ({
  files: files.map((address) => ({
    kind: "written",
    address,
  })),
});

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "stop-review-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), { name: "review" });
  const adapter = openTestFs(path.join(root, ".tent"));
  const node = async (nodePath: string, id: string, resource: string, track = true, extra = "") => {
    const name = nodePath.split("/").pop()!;
    await fs.mkdir(path.join(root, ".tent", nodePath), { recursive: true });
    await adapter.writeFile(
      `${nodePath}/${name}.md`,
      `---\nid: ${id}\ntype: output\nsources:\n  - resource: ${resource}\n${track ? "    track: structure\n" : ""}${extra}---\nModule rule\n`,
    );
  };
  await fs.mkdir(path.join(root, "src", "core"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "core", "card-one.ts"), "one");
  await node("Core", "node-core", "../../src/core/");
  await node("Core/Card", "node-card", "../../../src/core/card-*");
  await node("AlsoCard", "node-equal", "../../src/core/card-*");
  await node("Evidence", "node-evidence", "../../src/core/", false, "tags: [module]\n");
  return { root, adapter, node };
}

test("shared structure coverage validates prefixes and directory/path boundaries", () => {
  const root = path.resolve(testScratchRoot(), "coverage");
  const owner = "Module/Module.md";
  const directory = structureMaterialCoverage("../../src/core/", owner, root)!;
  assert.deepEqual(directory, { kind: "directory", prefix: "src/core/" });
  assert.equal(materialCoverageContains(directory, "src/core/card.ts"), true);
  assert.equal(materialCoverageContains(directory, "src/corex/card.ts"), false);
  assert.equal(materialCoverageContains(directory, "src/core/../outside.ts"), false);
  const prefix = structureMaterialCoverage("../../src/core/card-*", owner, root)!;
  assert.equal(materialCoverageContains(prefix, "src/core/card-x.ts"), true);
  assert.equal(materialCoverageContains(prefix, "src/core/card-x/nested.ts"), true);
  assert.equal(materialCoverageContains(prefix, "src/core/other.ts"), false);
  for (const resource of [
    "../../src/*/card-*",
    "../../src/core/card-**",
    "../../src/core/*/",
    "../../src/core/card-*#section",
    "src/core/card-*",
    "../../../outside/*",
    "../../src/core/card.ts",
  ])
    assert.equal(structureMaterialCoverage(resource, owner, root), undefined, resource);
});

test("modules require explicit structure sources and retain all equally specific owners with ancestors", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node(
    "Deprecated",
    "node-deprecated",
    "../../src/core/card-*",
    true,
    "status: deprecated\n",
  );
  const catalog = await loadNodeCatalog(adapter);
  const modules = modulesForIndexedTurn(
    buildStopMaterialIndex(catalog, root),
    event(["src/core/card-one.ts", "src/core/other.ts"]),
  );
  assert.deepEqual(modules.map((module) => module.nodeId).sort(), [
    "node-card",
    "node-core",
    "node-equal",
  ]);
  assert.deepEqual(modules.find((module) => module.nodeId === "node-core")!.files, [
    "src/core/other.ts",
  ]);
  assert.deepEqual(modules.find((module) => module.nodeId === "node-card")!.names, [
    "Core",
    "Card",
  ]);
  assert.equal(
    modules.find((module) => module.nodeId === "node-card")!.path,
    ".tent/Core/Card/Card.md",
  );
  assert.deepEqual(
    modulesForIndexedTurn(
      buildStopMaterialIndex(catalog, root, [
        ".tent/Core/Card/Card.md",
        ".tent/AlsoCard/AlsoCard.md",
      ]),
      event(["src/core/card-one.ts"]),
    ).map((module) => module.nodeId),
    ["node-core"],
  );
  assert.deepEqual(modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), event()), []);
  assert.deepEqual(
    modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), event(["uncovered.ts"])),
    [],
  );
  assert.deepEqual(
    modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), {
      ...event(["src/core/card-one.ts"]),
      cancelled: true,
    }),
    [],
  );
  assert.deepEqual(
    modulesForIndexedTurn(buildStopMaterialIndex(catalog, root), {
      ...event(["src/core/card-one.ts"]),
      files: event(["src/core/card-one.ts"]).files.map((file) => ({ ...file, kind: "read" })),
    }),
    [],
  );
});

test("material index excludes draft module coverage while retaining stable modules beneath it", async (t) => {
  const { root, adapter } = await fixture(t);
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"));
  const turn = event(["src/core/card-one.ts", "src/core/other.ts"]);
  const original = await adapter.readFile("Core/Core.md");
  const stable = await loadStopMaterialIndex(systemRoot, root);
  assert.ok(modulesForIndexedTurn(stable, turn).some((node) => node.nodeId === "node-core"));
  const draftRaw = original.replace("type: output", "type: output\nstatus: draft");
  await adapter.writeFile("Core/Core.md", draftRaw);
  const expected = buildStopMaterialIndex(await loadNodeCatalog(adapter), root);
  assert.ok(!expected.nodes.some((node) => node.nodeId === "node-core"));
  assert.deepEqual(
    modulesForIndexedTurn(expected, turn)
      .map((node) => node.nodeId)
      .sort(),
    ["node-card", "node-equal"],
  );
  assert.deepEqual(
    modulesForIndexedTurn(expected, turn).find((node) => node.nodeId === "node-card")!.names,
    ["Core", "Card"],
  );
  // A cache primed while stable must apply the changed header on both cold and repeated reads.
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const cacheFile = path.join(systemRoot, ".git/tent-material-cache/stop-material-index.json");
  const legacy = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  legacy.schema = 6;
  legacy.index = stable;
  legacy.indexDigest = createHash("sha256").update(JSON.stringify(legacy.index)).digest("hex");
  await fs.writeFile(cacheFile, JSON.stringify(legacy));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, "utf8")).schema, 8);
  assert.equal(await adapter.readFile("Core/Core.md"), draftRaw);
  await adapter.writeFile("Core/Core.md", original);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), stable);
});

test("material index excludes unknown lifecycle from modules and ordinary materials across cold, hot and old caches", async (t) => {
  const { root, adapter, node } = await fixture(t);
  const systemRoot = path.join(root, ".tent");
  await node("UnknownModule", "node-unknownmodule", "../../unknown/", true, "status: mystery\n");
  await node(
    "UnknownEvidence",
    "node-unknownevidence",
    "../../only-unknown.txt",
    false,
    "status: mystery\n",
  );
  await node("Draft", "node-draft", "../../draft/", true, "status: draft\n");
  await node("Stable", "node-stable", "../../live/", true, "status: stable\n");
  await node("Deprecated", "node-deprecated", "../../old/", true, "status: deprecated\n");
  const unknownModulePath = "UnknownModule/UnknownModule.md";
  const unknownEvidencePath = "UnknownEvidence/UnknownEvidence.md";
  const moduleRaw = await adapter.readFile(unknownModulePath);
  const evidenceRaw = await adapter.readFile(unknownEvidencePath);
  const catalog = await loadNodeCatalog(adapter);
  for (const id of ["node-unknownmodule", "node-unknownevidence"]) {
    const current = catalog.tree.byId.get(id)!;
    assert.equal(current.invalid, false);
    assert.equal(current.status, null);
    assert.equal(isUsableNode(current), false);
    assert.match(current.statusDiagnostic!, /preserved without assuming currentness/);
  }
  const expected = buildStopMaterialIndex(catalog, root);
  for (const id of ["node-stable", "node-core"])
    assert.ok(expected.nodes.some((node) => node.nodeId === id));
  for (const id of ["node-draft", "node-unknownmodule", "node-unknownevidence", "node-deprecated"])
    assert.ok(!expected.nodes.some((node) => node.nodeId === id));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  await fs.mkdir(path.join(systemRoot, ".git"));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const cacheFile = path.join(systemRoot, ".git/tent-material-cache/stop-material-index.json");
  const legacy = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  legacy.schema = 2;
  legacy.index.nodes.push({
    nodeId: "node-unknownmodule",
    path: `.tent/${unknownModulePath}`,
    names: ["UnknownModule"],
    type: "output",
    materials: [{ coverage: { kind: "directory", prefix: "unknown/" } }],
    moduleCoverage: [{ kind: "directory", prefix: "unknown/" }],
  });
  legacy.indexDigest = createHash("sha256").update(JSON.stringify(legacy.index)).digest("hex");
  await fs.writeFile(cacheFile, JSON.stringify(legacy));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, "utf8")).schema, 8);
  assert.deepEqual(modulesForIndexedTurn(expected, event(["unknown/a.ts"])), []);
  await fs.writeFile(
    path.join(systemRoot, unknownModulePath),
    moduleRaw.replace("status: mystery", "status: stable"),
  );
  await fs.writeFile(
    path.join(systemRoot, unknownEvidencePath),
    evidenceRaw.replace("status: mystery", "status: stable"),
  );
  const repaired = await loadStopMaterialIndex(systemRoot, root);
  assert.deepEqual(
    modulesForIndexedTurn(repaired, event(["unknown/a.ts"])).map((module) => module.nodeId),
    ["node-unknownmodule"],
  );
  await fs.writeFile(path.join(systemRoot, unknownModulePath), moduleRaw);
  await fs.writeFile(path.join(systemRoot, unknownEvidencePath), evidenceRaw);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.equal(await adapter.readFile(unknownModulePath), moduleRaw);
  assert.equal(await adapter.readFile(unknownEvidencePath), evidenceRaw);
  assert.equal((await loadNodeCatalog(adapter)).tree.byId.get("node-unknownmodule")!.status, null);
});

test("material index header scan preserves chunk boundaries, malformed ancestry and body independence", async (t) => {
  const { root, adapter } = await fixture(t);
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"));
  for (const [name, raw] of [
    [
      "Long",
      `\uFEFF---\r\nid: node-long\r\ntype: output\r\ndescription: "${"a".repeat(4085)}😀"\r\nsources:\r\n  - resource: ../../src/core/\r\n    track: structure\r\n--- \t\r\n${"body\n".repeat(100_000)}`,
    ],
    ["Broken", `---\nid: node-broken\ntype: output\ndescription: ${"a".repeat(5000)}\n`],
    [
      "Broken/Child",
      "---\nid: node-child\ntype: output\nsources:\n  - resource: ../../../src/core/\n    track: structure\n---\nChild",
    ],
  ]) {
    await fs.mkdir(path.join(systemRoot, name), { recursive: true });
    const filename = `${name}/${name.split("/").pop()}.md`;
    await fs.writeFile(path.join(systemRoot, filename), raw);
  }
  const fullRead = new Proxy(adapter, {
    get(target, key) {
      if (key === "readFrontmatter") return undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const expected = buildStopMaterialIndex(await loadNodeCatalog(fullRead), root);
  assert.ok(expected.nodes.some((node) => node.nodeId === "node-long"));
  assert.ok(!expected.nodes.some((node) => node.nodeId === "node-child"));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const cacheFile = path.join(
    systemRoot,
    ".git",
    "tent-material-cache",
    "stop-material-index.json",
  );
  const cached = await fs.readFile(cacheFile, "utf8");
  await fs.appendFile(path.join(systemRoot, "Long/Long.md"), "body-only addition");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const refreshed = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.deepEqual(refreshed.index, JSON.parse(cached).index);
  assert.notEqual(
    refreshed.headers.find(([filename]: [string]) => filename === "Long/Long.md")[1].state.size,
    JSON.parse(cached).headers.find(([filename]: [string]) => filename === "Long/Long.md")[1].state
      .size,
  );
});

test("material index cache validates file state and topology; missing, corrupt and unwritable caches preserve results", async (t) => {
  const { root, adapter, node } = await fixture(t);
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"));
  const cacheDirectory = path.join(systemRoot, ".git", "tent-material-cache");
  const cacheFile = path.join(cacheDirectory, "stop-material-index.json");
  const original = await loadStopMaterialIndex(systemRoot, root);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  const filename = path.join(systemRoot, "Core", "Card", "Card.md");
  const originalRaw = await fs.readFile(filename, "utf8");
  const stat = await fs.stat(filename);
  await fs.writeFile(filename, originalRaw.replace("card-*", "cord-*"));
  await fs.utimes(filename, stat.atime, stat.mtime);
  const changed = await loadStopMaterialIndex(systemRoot, root);
  assert.ok(
    !modulesForIndexedTurn(changed, event(["src/core/card-one.ts"])).some(
      (module) => module.nodeId === "node-card",
    ),
  );
  await fs.writeFile(filename, originalRaw);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await node("Added", "node-added", "../../src/new/", true);
  assert.ok(
    (await loadStopMaterialIndex(systemRoot, root)).nodes.some(
      (node) => node.nodeId === "node-added",
    ),
  );
  await fs.rm(path.join(systemRoot, "Added"), { recursive: true });
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await adapter.mkdir("returns");
  await loadStopMaterialIndex(systemRoot, root);
  await adapter.writeFile("returns/return-old.json", "{}");
  await assert.rejects(loadStopMaterialIndex(systemRoot, root), /Retired Tent storage/);
  await fs.rm(path.join(systemRoot, "returns"), { recursive: true });
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await fs.rm(cacheFile);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  cached.index.nodes = [];
  await fs.writeFile(cacheFile, JSON.stringify(cached));
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await fs.writeFile(cacheFile, "broken JSON");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await fs.rm(cacheDirectory, { recursive: true });
  await fs.writeFile(cacheDirectory, "not a directory");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  assert.equal(await fs.readFile(filename, "utf8"), originalRaw);
  assert.deepEqual((await fs.readdir(path.join(systemRoot, ".git"))).sort(), [
    "tent-material-cache",
  ]);
  assert.equal(await adapter.exists("temp/stop-reviews"), false);
});

test("written file coverage ranks distinct writes and ignores reads before reminder truncation", () => {
  const index: StopMaterialIndex = {
    nodes: Array.from({ length: 7 }, (_, i) => ({
      nodeId: `node-${i}`,
      path: `.tent/${i}/${i}.md`,
      names: [`M${i}`],
      moduleCoverage: [{ kind: "directory", prefix: `src/${i}/` }],
    })),
  };
  const addresses = [
    ...Array.from({ length: 7 }, (_, i) => `src/${i}/a.ts`),
    "src/6/b.ts",
    "src/5/b.ts",
    "src/6/c.ts",
    "src/0/a.ts",
  ];
  const event: Parameters<typeof modulesForIndexedTurn>[1] = {
    files: addresses.map((address) => ({
      kind: "written",
      address,
    })),
  };
  event.files.push({ ...event.files[0]!, kind: "read", address: "src/0/read.ts" });
  assert.deepEqual(
    modulesForIndexedTurn(index, event).map((m) => m.nodeId),
    ["node-6", "node-5", "node-0", "node-1", "node-2", "node-3", "node-4"],
  );
});
