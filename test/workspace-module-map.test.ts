import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { checkWorkspaceModules } from "../src/core/workspace-module-map.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { readModuleMapRepository, readWorkspaceScanRepository } from "../src/fs/workspace-scan.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

const structure = (resource: string) => ({ sources: [{ resource, track: "structure" }] });

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "module-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await git(root, "init", "-b", "main");
  await scaffoldInWorkspace(new NodeFs(root), { name: "Map" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  const write = async (file: string, body: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  };
  const node = (name: string, data: Record<string, unknown>, body = "") =>
    adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter({ id: `node-${name}`, type: "prompt", ...data }, body),
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

test("module command is silent for a good map, deterministic and byte-for-byte read-only before native capture", async (t) => {
  const { root, write, node } = await fixture(t);
  await write("src/alpha-one.ts", "export const one = 1;");
  await write("src/alpha-two.ts", "export const two = 2;");
  await write("README.md", "# Readme");
  await git(root, "add", "src", "README.md");
  await git(root, "commit", "-m", "files");
  await node("alpha1", structure("../../src/alpha-*"));
  await node("setup1", { resource: "../../README.md" });
  const before = await snapshot(root);
  const text = await runWorkspaceCommand("check-modules", [], { workspace: root });
  assert.deepEqual(text, { exitCode: 0, stdout: "", stderr: "" });
  const first = await runWorkspaceCommand("check-modules", ["--json"], { workspace: root });
  const second = await runWorkspaceCommand("check-modules", ["--json"], { workspace: root });
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first, second);
  const result = JSON.parse(first.stdout);
  assert.deepEqual(result.issues, []);
  assert.equal(result.modules.length, 1);
  assert.deepEqual(result.modules[0].files, ["src/alpha-one.ts", "src/alpha-two.ts"]);
  assert.deepEqual(await snapshot(root), before);
});

test("coverage excludes deprecated and invalid Nodes, keeps file-only Nodes, and reports invalid prefix declarations without writes", async (t) => {
  const { root, write, node } = await fixture(t);
  for (const file of ["a.ts", "b.ts", "c.ts", "d.ts"]) await write(file, "export {};");
  await git(root, "add", "a.ts", "b.ts", "c.ts", "d.ts");
  await node("active", { resource: "../../a.ts" });
  await node("oldold", { resource: "../../b.ts", status: "deprecated" });
  await node("badbad", { resource: "../../c.ts", type: "unknown" });
  await node("prefix", { resource: "../../d**" });
  const before = await snapshot(root);
  const result = await runWorkspaceCommand("check-modules", ["--json"], { workspace: root });
  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.modules.length, 0);
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
  await node("aaaaaa", structure("../../a/"));
  await node("bbbbbb", structure("../../b/"));
  const files = Array.from({ length: 3 }, (_, i) => [`a/${i}.ts`, `b/${i}.ts`]).flat();
  const sources = files.map((file) => ({
    path: file,
    content: `import '../${file.startsWith("a/") ? "b" : "a"}/${path.posix.basename(file)}';`,
  }));
  const repository = {
    head: null,
    trackedFiles: files,
    markdownFiles: [],
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
    await node("aaaaaa", structure("../../a/"), body);
    assert.equal((await inspect()).issues.filter((issue) => issue.code === "deps.cycle").length, 1);
  }
  await node(
    "aaaaaa",
    structure("../../a/"),
    "allow:deps.cycle [B](../bbbbbb/bbbbbb.md) 共用链接解析",
  );
  assert.equal((await inspect()).issues.filter((issue) => issue.code === "deps.cycle").length, 0);
  await node("aaaaaa", structure("../../a/"));
  await node("bbbbbb", structure("../../b/"), "allow:deps.cycle [A](../aaaaaa/aaaaaa.md)");
  assert.equal((await inspect()).issues.filter((issue) => issue.code === "deps.cycle").length, 0);
});

test("ordinary directories and files cover without becoming modules, structure tracks opt in and invalid structure files are diagnosed", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node("legacy", { resource: "../../legacy/" });
  await node("normal", { sources: [{ resource: "../../normal/" }] });
  await node("single", { resource: "../../single.ts" });
  await node("module", structure("../../module/*"));
  await node("badfile", structure("../../bad.ts"));
  await node("oldmap", { ...structure("../../old/"), status: "deprecated" });
  const repository = {
    head: null,
    trackedFiles: ["legacy/a.ts", "normal/a.ts", "single.ts", "module/a.ts", "bad.ts", "old/a.ts"],
    markdownFiles: [],
    commits: [],
    sources: { files: [], errors: [] },
  };
  const before = await snapshot(root);
  const result = await checkWorkspaceModules(adapter, root, repository);
  assert.deepEqual(
    result.modules.map(({ name }) => name),
    ["module"],
  );
  assert.equal(result.inspectionErrors.length, 1);
  assert.equal(result.inspectionErrors[0]!.node, "badfile");
  assert.deepEqual(
    result.issues.flatMap((issue) => issue.facts.files ?? []),
    ["bad.ts", "old/a.ts"],
  );
  assert.deepEqual(await snapshot(root), before);
});

test("module history follows first-parent while scan keeps all selected commits", async (t) => {
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
  assert.equal(scanRepo.commits.length, 4);
  assert.deepEqual(moduleRepo.commits[0]!.files, ["feature.md"]);
  assert.deepEqual(await snapshot(root), before);
});
