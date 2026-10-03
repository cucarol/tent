import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test from "node:test";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { loadTent } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("initialization creates independent Git without Nodes, commits or changes to outer history", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "init-git-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "--quiet");
  const outerConfig = await fs.readFile(path.join(workspace, ".git/config"), "utf8");
  await initializeTentWorkspace(workspace);
  const systemRoot = path.join(workspace, ".tent");
  assert.equal(
    await fs.realpath(git("-C", ".tent", "rev-parse", "--show-toplevel").trim()),
    await fs.realpath(systemRoot),
  );
  assert.equal(git("-C", ".tent", "rev-list", "--all"), "");
  assert.equal(git("-C", ".tent", "remote"), "");
  assert.equal((await loadTent(new NodeFs(systemRoot))).byId.size, 0);
  assert.equal(await fs.readFile(path.join(workspace, ".git/config"), "utf8"), outerConfig);
  assert.equal(git("check-ignore", ".tent/").trim(), ".tent/");
  const settings = await fs.readFile(path.join(systemRoot, "settings.json"), "utf8");
  await assert.rejects(initializeTentWorkspace(workspace), /already has a Tent/);
  assert.equal(await fs.readFile(path.join(systemRoot, "settings.json"), "utf8"), settings);
});

test("a real Git init failure leaves no ready Tent and can be retried", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "init-failure-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, "home"),
    workspace = path.join(fixture, "workspace");
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, ".gitconfig"), "[init]\n defaultBranch = bad..branch\n");
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    await assert.rejects(initializeTentWorkspace(workspace), /invalid branch name/);
    await assert.rejects(fs.stat(path.join(workspace, ".tent")), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(workspace), []);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  await initializeTentWorkspace(workspace);
  assert.ok((await fs.stat(path.join(workspace, ".tent/.git"))).isDirectory());
});

test("scaffold failure remains retryable and initialization preserves existing user data", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "init-scaffold-failure-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "user.txt"), "keep");
  const original = NodeFs.prototype.writeFile;
  const mocked = t.mock.method(
    NodeFs.prototype,
    "writeFile",
    async function (this: NodeFs, file: string, raw: string) {
      if (file === "settings.json") throw new Error("scaffold interrupted");
      return original.call(this, file, raw);
    },
  );
  await assert.rejects(initializeTentWorkspace(workspace), /scaffold interrupted/);
  mocked.mock.restore();
  assert.deepEqual(await fs.readdir(workspace), ["user.txt"]);
  await initializeTentWorkspace(workspace);
  await fs.writeFile(path.join(workspace, ".tent/user.md"), "keep too");
  await assert.rejects(initializeTentWorkspace(workspace), /already has a Tent/);
  assert.equal(await fs.readFile(path.join(workspace, "user.txt"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(workspace, ".tent/user.md"), "utf8"), "keep too");
});

test(
  "Windows initialization publishes a complete Tent after two EPERM rename failures",
  { skip: process.platform !== "win32" },
  async (t) => {
    const scratch = path.resolve(".scratch");
    await fs.mkdir(scratch, { recursive: true });
    const workspace = await fs.mkdtemp(path.join(scratch, "init-rename-retry-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const systemRoot = path.join(workspace, ".tent"),
      originalRename = fsPromises.rename;
    let attempts = 0;
    const mocked = t.mock.method(
      fsPromises,
      "rename",
      async (...args: Parameters<typeof originalRename>) => {
        const [from, to] = args;
        if (to === systemRoot && ++attempts <= 2)
          throw Object.assign(new Error("staging directory briefly occupied"), { code: "EPERM" });
        return originalRename(from, to);
      },
    );
    syncBuiltinESMExports();
    try {
      await initializeTentWorkspace(workspace);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(attempts, 3);
    assert.ok((await fs.stat(path.join(systemRoot, ".git"))).isDirectory());
    assert.equal((await loadTent(new NodeFs(systemRoot))).byId.size, 0);
    assert.equal(
      (await fs.readdir(workspace)).some((entry) => entry.startsWith(".tent-init-")),
      false,
    );
  },
);

for (const code of ["EIO", "EPERM"]) {
  test(
    `initialization preserves a terminal ${code} publication error, cleans staging and can be retried`,
    { skip: code === "EPERM" && process.platform !== "win32" },
    async (t) => {
      const scratch = path.resolve(".scratch");
      await fs.mkdir(scratch, { recursive: true });
      const workspace = await fs.mkdtemp(path.join(scratch, "init-rename-failure-"));
      t.after(() => fs.rm(workspace, { recursive: true, force: true }));
      await fs.writeFile(path.join(workspace, "user.txt"), "keep");
      const systemRoot = path.join(workspace, ".tent"),
        originalRename = fsPromises.rename,
        failure = Object.assign(new Error("publication denied"), { code });
      let attempts = 0;
      const mocked = t.mock.method(
        fsPromises,
        "rename",
        async (...args: Parameters<typeof originalRename>) => {
          const [from, to] = args;
          if (to === systemRoot) {
            attempts++;
            throw failure;
          }
          return originalRename(from, to);
        },
      );
      syncBuiltinESMExports();
      try {
        await assert.rejects(initializeTentWorkspace(workspace), (error) => error === failure);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(attempts, code === "EPERM" ? 10 : 1);
      assert.deepEqual((await fs.readdir(workspace)).sort(), [".gitignore", "user.txt"]);
      assert.equal(await fs.readFile(path.join(workspace, "user.txt"), "utf8"), "keep");
      await assert.rejects(fs.stat(systemRoot), { code: "ENOENT" });
      await initializeTentWorkspace(workspace);
      assert.ok((await fs.stat(path.join(systemRoot, ".git"))).isDirectory());
    },
  );
}
