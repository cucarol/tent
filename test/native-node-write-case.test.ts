import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTurnPathResolver } from "../src/core/workspace/git-checkout.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { checkNativeNodeWrites } from "../src/fs/node-write-problems.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot, initializeFixtureHistory, captureFixtureDocuments } from "./scratch.js";

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(testScratchRoot(), "native-node-case-"));
  t.after(() =>
    removeTestFixture(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const root = path.join(base, "main");
  await fs.mkdir(root);
  await scaffoldInWorkspace(openTestFs(root), {
    name: "Case",
    nodes: [{ id: "node-mixed", name: "Mixed", type: "prompt", body: "[missing](node-missing)" }],
  });
  const systemRoot = path.join(root, ".tent");
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  return { base, root, systemRoot };
}

test(
  "Windows native Node writes accept case-equivalent system, directory and identity paths for both hosts",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root } = await fixture(t);
    const resolver = await createTurnPathResolver(root, root);
    assert.equal(
      await resolver.relative(path.join(root, ".TENT/Mixed/Mixed.md")),
      ".TENT/Mixed/Mixed.md",
    );
    for (const host of ["codex", "claude-code"] as const) {
      const expected = await checkNativeNodeWrites(host, root, [".tent/Mixed/Mixed.md"]);
      assert.equal(expected.length, 1);
      assert.equal(expected[0]!.path, ".tent/Mixed/Mixed.md");
      for (const file of [".TENT/Mixed/Mixed.md", ".tent/mIXED/mIXED.md", ".TENT/MIXED/MIXED.MD"]) {
        assert.deepEqual(
          await checkNativeNodeWrites(host, root, [file]),
          expected,
          `${host}: ${file}`,
        );
        assert.deepEqual(
          await checkNativeNodeWrites(host, root, [path.join(root, file)]),
          expected,
          `${host}: absolute ${file}`,
        );
      }
    }
  },
);

test(
  "Windows physical identity filename casing uses the catalog's canonical selected path",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, systemRoot } = await fixture(t);
    const expected = await checkNativeNodeWrites("codex", root, [".tent/Mixed/Mixed.md"]);
    await fs.rename(
      path.join(systemRoot, "Mixed/Mixed.md"),
      path.join(systemRoot, "Mixed/identity.tmp"),
    );
    await fs.rename(
      path.join(systemRoot, "Mixed/identity.tmp"),
      path.join(systemRoot, "Mixed/MIXED.MD"),
    );
    assert.equal(
      (await loadNodeCatalog(openTestFs(systemRoot))).byId.get("node-mixed")?.path,
      "Mixed",
    );
    for (const host of ["codex", "claude-code"] as const)
      for (const file of [".tent/Mixed/Mixed.md", ".TENT/MIXED/MIXED.MD"])
        assert.deepEqual(
          await checkNativeNodeWrites(host, root, [file]),
          expected,
          `${host}: ${file}`,
        );
  },
);

test(
  "Linux rejects mismatched system, directory and physical identity casing",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { root, systemRoot } = await fixture(t);
    for (const host of ["codex", "claude-code"] as const) {
      assert.equal((await checkNativeNodeWrites(host, root, [".tent/Mixed/Mixed.md"])).length, 1);
      for (const file of [".TENT/Mixed/Mixed.md", ".tent/mixed/mixed.md", ".tent/Mixed/MIXED.MD"])
        assert.deepEqual(await checkNativeNodeWrites(host, root, [file]), []);
    }
    await fs.rename(
      path.join(systemRoot, "Mixed/Mixed.md"),
      path.join(systemRoot, "Mixed/MIXED.MD"),
    );
    assert.equal((await loadNodeCatalog(openTestFs(systemRoot))).byId.has("node-mixed"), false);
    for (const host of ["codex", "claude-code"] as const)
      assert.deepEqual(await checkNativeNodeWrites(host, root, [".tent/Mixed/MIXED.MD"]), []);
  },
);

test("native case normalization preserves linked checkout, nested root and symlink identity boundaries", async (t) => {
  const { base, root, systemRoot } = await fixture(t);
  await fs.mkdir(path.join(root, ".git/worktrees/linked"), { recursive: true });
  await fs.writeFile(path.join(root, ".git/worktrees/linked/commondir"), "../..\n");
  const linked = path.join(base, "linked");
  await fs.mkdir(linked);
  await fs.writeFile(
    path.join(linked, ".git"),
    `gitdir: ${path.join(root, ".git/worktrees/linked")}\n`,
  );
  const raw = await fs.readFile(path.join(systemRoot, "Mixed/Mixed.md"), "utf8");
  await fs.mkdir(path.join(linked, ".tent/Mixed"), { recursive: true });
  await fs.writeFile(path.join(linked, ".tent/Mixed/Mixed.md"), raw);
  const nested = path.join(root, "nested");
  await fs.mkdir(path.join(nested, ".git"), { recursive: true });
  const outside = path.join(base, "External");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "External.md"), raw);
  await fs.symlink(outside, path.join(systemRoot, "External"), "junction");
  const systemName = process.platform === "win32" ? ".TENT" : ".tent";
  const mainFile = path.join(root, systemName, "Mixed/Mixed.md");
  for (const host of ["codex", "claude-code"] as const) {
    const expected = await checkNativeNodeWrites(host, root, [".tent/Mixed/Mixed.md"]);
    assert.equal(expected.length, 1);
    assert.deepEqual(await checkNativeNodeWrites(host, linked, [mainFile]), expected);
    assert.deepEqual(
      await checkNativeNodeWrites(host, linked, [`${systemName}/Mixed/Mixed.md`]),
      [],
    );
    assert.deepEqual(await checkNativeNodeWrites(host, nested, [mainFile]), []);
    assert.deepEqual(
      await checkNativeNodeWrites(host, root, [`${systemName}/External/External.md`]),
      [],
    );
  }
  await scaffoldInWorkspace(openTestFs(nested), {
    name: "Nested",
    nodes: [
      { id: "node-inner", name: "Inner", type: "prompt", body: "[missing](node-innermissing)" },
    ],
  });
  for (const host of ["codex", "claude-code"] as const) {
    assert.deepEqual(await checkNativeNodeWrites(host, nested, [mainFile]), []);
    const own = await checkNativeNodeWrites(host, nested, [`${systemName}/Inner/Inner.md`]);
    assert.equal(own.length, 1);
    assert.equal(own[0]!.path, ".tent/Inner/Inner.md");
  }
});
