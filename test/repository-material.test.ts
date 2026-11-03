import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { createNode } from "../src/core/graph/ops.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import type { FsAdapter } from "../src/core/store/adapter.js";
async function recordMaterial(
  adapter: FsAdapter,
  parentId: string,
  { resource }: { resource: string },
) {
  const parent = (await loadNodeCatalog(adapter)).byId.get(parentId)!;
  const nodeId = await createNode(
    { fs: adapter, clock: { now: () => "2026-01-01T00:00:00Z" }, tentName: "Material" },
    {
      name: "Output",
      type: "output",
      parentPath: parent.path,
      resource: resource.includes(":") ? resource : "../../../" + resource,
      body: "Result",
    },
  );
  return { nodeId, warnings: [] as string[] };
}
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { editNode, readNodeFile } from "./node-edit.js";

async function fixture(t: TestContext, nestedWorktree = false) {
  const base = await fs.mkdtemp(path.join(testScratchRoot(), "repository-material-"));
  t.after(() =>
    removeTestFixture(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const main = path.join(base, "main"),
    worktree = nestedWorktree ? path.join(main, ".worktrees/topic") : path.join(base, "topic");
  await fs.mkdir(main);
  await git(main, "init", "--quiet", "--initial-branch=main");
  await git(main, "config", "core.autocrlf", "false");
  await fs.mkdir(path.join(main, "assets"));
  await fs.writeFile(path.join(main, "assets/result.txt"), "initial\n");
  await git(main, "add", "assets/result.txt");
  await git(main, "commit", "--quiet", "-m", "test: material");
  await git(main, "worktree", "add", "--quiet", "-b", "topic", worktree);
  return { main, worktree, base };
}

test("missing declared worktree remains unavailable even after merging its material", async (t) => {
  const { main, worktree } = await fixture(t);
  const filename = path.join(worktree, "assets/result.txt");
  await fs.writeFile(filename, "completed\n");
  await git(worktree, "add", "assets/result.txt");
  await git(worktree, "commit", "--quiet", "-m", "test: completed material");
  await initializeTentWorkspace(main);
  const adapter = openTestFs(path.join(main, ".tent"));
  const goal = await createNode(
    { fs: adapter, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Material" },
    { name: "Goal", parentPath: "", type: "goal", body: "Requirement" },
  );
  const resource = pathToFileURL(filename).href;
  const output = await recordMaterial(adapter, goal, { resource });
  await git(main, "merge", "--quiet", "topic");
  await git(main, "worktree", "remove", "--force", worktree);
  assert.equal(await fs.readFile(path.join(main, "assets/result.txt"), "utf8"), "completed\n");
  await assert.rejects(
    adapter.observeMaterial(resource, "Output/Output.md"),
    /ENOENT|no such file/,
  );
  const checked = await runWorkspaceCommand("check", [], { workspace: main, json: true });
  assert.equal(checked.exitCode, 1);
  assert.ok(
    JSON.parse(checked.stdout).issues.some(
      (issue: { kind: string }) => issue.kind === "missing-material-file",
    ),
  );
  const node = await readNodeFile(adapter, output.nodeId);
  await editNode(adapter, output.nodeId, { body: "More context" });
  assert.equal((await readNodeFile(adapter, output.nodeId)).frontmatter.resource, resource);
});

test("file observation checks declared sections without repository discovery", async (t) => {
  const { main } = await fixture(t);
  await initializeTentWorkspace(main);
  const filename = path.join(main, "assets/report.md");
  await fs.writeFile(filename, "# Result\nselected\n# Other\nignored\n");
  const adapter = openTestFs(path.join(main, ".tent"));
  const resource = pathToFileURL(filename).href + "#Result";
  const original = childProcess.execFile;
  const mocked = t.mock.method(
    childProcess,
    "execFile",
    (..._args: Parameters<typeof original>) => {
      throw new Error("material checks do not need Git discovery");
    },
  );
  syncBuiltinESMExports();
  try {
    const initial = await adapter.observeMaterial(resource, "Output/Output.md");
    assert.equal(initial.canonicalPath, await fs.realpath(filename));
    await fs.writeFile(filename, "# Other\nno selected section\n");
    await assert.rejects(adapter.observeMaterial(resource, "Output/Output.md"), /not found/i);
    assert.equal(mocked.mock.callCount(), 0);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("declared file safety and access errors remain authoritative", async (t) => {
  const { main, worktree, base } = await fixture(t);
  await initializeTentWorkspace(main);
  const adapter = openTestFs(path.join(main, ".tent"));
  const filename = path.join(worktree, "assets/result.txt");
  const resource = pathToFileURL(filename).href;
  const unsafe = path.join(base, "unsafe");
  await fs.mkdir(unsafe);
  await fs.writeFile(path.join(unsafe, "result.txt"), "copied bytes\n");
  await fs.rm(path.join(worktree, "assets"), { recursive: true });
  await fs.symlink(
    unsafe,
    path.join(worktree, "assets"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(adapter.observeMaterial(resource, "Output/Output.md"), /Symbolic links/);
  await fs.unlink(path.join(worktree, "assets"));
  await fs.mkdir(path.join(worktree, "assets"));
  await fs.writeFile(filename, "live bytes\n");
  const blocked = t.mock.method(fs, "open", async () => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(adapter.readMaterialText(resource, "Output/Output.md"), /access denied/);
  } finally {
    blocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("committed main deletion stays unavailable with a retained or reused worktree path", async (t) => {
  const { main, worktree } = await fixture(t, true);
  await initializeTentWorkspace(main);
  const adapter = openTestFs(path.join(main, ".tent"));
  const goal = await createNode(
    { fs: adapter, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Deletion" },
    { name: "Goal", parentPath: "", type: "goal", body: "Requirement" },
  );
  await recordMaterial(adapter, goal, { resource: "assets/result.txt" });
  await git(main, "rm", "assets/result.txt");
  await git(main, "commit", "--quiet", "-m", "test: delete material in main");
  const unavailable = async () => {
    await assert.rejects(
      adapter.observeMaterial("../../assets/result.txt", "Output/Output.md"),
      /ENOENT|no such file/,
    );
    const check = await runWorkspaceCommand("check", [], { workspace: main, json: true });
    assert.equal(check.exitCode, 1, check.stderr || check.stdout);
    assert.ok(
      JSON.parse(check.stdout).issues.some(
        (issue: { kind: string }) => issue.kind === "missing-material-file",
      ),
    );
  };
  assert.equal(await fs.readFile(path.join(worktree, "assets/result.txt"), "utf8"), "initial\n");
  await unavailable();
  await git(main, "worktree", "remove", worktree);
  await git(main, "worktree", "add", "--quiet", "-b", "reused", worktree, "topic");
  await fs.writeFile(path.join(worktree, "assets/result.txt"), "new branch WIP\n");
  await unavailable();
  await fs.mkdir(path.join(main, "assets"), { recursive: true });
  await fs.writeFile(path.join(main, "assets/result.txt"), "initial\n");
  await adapter.observeMaterial("../../assets/result.txt", "Output/Output.md");
  await git(main, "add", "assets/result.txt");
  await git(main, "commit", "--quiet", "-m", "test: restore material");
  await fs.unlink(path.join(main, "assets/result.txt"));
  await unavailable();
  await git(main, "reset", "--hard", "HEAD~2");
  await fs.unlink(path.join(main, "assets/result.txt"));
  await unavailable();
});

test("declared worktree materials observe that exact live path, including when reused", async (t) => {
  const { main, worktree } = await fixture(t, true);
  await initializeTentWorkspace(main);
  const adapter = openTestFs(path.join(main, ".tent"));
  const goal = await createNode(
    { fs: adapter, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Live checkout" },
    { name: "Goal", parentPath: "", type: "goal", body: "Requirement" },
  );
  const resource = pathToFileURL(path.join(worktree, "assets/result.txt")).href;
  await recordMaterial(adapter, goal, { resource });
  await fs.writeFile(path.join(main, "assets/result.txt"), "main changed\n");
  assert.equal(await adapter.readMaterialText(resource, "Output/Output.md"), "initial\n");
  await git(main, "worktree", "remove", worktree);
  await git(main, "worktree", "add", "--quiet", "-b", "reused", worktree, "topic");
  await fs.writeFile(path.join(worktree, "assets/result.txt"), "reused branch WIP\n");
  assert.equal(await adapter.readMaterialText(resource, "Output/Output.md"), "reused branch WIP\n");
});
