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
import {
  observedRepositoryMaterial,
  relocatedRepositoryMaterial,
} from "../src/fs/repository-material.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode } from "../src/core/ops.js";
import { inspectNodeSync, linkNodeOutput } from "../src/core/node-sync.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(testScratchRoot(), "repository-material-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const main = path.join(base, "main"),
    worktree = path.join(base, "topic");
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
function blobs(raw: string) {
  const bytes = Buffer.from(raw);
  const blob = (algorithm: string) =>
    createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { sha1: blob("sha1"), sha256: blob("sha256") };
}

test("repository metadata retains tracked raw bytes, and surviving main is used after worktree removal", async (t) => {
  const { main, worktree } = await fixture(t);
  const filename = path.join(worktree, "assets/result.txt");
  const raw = "completed\n";
  await fs.writeFile(filename, raw);
  const basis = await observedRepositoryMaterial(filename, blobs(raw));
  assert.ok(basis);
  assert.equal(basis.path, "assets/result.txt");
  assert.equal(basis.blob, (await git(worktree, "hash-object", "assets/result.txt")).trim());
  await git(worktree, "add", "assets/result.txt");
  await git(worktree, "commit", "--quiet", "-m", "test: complete material");
  await git(main, "merge", "--quiet", "topic");
  await git(main, "worktree", "remove", worktree);
  const relocated = await relocatedRepositoryMaterial(main, basis);
  assert.equal(relocated.filename, path.join(main, "assets/result.txt"));
  assert.equal(await fs.readFile(relocated.filename, "utf8"), raw);
  await fs.writeFile(relocated.filename, "live changed\n");
  assert.equal(
    await fs.readFile((await relocatedRepositoryMaterial(main, basis)).filename, "utf8"),
    "live changed\n",
  );
  await fs.unlink(relocated.filename);
  await assert.rejects(relocatedRepositoryMaterial(main, basis), /no surviving local file/);
});

test("repository fallback prefers current checkout and rejects a symlink instead of using another checkout", async (t) => {
  const { main, worktree, base } = await fixture(t);
  const basis = await observedRepositoryMaterial(
    path.join(main, "assets/result.txt"),
    blobs("initial\n"),
  );
  assert.ok(basis);
  assert.equal(
    (await relocatedRepositoryMaterial(worktree, basis)).filename,
    path.join(worktree, "assets/result.txt"),
  );
  const other = path.join(base, "other");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "result.txt"), "unsafe\n");
  await fs.rm(path.join(worktree, "assets"), { recursive: true });
  await fs.symlink(other, path.join(worktree, "assets"), "junction");
  await assert.rejects(relocatedRepositoryMaterial(worktree, basis), /Symbolic links/);
  const untracked = path.join(main, "untracked.txt");
  await fs.writeFile(untracked, "ordinary\n");
  assert.equal(await observedRepositoryMaterial(untracked, blobs("ordinary\n")), undefined);
});

test("Node material survives merge and deleted worktree, while live edits and true absence remain drift", async (t) => {
  const { main, worktree, base } = await fixture(t);
  await git(main, "config", "core.autocrlf", "true");
  const filename = path.join(worktree, "assets/result.txt");
  await fs.writeFile(filename, "completed\n");
  await git(worktree, "add", "assets/result.txt");
  await git(worktree, "commit", "--quiet", "-m", "test: finished output");
  await initializeTentWorkspace(main);
  const adapter = new NodeFs(path.join(main, ".tent"));
  const goal = await createNode(
    { fs: adapter, clock: { now: () => "2026-10-06T00:00:00Z" }, tentName: "Relocation" },
    {
      name: "Goal",
      parentPath: "",
      type: "goal-requirement",
      body: "Requirement",
    },
  );
  const resource = pathToFileURL(filename).href;
  const output = await linkNodeOutput(adapter, goal, { resource });
  const basis = (await adapter.history.nodeRecords())[output.nodeId]!.materials[0]!;
  assert.equal(basis.repository!.path, "assets/result.txt");
  assert.equal(
    basis.repository!.blob,
    (await git(worktree, "hash-object", "--no-filters", "assets/result.txt")).trim(),
  );
  assert.equal((await inspectNodeSync(adapter, output.nodeId)).state, "synced");
  await fs.writeFile(filename, "explicit live change\n");
  assert.equal(
    (await inspectNodeSync(adapter, output.nodeId)).materials[0]!.state,
    "changed",
    "original live path wins over matching main bytes",
  );
  await fs.writeFile(filename, "completed\n");
  await git(main, "merge", "--quiet", "topic");
  assert.equal(path.dirname(worktree), base);
  await git(main, "worktree", "remove", "--force", worktree);
  const fresh = new NodeFs(path.join(main, ".tent"));
  const after = await inspectNodeSync(fresh, output.nodeId);
  assert.equal(after.state, "synced");
  assert.equal(after.materials[0]!.state, "current");
  const check = await runWorkspaceCommand("check", [], { workspace: main, json: true });
  assert.equal(check.exitCode, 0, check.stderr || check.stdout);
  assert.deepEqual(JSON.parse(check.stdout).issues, []);
  const current = await readNodeForEdit(fresh, output.nodeId);
  await writeNodeDocument(fresh, output.nodeId, { baseEtag: current.etag, body: "More context" });
  assert.equal(
    (await fresh.history.nodeRecords())[output.nodeId]!.materials[0]!.repository!.path,
    basis.repository!.path,
  );
  assert.equal(
    (await readNodeForEdit(fresh, output.nodeId)).frontmatter.resource,
    resource,
    "relocation never rewrites the address",
  );
  const surviving = path.join(main, "assets/result.txt");
  await fs.writeFile(surviving, "changed after merge\n");
  assert.equal((await inspectNodeSync(fresh, output.nodeId)).materials[0]!.state, "changed");
  await fs.unlink(surviving);
  assert.equal((await inspectNodeSync(fresh, output.nodeId)).materials[0]!.state, "unavailable");
  const missing = await runWorkspaceCommand("check", [], { workspace: main, json: true });
  assert.ok(
    JSON.parse(missing.stdout).issues.some(
      (issue: { kind: string }) => issue.kind === "missing-material-file",
    ),
  );
});

test("material observer does not relocate unsafe or inaccessible original paths, and selected sections survive relocation", async (t) => {
  const { main, worktree, base } = await fixture(t);
  const filename = path.join(worktree, "assets/report.md");
  const raw = "# Result\nselected\n\n# Other\nignored\n";
  await fs.writeFile(filename, raw);
  await git(worktree, "add", "assets/report.md");
  await git(worktree, "commit", "--quiet", "-m", "test: selected section");
  await initializeTentWorkspace(main);
  const adapter = new NodeFs(path.join(main, ".tent"));
  const resource = pathToFileURL(filename).href + "#Result";
  const observed = await adapter.observeMaterial(resource, "Output/Output.md");
  assert.ok(observed.repository);
  const cached = await adapter.observeMaterial(resource, "Output/Output.md");
  assert.equal(cached.cacheHit, true);
  assert.deepEqual(cached.blobs, observed.blobs);
  await git(main, "merge", "--quiet", "topic");
  const unsafe = path.join(base, "unsafe");
  await fs.mkdir(unsafe);
  await fs.writeFile(path.join(unsafe, "report.md"), raw);
  await fs.rm(path.join(worktree, "assets"), { recursive: true });
  await fs.symlink(unsafe, path.join(worktree, "assets"), "junction");
  await assert.rejects(
    adapter.observeMaterial(resource, "Output/Output.md", observed.repository),
    /Symbolic links/,
  );
  // An unreadable regular file is distinct from a missing checkout.
  await fs.unlink(path.join(worktree, "assets"));
  await fs.mkdir(path.join(worktree, "assets"));
  await fs.writeFile(filename, raw);
  const blocked = t.mock.method(fs, "open", async () => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      adapter.observeMaterial(resource, "Output/Output.md", observed.repository),
      /access denied/,
    );
  } finally {
    blocked.mock.restore();
    syncBuiltinESMExports();
  }
  await git(main, "worktree", "remove", "--force", worktree);
  const relocated = await adapter.observeMaterial(
    resource,
    "Output/Output.md",
    observed.repository,
  );
  assert.equal(relocated.observedVersion, observed.observedVersion);
  await fs.writeFile(
    path.join(main, "assets/report.md"),
    raw.replace("ignored", "unrelated section changed"),
  );
  assert.equal(
    (await adapter.observeMaterial(resource, "Output/Output.md", observed.repository))
      .observedVersion,
    observed.observedVersion,
  );
});

test("retained observations reuse Git discovery and refresh cached ownership when a nested repository appears", async (t) => {
  const { main } = await fixture(t);
  await initializeTentWorkspace(main);
  const adapter = new NodeFs(path.join(main, ".tent"));
  const filename = path.join(main, "assets/result.txt");
  const resource = pathToFileURL(filename).href;
  const calls: string[][] = [];
  const original = childProcess.execFile;
  const mocked = t.mock.method(childProcess, "execFile", (...args: Parameters<typeof original>) => {
    calls.push(args[1] as string[]);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const first = await adapter.observeMaterial(resource, "Output/Output.md");
    assert.ok(first.repository);
    assert.ok(calls.length > 0);
    calls.length = 0;
    const again = await adapter.observeMaterial(resource, "Output/Output.md", first.repository);
    await adapter.observeMaterial(resource, "Output/Output.md", first.repository);
    assert.equal(again.cacheHit, true);
    assert.equal(calls.length, 0, "retained materials reuse validated checkout/index metadata");
    await fs.writeFile(filename, "live edit\n");
    const edited = await adapter.observeMaterial(resource, "Output/Output.md", first.repository);
    assert.notEqual(edited.observedVersion, first.observedVersion);
    assert.notEqual(edited.repository!.blob, first.repository.blob);
    assert.equal(calls.length, 0);
    const nested = path.join(main, "assets");
    await git(nested, "init", "--quiet");
    await git(nested, "add", "result.txt");
    const replaced = await adapter.observeMaterial(resource, "Output/Output.md", first.repository);
    assert.notEqual(replaced.repository!.commonDir, first.repository.commonDir);
    assert.ok(calls.length > 0, "a changed Git boundary invalidates old checkout ownership");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
