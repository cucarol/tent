import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test from "node:test";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { initializeFixtureWorkspace, initializeFixtureRepository } from "./scratch.js";
import { loadTent } from "../src/core/store/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

async function directoryContents(root: string, prefix = ""): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name),
      relative = prefix + entry.name;
    if (entry.isDirectory()) {
      contents[relative + "/"] = "";
      Object.assign(contents, await directoryContents(file, relative + "/"));
    } else contents[relative] = (await fs.readFile(file)).toString("hex");
  }
  return contents;
}

test("initialization preserves all outer Git bytes even when Git metadata writes are denied", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "init-git-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", windowsHide: true });
  git("init", "--quiet");
  const userIgnore = Buffer.from("# User ignore\r\n*.tmp\r\n");
  const userExclude = Buffer.from("# Local rules\r\ncache/\r\n");
  await fs.writeFile(path.join(workspace, ".gitignore"), userIgnore);
  await fs.writeFile(path.join(workspace, ".git/info/exclude"), userExclude);
  const outerConfig = await fs.readFile(path.join(workspace, ".git/config"), "utf8");
  const gitRoot = path.join(workspace, ".git");
  const before = await directoryContents(gitRoot);
  const denied = (file: unknown) =>
    typeof file === "string" && (file === gitRoot || file.startsWith(gitRoot + path.sep));
  const originalMkdir = fsPromises.mkdir,
    originalWrite = fsPromises.writeFile;
  const mkdirMock = t.mock.method(
    fsPromises,
    "mkdir",
    async (...args: Parameters<typeof originalMkdir>) => {
      if (denied(args[0]))
        throw Object.assign(new Error("Git metadata is protected"), { code: "EPERM" });
      return originalMkdir(...args);
    },
  );
  const writeMock = t.mock.method(
    fsPromises,
    "writeFile",
    async (...args: Parameters<typeof originalWrite>) => {
      if (denied(args[0]))
        throw Object.assign(new Error("Git metadata is protected"), { code: "EPERM" });
      return originalWrite(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await initializeTentWorkspace(workspace);
  } finally {
    mkdirMock.mock.restore();
    writeMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await directoryContents(gitRoot), before);
  const systemRoot = path.join(workspace, ".tent");
  const history = openTestFs(systemRoot);
  try {
    assert.equal(await history.history.currentCommit(), null);
  } finally {
    await history.close();
  }
  assert.equal(
    await fs.access(path.join(systemRoot, ".git/HEAD")).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    await fs.access(path.join(systemRoot, ".git/objects")).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal((await loadTent(openTestFs(systemRoot))).byId.size, 0);
  assert.equal(await fs.readFile(path.join(workspace, ".git/config"), "utf8"), outerConfig);
  assert.equal(await fs.readFile(path.join(systemRoot, ".gitignore"), "utf8"), "*\n");
  assert.equal(git("check-ignore", ".tent/settings.json").trim(), ".tent/settings.json");
  assert.equal(git("ls-files", "--others", "--exclude-standard", "--", ".tent"), "");
  assert.deepEqual(await fs.readFile(path.join(workspace, ".gitignore")), userIgnore);
  assert.deepEqual(await fs.readFile(path.join(workspace, ".git/info/exclude")), userExclude);
  assert.equal(await openTestFs(systemRoot).exists("attachments"), false);
  const settings = await fs.readFile(path.join(systemRoot, "settings.json"), "utf8");
  await assert.rejects(initializeTentWorkspace(workspace), /already has a Tent/);
  assert.equal(await fs.readFile(path.join(systemRoot, "settings.json"), "utf8"), settings);
});

test("SQLite setup creates no private Git repository and ignores unrelated global branch defaults", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "init-without-private-git-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  initializeFixtureRepository(workspace);
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = path.join(workspace, "home");
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, ".gitconfig"), "[init]\n defaultBranch = bad..branch\n");
  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    await initializeTentWorkspace(workspace);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  const adapter = openTestFs(path.join(workspace, ".tent"));
  try {
    assert.equal(await adapter.history.currentCommit(), null);
  } finally {
    await adapter.close();
  }
  assert.equal(
    await fs.access(path.join(workspace, ".tent/.git/HEAD")).then(
      () => true,
      () => false,
    ),
    false,
  );
});
test("scaffold failure remains retryable and initialization preserves existing user data", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "init-scaffold-failure-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  execFileSync("git", ["-C", workspace, "init", "--quiet"], { windowsHide: true });
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
  await assert.rejects(initializeFixtureWorkspace(workspace), /scaffold interrupted/);
  mocked.mock.restore();
  assert.deepEqual((await fs.readdir(workspace)).sort(), [".git", "user.txt"]);
  await initializeFixtureWorkspace(workspace);
  await fs.writeFile(path.join(workspace, ".tent/user.md"), "keep too");
  await assert.rejects(initializeFixtureWorkspace(workspace), /already has a Tent/);
  assert.equal(await fs.readFile(path.join(workspace, "user.txt"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(workspace, ".tent/user.md"), "utf8"), "keep too");
});

test(
  "Windows initialization publishes a complete Tent after two EPERM rename failures",
  { skip: process.platform !== "win32" },
  async (t) => {
    const scratch = path.resolve(testScratchRoot());
    await fs.mkdir(scratch, { recursive: true });
    const workspace = await fs.mkdtemp(path.join(scratch, "init-rename-retry-"));
    t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
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
      await initializeFixtureWorkspace(workspace);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(attempts, 3);
    assert.ok((await fs.stat(path.join(systemRoot, ".git"))).isDirectory());
    assert.equal((await loadTent(openTestFs(systemRoot))).byId.size, 0);
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
      const scratch = path.resolve(testScratchRoot());
      await fs.mkdir(scratch, { recursive: true });
      const workspace = await fs.mkdtemp(path.join(scratch, "init-rename-failure-"));
      t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
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
        await assert.rejects(initializeFixtureWorkspace(workspace), (error) => error === failure);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(attempts, code === "EPERM" ? 10 : 1);
      assert.deepEqual((await fs.readdir(workspace)).sort(), [".git", "user.txt"]);
      assert.equal(await fs.readFile(path.join(workspace, "user.txt"), "utf8"), "keep");
      await assert.rejects(fs.stat(systemRoot), { code: "ENOENT" });
      await initializeFixtureWorkspace(workspace);
      assert.ok((await fs.stat(path.join(systemRoot, ".git"))).isDirectory());
    },
  );
}

test("main and linked worktree initialization leave shared Git metadata untouched", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "init-worktree-"));
  t.after(() =>
    removeTestFixture(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const main = path.join(fixture, "main"),
    worktree = path.join(fixture, "linked");
  await fs.mkdir(main);
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git(main, "init", "--quiet");
  git(
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "Initial",
  );
  git(main, "worktree", "add", "--quiet", "--detach", worktree);
  const excludePath = path.resolve(main, git(main, "rev-parse", "--git-path", "info/exclude"));
  assert.equal(
    path.resolve(worktree, git(worktree, "rev-parse", "--git-path", "info/exclude")),
    excludePath,
  );
  const original = Buffer.from("# User exclude\r\nlocal-cache/");
  await fs.writeFile(excludePath, original);
  const before = await directoryContents(path.join(main, ".git"));
  const worktreeGit = await fs.readFile(path.join(worktree, ".git"));
  await initializeTentWorkspace(worktree);
  assert.deepEqual(await directoryContents(path.join(main, ".git")), before);
  assert.deepEqual(await fs.readFile(path.join(worktree, ".git")), worktreeGit);
  assert.deepEqual(await fs.readFile(excludePath), original);
  assert.equal(git(worktree, "check-ignore", ".tent/settings.json"), ".tent/settings.json");
  await initializeTentWorkspace(main);
  assert.deepEqual(await directoryContents(path.join(main, ".git")), before);
  assert.deepEqual(await fs.readFile(excludePath), original);
  assert.equal(git(main, "check-ignore", ".tent/settings.json"), ".tent/settings.json");
  for (const root of [main, worktree]) {
    assert.equal(await fs.readFile(path.join(root, ".tent/.gitignore"), "utf8"), "*\n");
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard", "--", ".tent"), "");
  }
  await assert.rejects(fs.stat(path.join(main, ".gitignore")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(worktree, ".gitignore")), { code: "ENOENT" });
});

test("initialization always writes its own ignore file and preserves the user's gitignore", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "init-nongit-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const raw = Buffer.from("# User rules\r\n*.tmp\r\n");
  await fs.writeFile(path.join(root, ".gitignore"), raw);
  await initializeTentWorkspace(root);
  assert.deepEqual((await fs.readdir(root)).sort(), [".gitignore", ".tent"]);
  assert.deepEqual(await fs.readFile(path.join(root, ".gitignore")), raw);
  assert.equal(await fs.readFile(path.join(root, ".tent/.gitignore"), "utf8"), "*\n");
});

test("Tent ignore-file failure publishes no Tent and remains retryable", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "init-ignore-failure-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "user.txt"), "keep");
  const original = fsPromises.writeFile;
  const failure = Object.assign(new Error("ignore write denied"), { code: "EIO" });
  const mocked = t.mock.method(
    fsPromises,
    "writeFile",
    async (...args: Parameters<typeof original>) => {
      if (typeof args[0] === "string" && path.basename(args[0]) === ".gitignore") throw failure;
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(initializeTentWorkspace(root), (error) => error === failure);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await fs.readdir(root), ["user.txt"]);
  assert.equal(await fs.readFile(path.join(root, "user.txt"), "utf8"), "keep");
  await initializeTentWorkspace(root);
  assert.equal(await fs.readFile(path.join(root, ".tent/.gitignore"), "utf8"), "*\n");
});
