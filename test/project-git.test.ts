import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { initializeProjectGit } from "../src/fs/project-git.js";
import { testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";

test("project initialization creates a real repository after Git reports no owning repository", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "project-git-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  // All fixtures must remain inside this checkout. Simulate only the ancestor
  // lookup result; the subsequent git init and repository are real.
  const execute = childProcess.execFile;
  let queried = false;
  const mocked = t.mock.method(childProcess, "execFile", (...args: any[]) => {
    const parameters = args[1] as string[];
    if (!queried && parameters.includes("--is-inside-work-tree")) {
      queried = true;
      queueMicrotask(() =>
        args[3](Object.assign(new Error("not a repository"), { code: 128 }), "", ""),
      );
      return {};
    }
    return (execute as any)(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await initializeProjectGit(root), true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await fs.stat(path.join(root, ".git/HEAD"))).isFile(), true);
  assert.equal(await initializeProjectGit(root), false);
});
