import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode } from "../src/core/graph/ops.js";
import { inspectNodeSync, linkNodeOutput } from "../src/core/graph/node-sync.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";

async function fixture(t: TestContext, nestedWorktree = false) {
  const base = await fs.mkdtemp(path.join(testScratchRoot(), "repository-material-"));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
  const adapter = new NodeFs(path.join(main, ".tent"));
  const goal = await createNode(
    { fs: adapter, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Material" },
    { name: "Goal", parentPath: "", type: "goal", body: "Requirement" },
  );
  const resource = pathToFileURL(filename).href;
  const output = await linkNodeOutput(adapter, goal, { resource });
  const record = (await adapter.history.nodeRecords())[output.nodeId]!;
  assert.equal(record.materials[0]!.repository, undefined);
  assert.equal((await inspectNodeSync(adapter, output.nodeId)).state, "synced");
  await fs.writeFile(filename, "declared live change\n");
  assert.equal((await inspectNodeSync(adapter, output.nodeId)).materials[0]!.state, "changed");
  await fs.writeFile(filename, "completed\n");
  // Old locators remain readable but cannot authorize another checkout.
  await adapter.history.captureUnlocked([], {
    operation: "test.legacy-material",
    nodeRecords: {
      [output.nodeId]: {
        ...record,
        materials: record.materials.map((material) => ({
          ...material,
          repository: { commonDir: ".git", path: "assets/result.txt", blob: "a".repeat(40) },
        })),
      },
    },
  });
  await git(main, "merge", "--quiet", "topic");
  await git(main, "worktree", "remove", "--force", worktree);
  assert.equal(await fs.readFile(path.join(main, "assets/result.txt"), "utf8"), "completed\n");
  const unavailable = await inspectNodeSync(adapter, output.nodeId);
  assert.equal(unavailable.state, "synced");
  assert.equal(unavailable.materials[0]!.state, "unavailable");
  assert.match(unavailable.materials[0]!.reason!, /ENOENT|no such file/);
  const checked = await runWorkspaceCommand("check", [], { workspace: main, json: true });
  const result = JSON.parse(checked.stdout);
  assert.equal(checked.exitCode, 1);
  assert.ok(
    result.issues.some((issue: { kind: string }) => issue.kind === "missing-material-file"),
  );
  assert.deepEqual(result.notices, []);
  const node = await readNodeForEdit(adapter, output.nodeId);
  await writeNodeDocument(adapter, output.nodeId, { baseEtag: node.etag, body: "More context" });
  assert.equal(
    (await adapter.history.nodeRecords())[output.nodeId]!.materials[0]!.repository,
    undefined,
  );
  assert.equal((await readNodeForEdit(adapter, output.nodeId)).frontmatter.resource, resource);
});

test("file observation reads declared bytes and sections without repository discovery", async (t) => {
  const { main } = await fixture(t);
  await initializeTentWorkspace(main);
  const filename = path.join(main, "assets/report.md");
  await fs.writeFile(filename, "# Result\nselected\n# Other\nignored\n");
  const adapter = new NodeFs(path.join(main, ".tent"));
  const resource = pathToFileURL(filename).href + "#Result";
  const original = childProcess.execFile;
  const mocked = t.mock.method(
    childProcess,
    "execFile",
    (..._args: Parameters<typeof original>) => {
      throw new Error("material content does not need Git discovery");
    },
  );
  syncBuiltinESMExports();
  try {
    const initial = await adapter.observeMaterial(resource, "Output/Output.md");
    await fs.writeFile(filename, "# Result\nselected\n# Other\nchanged\n");
    assert.equal(
      (await adapter.observeMaterial(resource, "Output/Output.md")).observedVersion,
      initial.observedVersion,
    );
    await fs.writeFile(filename, "# Result\nchanged\n# Other\nignored\n");
    assert.notEqual(
      (await adapter.observeMaterial(resource, "Output/Output.md")).observedVersion,
      initial.observedVersion,
    );
    assert.equal("repository" in initial, false);
    assert.equal(mocked.mock.callCount(), 0);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("declared file safety and access errors remain authoritative", async (t) => {
  const { main, worktree, base } = await fixture(t);
  await initializeTentWorkspace(main);
  const adapter = new NodeFs(path.join(main, ".tent"));
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
    await assert.rejects(adapter.observeMaterial(resource, "Output/Output.md"), /access denied/);
  } finally {
    blocked.mock.restore();
    syncBuiltinESMExports();
  }
});
test("committed main deletion stays unavailable with a retained or reused worktree path", async (t) => {
  const { main, worktree } = await fixture(t, true);
  await initializeTentWorkspace(main);
  const adapter = new NodeFs(path.join(main, ".tent"));
  const goal = await createNode(
    { fs: adapter, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Deletion" },
    { name: "Goal", parentPath: "", type: "goal", body: "Requirement" },
  );
  const output = await linkNodeOutput(adapter, goal, { resource: "assets/result.txt" });
  assert.equal((await inspectNodeSync(adapter, output.nodeId)).state, "synced");
  await git(main, "rm", "assets/result.txt");
  await git(main, "commit", "--quiet", "-m", "test: delete material in main");
  const unavailable = async () => {
    const state = await inspectNodeSync(adapter, output.nodeId);
    assert.equal(state.state, "synced");
    assert.equal(state.materials[0]!.state, "unavailable");
    assert.match(state.materials[0]!.reason!, /ENOENT|no such file/);
    const node = await runNodeCommand("check", [output.nodeId], { workspace: main, json: true });
    assert.equal(JSON.parse(node.stdout).materials[0].state, "unavailable");
    const check = await runWorkspaceCommand("check", [], { workspace: main, json: true });
    assert.equal(check.exitCode, 1, check.stderr || check.stdout);
    assert.ok(
      JSON.parse(check.stdout).issues.some(
        (issue: { kind: string }) => issue.kind === "missing-material-file",
      ),
    );
    assert.deepEqual(JSON.parse(check.stdout).notices, []);
  };
  assert.equal(await fs.readFile(path.join(worktree, "assets/result.txt"), "utf8"), "initial\n");
  await unavailable();
  // The same declared main path cannot follow a new branch reusing the old checkout.
  await git(main, "worktree", "remove", worktree);
  await git(main, "worktree", "add", "--quiet", "-b", "reused", worktree, "topic");
  await fs.writeFile(path.join(worktree, "assets/result.txt"), "new branch WIP\n");
  await unavailable();
  // A live main file is still authoritative after an earlier deletion of its path.
  await fs.mkdir(path.join(main, "assets"), { recursive: true });
  await fs.writeFile(path.join(main, "assets/result.txt"), "initial\n");
  assert.equal((await inspectNodeSync(adapter, output.nodeId)).materials[0]!.state, "current");
  await git(main, "add", "assets/result.txt");
  await git(main, "commit", "--quiet", "-m", "test: restore material");
  await fs.unlink(path.join(main, "assets/result.txt"));
  await unavailable();
  // A moved main HEAD is inspected afresh, including removal of the deletion history.
  await git(main, "reset", "--hard", "HEAD~2");
  await fs.unlink(path.join(main, "assets/result.txt"));
  const legal = await inspectNodeSync(adapter, output.nodeId);
  assert.equal(legal.materials[0]!.state, "unavailable");
  assert.match(legal.materials[0]!.reason!, /ENOENT|no such file/);
});

test("worktree path warnings preserve creation and the declared live-path observation contract", async (t) => {
  const { main, worktree } = await fixture(t, true);
  await initializeTentWorkspace(main);
  const adapter = new NodeFs(path.join(main, ".tent"));
  const goal = await createNode(
    { fs: adapter, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Live checkout" },
    { name: "Goal", parentPath: "", type: "goal", body: "Requirement" },
  );
  const relative = ".worktrees/topic/assets/result.txt";
  const linked = await runNodeCommand("link-output", [goal, "--resource", relative], {
    workspace: main,
    json: true,
  });
  assert.equal(linked.exitCode, 0, linked.stderr);
  const receipt = JSON.parse(linked.stdout);
  assert.ok(receipt.nodeId);
  assert.match(receipt.warnings[0], /先合并到主检出，再挂产出/);
  const text = await runNodeCommand("link-output", [goal, "--resource", `/${relative}`], {
    workspace: main,
  });
  assert.equal(text.exitCode, 0, text.stderr);
  assert.match(text.stdout, /先合并到主检出，再挂产出/);
  const uri = await linkNodeOutput(adapter, goal, {
    resource: pathToFileURL(path.join(worktree, "assets/result.txt")).href,
  });
  assert.match(uri.warnings![0]!, /先合并到主检出，再挂产出/);
  await fs.writeFile(path.join(main, "assets/result.txt"), "main changed\n");
  const retained = await inspectNodeSync(adapter, receipt.nodeId);
  assert.equal(
    retained.materials[0]!.state,
    "current",
    "a surviving declared worktree file still wins",
  );
  assert.equal(retained.materials[0]!.reason, undefined);
  await git(main, "worktree", "remove", worktree);
  await git(main, "worktree", "add", "--quiet", "-b", "reused", worktree, "topic");
  await fs.writeFile(path.join(worktree, "assets/result.txt"), "reused branch WIP\n");
  assert.equal((await inspectNodeSync(adapter, receipt.nodeId)).materials[0]!.state, "changed");
});
