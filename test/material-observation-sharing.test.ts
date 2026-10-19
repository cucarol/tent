import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { observeNodeMaterials } from "../src/core/graph/node-sync-record.js";
import { inspectWorkspaceSync } from "../src/core/graph/node-sync.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { structureFingerprint } from "../src/core/base/structure-material.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { git } from "./helpers.js";

const observer = (): FsAdapter =>
  new NodeFs(path.join(testScratchRoot(), "observation-unit", ".tent"));

test("one inspection shares current material across equivalent declarations and refreshes next time", async () => {
  const fs = observer();
  const calls: Array<"structure" | undefined> = [];
  let current = "a".repeat(64);
  fs.observeMaterial = async (_resource, _owner, track) => {
    calls.push(track);
    return { observedVersion: current };
  };
  const observations = new Map();
  const first = await observeNodeMaterials(
    fs,
    { resource: "../../shared.txt" },
    "A/A.md",
    undefined,
    undefined,
    observations,
  );
  const second = await observeNodeMaterials(
    fs,
    { resource: "../../../shared.txt" },
    "B/C/C.md",
    undefined,
    undefined,
    observations,
  );
  assert.equal(first[0]!.version, current);
  assert.equal(second[0]!.version, current);
  assert.deepEqual(calls, [undefined]);
  current = "b".repeat(64);
  const next = await observeNodeMaterials(
    fs,
    { resource: "../../shared.txt" },
    "A/A.md",
    undefined,
    undefined,
    new Map(),
  );
  assert.equal(next[0]!.version, current);
  assert.equal(calls.length, 2);
});

for (const resource of ["../../shared.txt", "../../shared/"]) {
  test(`unavailable current material is shared and remains unavailable: ${resource}`, async () => {
    const fs = observer();
    const calls: Array<"structure" | undefined> = [];
    fs.observeMaterial = async (_resource, _owner, track) => {
      calls.push(track);
      throw Object.assign(new Error("ENOENT: current material is missing"), { code: "ENOENT" });
    };
    const observations = new Map();
    const a = await observeNodeMaterials(
      fs,
      { resource },
      "A/A.md",
      undefined,
      undefined,
      observations,
    );
    const b = await observeNodeMaterials(
      fs,
      { resource },
      "B/B.md",
      undefined,
      undefined,
      observations,
    );
    const again = await observeNodeMaterials(
      fs,
      { resource },
      "A/A.md",
      undefined,
      undefined,
      observations,
    );
    assert.equal(a[0]!.version, undefined);
    assert.equal(b[0]!.version, undefined);
    assert.match(a[0]!.reason!, /current material is missing/);
    assert.match(b[0]!.reason!, /current material is missing/);
    assert.deepEqual(again, a);
    assert.deepEqual(calls, [undefined]);
  });
}

test("shared observations keep different sections and unavailable sources distinct", async () => {
  const fs = observer();
  const calls: string[] = [];
  fs.observeMaterial = async (resource) => {
    calls.push(resource);
    if (resource.endsWith("#Missing")) throw new Error("Markdown material heading not found");
    return { observedVersion: (resource.endsWith("#A") ? "a" : "b").repeat(64) };
  };
  const observations = new Map();
  const result = await observeNodeMaterials(
    fs,
    {
      sources: ["A", "B", "Missing"].map((heading) => ({ resource: `../../shared.md#${heading}` })),
    },
    "A/A.md",
    undefined,
    undefined,
    observations,
  );
  assert.equal(result[0]!.version, "a".repeat(64));
  assert.equal(result[1]!.version, "b".repeat(64));
  assert.equal(result[2]!.version, undefined);
  assert.match(result[2]!.reason!, /heading not found/);
  assert.equal(calls.length, 3);
});

test("shared structure observations distinguish the owning Node's structure-source union", async () => {
  const fs = observer();
  const scopes: Array<readonly string[] | undefined> = [];
  fs.observeMaterial = async (_resource, _owner, _track, resources) => {
    scopes.push(resources);
    return { observedVersion: (resources?.length === 2 ? "a" : "b").repeat(64) };
  };
  const observations = new Map();
  const source = { resource: "../../src/card-*", track: "structure" };
  const union = { sources: [source, { resource: "../../src/role-*", track: "structure" }] };
  const a = await observeNodeMaterials(fs, union, "A/A.md", undefined, undefined, observations);
  const b = await observeNodeMaterials(
    fs,
    { sources: [source] },
    "B/B.md",
    undefined,
    undefined,
    observations,
  );
  const again = await observeNodeMaterials(fs, union, "A/A.md", undefined, undefined, observations);
  assert.equal(a[0]!.version, "a".repeat(64));
  assert.equal(b[0]!.version, "b".repeat(64));
  assert.deepEqual(again, a);
  assert.equal(scopes.length, 3);
});

test(
  "a subtree waiting for one ancestor cannot starve independent material observations",
  { timeout: 5000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(testScratchRoot(), "material-scheduling-"));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
    const adapter = new NodeFs(path.join(root, ".tent"));
    for (const name of ["A", "B"])
      await adapter.writeFile(
        `${name}/${name}.md`,
        serializeFrontmatter(
          {
            id: `node-${name.toLowerCase()}`,
            type: "goal",
            sources: [{ resource: `../../${name}/`, track: "structure" }],
          },
          "",
        ),
      );
    for (let index = 0; index < 40; index++) {
      const name = `Out${String(index).padStart(2, "0")}`;
      await adapter.writeFile(
        `A/${name}/${name}.md`,
        serializeFrontmatter(
          {
            id: `node-out${index}`,
            type: "output",
          },
          "",
        ),
      );
    }
    let release!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const seen: string[] = [];
    adapter.observeMaterial = async (_resource, owner) => {
      seen.push(owner);
      if (owner === "B/B.md") release();
      else await secondStarted;
      return {
        canonicalPath: root,
        observedVersion: structureFingerprint([]),
        structureDependencies: [],
      };
    };
    const result = await inspectWorkspaceSync(adapter);
    assert.equal(result.nodes.length, 42);
    assert.deepEqual(seen.sort(), ["A/A.md", "B/B.md"]);
    assert.equal(result.nodes[0]!.nodeId, "node-a");
    assert.equal(result.nodes.at(-1)!.nodeId, "node-b");
    assert.ok(result.nodes.every((node) => !node.uncertain));
  },
);

test("structure inspections keep Git listings constant as materials grow and refresh the next inspection", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  const root = await fs.mkdtemp(path.join(scratch, "structure-inspection-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  await write(".gitignore", ".tent/\n");
  await write("src/shared/api.ts", "export const api = true;\n");
  await write("src/other/api.ts", "export const other = true;\n");
  await git(root, "init", "--quiet");
  await scaffoldInWorkspace(new NodeFs(root), { name: "Shared inspection" });
  const addMaterial = async (index: number) => {
    await write(`src/module-${index}/file-main.ts`, "export const value = true;\n");
    await write(
      `.tent/Module${index}/Module${index}.md`,
      serializeFrontmatter(
        {
          id: `node-module${index}`,
          type: "prompt",
          sources: [
            {
              resource: `../../src/module-${index}/${index % 2 ? "file-*" : ""}`,
              track: "structure",
            },
          ],
        },
        "Module structure\n",
      ),
    );
  };
  await addMaterial(0);
  await git(root, "add", ".");
  const adapter = new NodeFs(path.join(root, ".tent"));
  const original = childProcess.execFile;
  const listings: string[][] = [];
  const mocked = t.mock.method(childProcess, "execFile", (...args: Parameters<typeof original>) => {
    const commandArgs = args[1] as string[];
    if (args[0] === "git" && commandArgs.includes("ls-files")) listings.push([...commandArgs]);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const inspect = async (count: number) => {
      listings.length = 0;
      const result = await inspectWorkspaceSync(adapter);
      assert.deepEqual(result.invalidNodes, []);
      assert.equal(result.nodes.length, count);
      for (const node of result.nodes) {
        assert.equal(node.materials.length, 1);
        assert.equal(node.materials[0]!.track, "structure");
        assert.equal(node.materials[0]!.state, "unanchored");
        assert.match(node.materials[0]!.currentVersion!, /^[a-f0-9]{64}$/);
      }
      assert.equal(
        listings.length,
        3,
        "one live, one ignored and one tracked listing per inspection",
      );
      assert.equal(listings.filter((args) => args.includes("--stage")).length, 1);
      assert.equal(listings.filter((args) => args.includes("--ignored")).length, 1);
      assert.equal(listings.filter((args) => args.includes("--others")).length, 1);
      return result;
    };
    const first = await inspect(1);
    assert.equal(first.nodes[0]!.materials[0]!.currentVersion, structureFingerprint([]));
    for (let index = 1; index < 8; index++) await addMaterial(index);
    await inspect(8);
    // Reuse the adapter: neither old file contents nor the old listing may survive a check.
    await write("src/module-0/file-main.ts", 'import "../shared/api.js";\n');
    await write("src/module-0/file-new.ts", 'import "../other/api.js";\n');
    const refreshed = await inspect(8);
    const module = refreshed.nodes.find((node) => node.nodeId === "node-module0")!;
    assert.equal(
      module.materials[0]!.currentVersion,
      structureFingerprint(["src/other/", "src/shared/"]),
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("structure listings and nonmembers share types only within the current inspection", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "structure-types-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await fs.mkdir(path.join(root, "src/core"), { recursive: true });
  await fs.mkdir(path.join(root, "src/out"), { recursive: true });
  await fs.mkdir(path.join(root, ".tent"));
  await fs.writeFile(path.join(root, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(root, "src/core/card-main.ts"), 'import "../out/api.js";\n');
  const target = path.join(root, "src/out/api.ts");
  await fs.writeFile(target, "export const api = true;\n");
  await git(root, "init", "--quiet");
  await git(root, "add", ".");
  const adapter = new NodeFs(path.join(root, ".tent"));
  const original = fs.lstat;
  let calls = 0;
  let denied = false;
  const mocked = t.mock.method(fs, "lstat", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === target) {
      calls++;
      if (denied) return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const inspect = () =>
      adapter.observationScope(async () => {
        const a = await adapter.observeMaterial("../src/core/", "index.md", "structure");
        const b = await adapter.observeMaterial("../src/core/card-*", "index.md", "structure");
        assert.deepEqual(a.structureDependencies, ["src/out/"]);
        assert.deepEqual(b.structureDependencies, a.structureDependencies);
      });
    await inspect();
    assert.equal(calls, 1, "live, tracked and both material resolvers reuse one nonmember type");
    calls = 0;
    denied = true;
    await assert.rejects(inspect(), { code: "EACCES" });
    assert.equal(calls, 1, "a later inspection must observe current permission failures");
    denied = false;
    await fs.rm(target);
    await assert.rejects(inspect(), /absent from tracked files/);
    await fs.writeFile(target, "export const api = false;\n");
    calls = 0;
    await inspect();
    assert.equal(calls, 1, "failed or missing types must not outlive an inspection");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a listed regular source is still rejected if it becomes a link before content reading", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "structure-type-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, ".tent"));
  await fs.writeFile(path.join(root, ".gitignore"), ".tent/\n");
  const target = path.join(root, "src/main.ts");
  await fs.writeFile(target, "export const value = true;\n");
  await git(root, "init", "--quiet");
  await git(root, "add", ".");
  const adapter = new NodeFs(path.join(root, ".tent"));
  const original = fs.lstat;
  let calls = 0;
  const mocked = t.mock.method(fs, "lstat", async (...args: Parameters<typeof original>) => {
    const info = await original(...args);
    if (String(args[0]) !== target || ++calls === 1) return info;
    return new Proxy(info, {
      get(value, key) {
        if (key === "isSymbolicLink") return () => true;
        const member = Reflect.get(value, key);
        return typeof member === "function" ? member.bind(value) : member;
      },
    });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      adapter.observationScope(() => adapter.observeMaterial("../src/", "index.md", "structure")),
      /Symbolic links/,
    );
    assert.ok(calls > 1, "source safety checks must not trust the listing's earlier type");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
