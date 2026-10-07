import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { findTentSystemRoot } from "../src/core/status.js";
import { workspaceRootFromSystemRoot } from "../src/core/paths.js";
import { resolveWorkspacePaths } from "../src/cli/workspace-path.js";
import { tentIndexMarker } from "../src/core/scaffold.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { git } from "./helpers.js";

test("a .tent at a filesystem root derives that root, keeping its separator", () => {
  assert.equal(workspaceRootFromSystemRoot("/.tent"), "/");
  assert.equal(workspaceRootFromSystemRoot("/.tent/"), "/");
  assert.equal(workspaceRootFromSystemRoot("C:\\.tent"), "C:\\");
  assert.equal(workspaceRootFromSystemRoot("C:/.tent"), "C:/");
  assert.equal(workspaceRootFromSystemRoot("C:\\work\\.tent"), "C:\\work");
  assert.equal(workspaceRootFromSystemRoot("/work/.tent"), "/work");
  assert.equal(workspaceRootFromSystemRoot("/work/notes"), undefined);
  const hostRoot = workspaceRootFromSystemRoot(path.join(path.parse(process.cwd()).root, ".tent"));
  assert.equal(hostRoot, path.parse(process.cwd()).root);
  assert.ok(path.isAbsolute(hostRoot!));
});

test("workspace discovery skips ordinary index.md files and respects explicit boundaries", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "tent-workspace-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemRoot = path.join(root, ".tent");
  const child = path.join(root, "docs");
  await fs.mkdir(systemRoot);
  await fs.mkdir(child);
  await fs.writeFile(path.join(systemRoot, "index.md"), tentIndexMarker());
  await fs.writeFile(path.join(root, "index.md"), "# Project home\n");
  await fs.writeFile(path.join(child, "index.md"), "---\ntype: concept\n---\n# Documentation\n");
  const expected = { workspaceRoot: root, systemRoot };
  assert.deepEqual(await resolveWorkspacePaths({ workspace: root }), expected);
  assert.deepEqual(await resolveWorkspacePaths({ cwd: child }), expected);
  assert.deepEqual(await resolveWorkspacePaths({ cwd: systemRoot }), expected);
  await assert.rejects(resolveWorkspacePaths({ workspace: child }), /parent roots are not used/);
  await fs.writeFile(path.join(systemRoot, "index.md"), "# Index without optional version\n");
  assert.deepEqual(await resolveWorkspacePaths({ cwd: child }), expected);
  // 独立 Core 目录仍通过明确的结构标记发现，普通 Markdown 不是标记。
  const legacy = path.join(root, "legacy");
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, "index.md"), "# Ordinary index\n");
  assert.equal(await findTentSystemRoot(legacy, legacy), undefined);
  await fs.writeFile(path.join(legacy, "index.md"), tentIndexMarker());
  assert.equal(await findTentSystemRoot(legacy), legacy);
});

test("workspace discovery stops at Git checkout and linked-worktree roots", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "tent-git-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outer = path.join(root, ".tent");
  await fs.mkdir(outer);
  await fs.writeFile(path.join(outer, "index.md"), tentIndexMarker());
  for (const kind of ["checkout", "worktree"]) {
    const nested = path.join(root, ".scratch", kind);
    const child = path.join(nested, "src", "deep");
    await fs.mkdir(child, { recursive: true });
    if (kind === "checkout") await fs.mkdir(path.join(nested, ".git"));
    else
      await fs.writeFile(
        path.join(nested, ".git"),
        "gitdir: ../repository/.git/worktrees/example\n",
      );
    assert.equal(await findTentSystemRoot(child), undefined);
    await assert.rejects(resolveWorkspacePaths({ cwd: child }), /Not inside a Tent/);
    const own = path.join(nested, ".tent");
    await fs.mkdir(own);
    await fs.writeFile(path.join(own, "index.md"), tentIndexMarker());
    assert.equal(await findTentSystemRoot(child), own);
  }
});

test("CLI mutation in a nested Git clone cannot reach the outer Tent", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "tent-clone-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(systemRoot);
  const marker = tentIndexMarker();
  await fs.writeFile(path.join(systemRoot, "index.md"), marker);
  await git(root, "init", "--quiet");
  await fs.writeFile(path.join(root, "README.md"), "Nested clone fixture\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "--quiet", "-m", "test: clone source");
  const nested = path.join(root, ".scratch", "clone");
  await git(root, "clone", "--quiet", "--no-hardlinks", root, nested);
  const child = path.join(nested, "src");
  await fs.mkdir(child);
  const result = await runNodeCommand("create", ["Accidental", "--type", "goal"], {
    cwd: child,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Not inside a Tent/);
  assert.deepEqual(await fs.readdir(systemRoot), ["index.md"]);
  assert.equal(await fs.readFile(path.join(systemRoot, "index.md"), "utf8"), marker);
});
