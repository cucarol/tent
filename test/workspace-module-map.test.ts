import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { checkWorkspaceModules } from "../src/core/check/workspace-module-map.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  parseModuleMapGitLog,
  readModuleMapRepository,
  readWorkspaceScanRepository,
} from "../src/fs/workspace-scan.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

const materials = (resource: string) => ({ sources: [{ resource }] });

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "module-map-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await git(root, "init", "-b", "main");
  await scaffoldInWorkspace(openTestFs(root), { name: "Map" });
  await fs.writeFile(path.join(root, ".tent/.gitignore"), "*\n");
  const adapter = openTestFs(path.join(root, ".tent"));
  const write = async (file: string, body: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  };
  const node = (name: string, data: Record<string, unknown>, body = "") =>
    adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter({ id: `node-${name}`, type: "goal", ...data }, body),
    );
  return { root, adapter, write, node };
}

async function snapshot(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(root, entry.name),
      relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(full, relative + "/"));
    else
      result[relative] = createHash("sha256")
        .update(await fs.readFile(full))
        .digest("hex");
  }
  return result;
}

test("module facts are deterministic and byte-for-byte read-only before native capture", async (t) => {
  const { root, adapter, write, node } = await fixture(t);
  await write("src/alpha-one.ts", "export const one = 1;");
  await write("src/alpha-two.ts", "export const two = 2;");
  await write("README.md", "# Readme");
  await git(root, "add", "src", "README.md");
  await git(root, "commit", "-m", "files");
  await node("alpha1", materials("../../src/alpha-*"));
  await node("setup1", { resource: "../../README.md" });
  const before = await snapshot(root);
  const repository = await readModuleMapRepository(root);
  const result = await checkWorkspaceModules(adapter, root, repository);
  assert.deepEqual(await checkWorkspaceModules(adapter, root, repository), result);
  assert.deepEqual(result.issues, []);
  assert.equal(result.partFacts.length, 2);
  assert.deepEqual(result.partFacts.find(({ name }) => name === "alpha1")?.files, [
    "src/alpha-one.ts",
    "src/alpha-two.ts",
  ]);
  assert.deepEqual(await snapshot(root), before);
});

test("coverage excludes deprecated and invalid Nodes, keeps file-only Nodes, and reports invalid prefix declarations without writes", async (t) => {
  const { root, adapter, write, node } = await fixture(t);
  for (const file of ["a.ts", "b.ts", "c.ts", "d.ts"]) await write(file, "export {};");
  await git(root, "add", "a.ts", "b.ts", "c.ts", "d.ts");
  await node("active", { resource: "../../a.ts" });
  await node("oldold", { resource: "../../b.ts", status: "deprecated" });
  await node("badbad", { resource: "../../c.ts", type: "unknown" });
  await node("prefix", { resource: "../../d**" });
  const before = await snapshot(root);
  const parsed = await checkWorkspaceModules(adapter, root, await readModuleMapRepository(root));
  assert.equal(parsed.partFacts.length, 1);
  assert.equal(parsed.inspectionErrors.length, 2);
  const uncovered = parsed.issues.filter(
    (issue: { code: string }) => issue.code === "map.uncovered",
  );
  assert.match(JSON.stringify(uncovered), /b\.ts/);
  assert.match(JSON.stringify(uncovered), /c\.ts/);
  assert.match(JSON.stringify(uncovered), /d\.ts/);
  assert.doesNotMatch(JSON.stringify(uncovered), /a\.ts/);
  assert.deepEqual(await snapshot(root), before);
});

test("pair exceptions resolve real Markdown links on the same line, from either side", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node("aaaaaa", materials("../../a/"));
  await node("bbbbbb", materials("../../b/"));
  const files = Array.from({ length: 3 }, (_, i) => [`a/${i}.ts`, `b/${i}.ts`]).flat();
  const sources = files.map((file) => ({
    path: file,
    content: `import '../${file.startsWith("a/") ? "b" : "a"}/${path.posix.basename(file)}';`,
  }));
  const repository = {
    head: null,
    trackedFiles: files,
    commits: [],
    sources: { files: sources, errors: [] },
  };
  const inspect = () => checkWorkspaceModules(adapter, root, repository);
  assert.equal((await inspect()).issues.filter((issue) => issue.code === "deps.cycle").length, 1);
  for (const body of [
    "必须修复 deps.cycle [B](../bbbbbb/bbbbbb.md)",
    "deps.cycle [B](../bbbbbb/bbbbbb.md)",
    "allow: deps.cycle [B](../bbbbbb/bbbbbb.md)",
    "disallow:deps.cycle [B](../bbbbbb/bbbbbb.md)",
    "allow:deps.cycleness [B](../bbbbbb/bbbbbb.md)",
    "deps.cycle\n[B](../bbbbbb/bbbbbb.md)",
    "allow:deps.cycle\n[B](../bbbbbb/bbbbbb.md)",
    "```md\nallow:deps.cycle [B](../bbbbbb/bbbbbb.md)\n```",
    "allow:deps.cycle [wrong](../missing/missing.md)",
    "deps.cycleness [B](../bbbbbb/bbbbbb.md)",
  ]) {
    await node("aaaaaa", materials("../../a/"), body);
    assert.equal((await inspect()).issues.filter((issue) => issue.code === "deps.cycle").length, 1);
  }
  await node(
    "aaaaaa",
    materials("../../a/"),
    "allow:deps.cycle [B](../bbbbbb/bbbbbb.md) 共用链接解析",
  );
  assert.equal((await inspect()).issues.filter((issue) => issue.code === "deps.cycle").length, 0);
  await node("aaaaaa", materials("../../a/"));
  await node("bbbbbb", materials("../../b/"), "allow:deps.cycle [A](../aaaaaa/aaaaaa.md)");
  assert.equal((await inspect()).issues.filter((issue) => issue.code === "deps.cycle").length, 0);
});

test("goals establish part coverage through directories, prefixes and files; other types do not", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node("legacy", { resource: "../../legacy/" });
  await node("normal", materials("../../normal/"));
  await node("single", { resource: "../../single.ts#Part" });
  await node("module", materials("../../module/*"));
  await node("oldmap", { ...materials("../../old/"), status: "deprecated" });
  await node("rule", { type: "prompt", resource: "../../rule/" });
  await node("result", { type: "output", resource: "../../result.ts" });
  const repository = {
    head: null,
    trackedFiles: [
      "legacy/a.ts",
      "normal/a.ts",
      "single.ts",
      "module/a.ts",
      "old/a.ts",
      "rule/a.ts",
      "result.ts",
    ],
    commits: [],
    sources: { files: [], errors: [] },
  };
  const before = await snapshot(root);
  const result = await checkWorkspaceModules(adapter, root, repository);
  assert.deepEqual(
    result.partFacts.map(({ name }) => name),
    ["legacy", "module", "normal", "single"],
  );
  assert.deepEqual(result.inspectionErrors, []);
  assert.deepEqual(
    result.issues
      .filter(({ code }) => code === "map.uncovered")
      .flatMap(({ facts }) => facts.files ?? [])
      .sort(),
    ["old/a.ts", "result.ts", "rule/a.ts"],
  );
  assert.deepEqual(await snapshot(root), before);
});

test("module exceptions remain in the declaring Node regardless of child type", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node("aaaaaa", { type: "goal", ...materials("../../a/") });
  await node("bbbbbb", { type: "goal", ...materials("../../b/") });
  const writeRule = (folder: string, type: string, body: string) =>
    adapter.writeFile(
      `${folder}/Rules/Rules.md`,
      serializeFrontmatter({ id: "node-rule01", type }, body),
    );
  const files = Array.from(
    { length: 30 },
    (_, i) => `a/${i < 15 ? "first" : "second"}-${i % 15}.ts`,
  ).concat(["b/first-0.ts", "b/first-1.ts", "b/first-2.ts"]);
  const repository = {
    head: null,
    trackedFiles: files,
    commits: [],
    sources: {
      files: files
        .slice(0, 3)
        .concat(files.slice(-3))
        .map((file) => ({
          path: file,
          content: `import '../${file.startsWith("a/") ? "b" : "a"}/${path.posix.basename(file)}';`,
        })),
      errors: [],
    },
  };
  const codes = async () =>
    (await checkWorkspaceModules(adapter, root, repository)).issues.map((issue) => issue.code);
  assert.ok((await codes()).includes("part.oversized"));
  assert.ok((await codes()).includes("deps.cycle"));
  const rules = "allow:part.oversized\nallow:deps.cycle [B](../../bbbbbb/bbbbbb.md)";
  await writeRule("aaaaaa", "output", rules);
  assert.ok((await codes()).includes("part.oversized"));
  assert.ok((await codes()).includes("deps.cycle"));
  await writeRule("aaaaaa", "prompt", rules);
  const before = await snapshot(root);
  assert.ok((await codes()).includes("part.oversized"));
  assert.ok((await codes()).includes("deps.cycle"));
  assert.deepEqual(await snapshot(root), before);
  await adapter.writeFile(
    "aaaaaa/Nested/Nested.md",
    serializeFrontmatter(
      {
        id: "node-nested",
        type: "goal",
        ...materials("../../../nested/"),
      },
      "",
    ),
  );
  await adapter.move("aaaaaa/Rules", "aaaaaa/Nested/Rules");
  await writeRule("aaaaaa/Nested", "prompt", rules.replace("../../bbbbbb/", "../../../bbbbbb/"));
  assert.ok((await codes()).includes("deps.cycle"));
});

test("draft rules, pair exceptions and directory declarations have the same module effect as stable", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node("aaaaaa", { type: "goal", ...materials("../../a/") });
  await node("bbbbbb", { type: "goal", ...materials("../../b/") });
  const files = Array.from({ length: 30 }, (_, i) => `a/${i}.ts`).concat(
    Array.from({ length: 3 }, (_, i) => `b/${i}.ts`),
  );
  const repository = {
    head: null,
    trackedFiles: files,
    commits: [],
    sources: {
      files: files
        .slice(0, 3)
        .concat(files.slice(-3))
        .map((file) => ({
          path: file,
          content: `import '../${file.startsWith("a/") ? "b" : "a"}/${path.posix.basename(file)}';`,
        })),
      errors: [],
    },
  };
  const inspect = () => checkWorkspaceModules(adapter, root, repository);
  const baseline = await inspect();
  await adapter.writeFile(
    "aaaaaa/Rules/Rules.md",
    serializeFrontmatter(
      { id: "node-rule01", type: "prompt", status: "draft" },
      "allow:part.oversized\nallow:deps.cycle [B](../../bbbbbb/bbbbbb.md)",
    ),
  );
  const draftRules = await inspect();
  const ruleRaw = await adapter.readFile("aaaaaa/Rules/Rules.md");
  await adapter.writeFile(
    "aaaaaa/Rules/Rules.md",
    ruleRaw.replace("status: draft", "status: stable"),
  );
  assert.deepEqual(await inspect(), draftRules);
  assert.deepEqual(draftRules, baseline);
  await node(
    "drafts",
    { type: "goal", status: "draft", ...materials("../../c/") },
    "allow:map.empty",
  );
  const draftModule = await inspect();
  assert.ok(draftModule.partFacts.some((module) => module.id === "node-drafts"));
  const moduleRaw = await adapter.readFile("drafts/drafts.md");
  await adapter.writeFile("drafts/drafts.md", moduleRaw.replace("status: draft", "status: stable"));
  assert.deepEqual(await inspect(), draftModule);
  await adapter.writeFile(
    "drafts/Decided/Decided.md",
    serializeFrontmatter(
      {
        id: "node-decided",
        type: "goal",
        ...materials("../../../c/"),
      },
      "",
    ),
  );
  assert.ok((await inspect()).partFacts.some((module) => module.id === "node-decided"));
});

test("file materials assign root build code without a separate ownership declaration", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node("setup1", { resource: "../../build.rs" });
  await node("source", materials("../../src/"));
  const before = await snapshot(root);
  const result = await checkWorkspaceModules(adapter, root, {
    head: null,
    trackedFiles: ["build.rs", "src/lib.rs"],
    commits: [],
    sources: { files: [], errors: [] },
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.partFacts.map(({ name, files }) => ({ name, files })),
    [
      { name: "setup1", files: ["build.rs"] },
      { name: "source", files: ["src/lib.rs"] },
    ],
  );
  assert.deepEqual(await snapshot(root), before);
});

test("module history follows first-parent while scan collects current facts only", async (t) => {
  const { root, write } = await fixture(t);
  await write("base.md", "base");
  await git(root, "add", "base.md");
  await git(root, "commit", "-m", "base");
  await git(root, "checkout", "-b", "feature");
  await write("feature.md", "feature");
  await git(root, "add", "feature.md");
  await git(root, "commit", "-m", "feature");
  await git(root, "checkout", "main");
  await write("main.md", "main");
  await git(root, "add", "main.md");
  await git(root, "commit", "-m", "main");
  await git(root, "merge", "--no-ff", "feature", "-m", "merge");
  const before = await snapshot(root);
  const moduleRepo = await readModuleMapRepository(root);
  const scanRepo = await readWorkspaceScanRepository(root);
  assert.equal(moduleRepo.commits.length, 3);
  assert.ok(!Object.prototype.hasOwnProperty.call(scanRepo, "commits"));
  assert.deepEqual(scanRepo.trackedFiles, moduleRepo.trackedFiles);
  assert.deepEqual(scanRepo.sources, moduleRepo.sources);
  assert.deepEqual(moduleRepo.commits[0]!.files, ["feature.md"]);
  assert.deepEqual(await snapshot(root), before);
});

test("module history preserves unborn/nested workspaces, root changes and newline-safe filenames", async (t) => {
  const { root, write } = await fixture(t);
  const unborn = await readModuleMapRepository(root);
  assert.equal(unborn.head, null);
  assert.deepEqual(unborn.commits, []);
  await write("new.md", "new");
  await write("nested/source file.md", "source");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "source");
  await git(root, "config", "log.showRoot", "false");
  await git(root, "config", "log.showSignature", "true");
  const nested = await readModuleMapRepository(path.join(root, "nested"));
  assert.deepEqual(nested.trackedFiles, ["source file.md"]);
  assert.deepEqual(nested.commits[0]!.files, ["source file.md"]);
  assert.equal(nested.commits[0]!.changedFiles, 2);
  if (process.platform === "win32")
    assert.deepEqual(await readModuleMapRepository(path.join(root, "NESTED")), nested);
  const sha = "a".repeat(40),
    next = "b".repeat(40);
  assert.deepEqual(parseModuleMapGitLog(`\0${sha}\0\n\nleading.md\0${next}\0\0${next}\0`), [
    { commit: sha, files: ["\nleading.md", next], changedFiles: 2 },
    { commit: next, files: [], changedFiles: 0 },
  ]);
});

test("module history counts gitlink changes even when Git is configured to ignore submodules", async (t) => {
  const { root, write } = await fixture(t);
  await write("doc.md", "doc");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "source");
  const first = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "update-index", "--add", "--cacheinfo", `160000,${first},vendor/mod`);
  await git(root, "commit", "-m", "add gitlink");
  const before = await readModuleMapRepository(root);
  assert.deepEqual(before.commits[0]!.files, ["vendor/mod"]);
  await git(root, "config", "diff.ignoreSubmodules", "all");
  assert.deepEqual(await readModuleMapRepository(root), before);
});

test("module history refuses missing partial-clone trees without fetching or writing Git state", async (t) => {
  const { root, write } = await fixture(t);
  await write("doc.md", "doc");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "source");
  await git(root, "config", "uploadpack.allowFilter", "true");
  const partial = await fs.mkdtemp(path.join(testScratchRoot(), "scan-partial-"));
  t.after(() =>
    removeTestFixture(partial, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await git(
    root,
    "clone",
    "--filter=tree:0",
    "--no-checkout",
    "--no-local",
    pathToFileURL(root).href,
    partial,
  );
  const before = await snapshot(partial);
  const scan = await readWorkspaceScanRepository(partial);
  assert.deepEqual(scan.trackedFiles, []);
  assert.ok(!Object.prototype.hasOwnProperty.call(scan, "commits"));
  await assert.rejects(
    readModuleMapRepository(partial),
    /bad tree object|unable to read tree|could not read/i,
  );
  assert.deepEqual(await snapshot(partial), before);
});
