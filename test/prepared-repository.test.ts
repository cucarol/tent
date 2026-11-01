import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  prepareRepositoryObservation,
  validateRepositoryObservation,
} from "../src/fs/prepared-repository.js";
import { git } from "./helpers.js";
import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";

function setEnv(t: TestContext, key: string, value: string) {
  const before = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  });
}

async function ageTree(root: string) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) await ageTree(filename);
    else await fs.utimes(filename, new Date(1_000), new Date(1_000));
  }
  await fs.utimes(root, new Date(1_000), new Date(1_000));
}

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(testScratchRoot(), "prepared-repository-"));
  t.after(() =>
    removeTestFixture(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const root = path.join(base, "project"),
    home = path.join(base, "home"),
    xdg = path.join(base, "xdg");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(home);
  await fs.mkdir(path.join(xdg, "git"), { recursive: true });
  setEnv(t, "HOME", home);
  setEnv(t, "XDG_CONFIG_HOME", xdg);
  await git(root, "init", "--quiet");
  await fs.writeFile(path.join(root, "src", "main.ts"), "export const one = 1;\n");
  await git(root, "add", "src/main.ts");
  await ageTree(base);
  const load = async () => ({
    source: await fs.readFile(path.join(root, "src", "main.ts"), "utf8"),
  });
  return { root, home, xdg, load };
}

test("serialized repository observations reuse unchanged bytes without Git or content reads", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareRepositoryObservation(f.root, f.load);
  assert.ok(prepared);
  const serialized = JSON.parse(JSON.stringify(prepared));
  const processMock = t.mock.method(childProcess, "execFile", (() => {
    throw new Error("Git must not start");
  }) as unknown as typeof childProcess.execFile);
  const readMock = t.mock.method(fs, "readFile", (() => {
    throw new Error("Bytes must not be read");
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  t.after(() => {
    processMock.mock.restore();
    readMock.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual(await validateRepositoryObservation(f.root, serialized), prepared.value);
  assert.equal(processMock.mock.callCount(), 0);
  assert.equal(readMock.mock.callCount(), 0);
});

test("same-size restored-mtime edits invalidate through ctime", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareRepositoryObservation(f.root, f.load);
  assert.ok(prepared);
  const filename = path.join(f.root, "src", "main.ts"),
    before = await fs.stat(filename);
  await fs.writeFile(filename, "export const two = 2;\n");
  await fs.utimes(filename, before.atime, before.mtime);
  assert.equal(await validateRepositoryObservation(f.root, prepared), undefined);
});

for (const change of [
  "add",
  "remove",
  "empty-directory",
  "nested-tent",
  "ignore",
  "index",
  "exclude",
] as const)
  test(`repository witnesses invalidate after ${change}`, async (t) => {
    const f = await fixture(t);
    const prepared = await prepareRepositoryObservation(f.root, f.load);
    assert.ok(prepared);
    if (change === "add") await fs.writeFile(path.join(f.root, "src", "new.ts"), "new");
    if (change === "remove") await fs.rm(path.join(f.root, "src", "main.ts"));
    if (change === "empty-directory") await fs.mkdir(path.join(f.root, "empty"));
    if (change === "nested-tent") await fs.mkdir(path.join(f.root, "src", ".tent"));
    if (change === "ignore") await fs.writeFile(path.join(f.root, "src", ".gitignore"), "*.ts\n");
    if (change === "index") await git(f.root, "rm", "--cached", "src/main.ts");
    if (change === "exclude")
      await fs.appendFile(path.join(f.root, ".git", "info", "exclude"), "*.ts\n");
    assert.equal(await validateRepositoryObservation(f.root, prepared), undefined);
  });

for (const change of ["global-config", "xdg-config", "default-ignore", "home", "xdg"] as const)
  test(`missing global paths and environment invalidate after ${change}`, async (t) => {
    const f = await fixture(t);
    const prepared = await prepareRepositoryObservation(f.root, f.load);
    assert.ok(prepared);
    if (change === "global-config")
      await fs.writeFile(path.join(f.home, ".gitconfig"), "[core]\n excludesFile = ignore\n");
    if (change === "xdg-config")
      await fs.writeFile(path.join(f.xdg, "git", "config"), "[core]\n excludesFile = ignore\n");
    if (change === "default-ignore")
      await fs.writeFile(path.join(f.xdg, "git", "ignore"), "*.ts\n");
    if (change === "home") process.env.HOME = f.root;
    if (change === "xdg") process.env.XDG_CONFIG_HOME = f.root;
    assert.equal(await validateRepositoryObservation(f.root, prepared), undefined);
  });

test("explicit global excludes and repository config are witnessed", async (t) => {
  const f = await fixture(t),
    ignore = path.join(f.home, "ignore");
  await fs.writeFile(ignore, "*.log\n");
  await git(f.root, "config", "core.excludesFile", ignore);
  await ageTree(path.dirname(f.root));
  const prepared = await prepareRepositoryObservation(f.root, f.load);
  assert.ok(prepared);
  assert.deepEqual(await validateRepositoryObservation(f.root, prepared), prepared.value);
  await fs.appendFile(ignore, "*.ts\n");
  assert.equal(await validateRepositoryObservation(f.root, prepared), undefined);
});

test("unrelated home writes do not invalidate external configuration file witnesses", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, ".gitconfig"), "[user]\n name = Fixture\n");
  await ageTree(path.dirname(f.root));
  const prepared = await prepareRepositoryObservation(f.root, f.load);
  assert.ok(prepared);
  assert.ok(!prepared.entries.some((entry) => entry.filename === f.home));
  await fs.writeFile(path.join(f.home, "unrelated-session-state"), "changed");
  assert.deepEqual(await validateRepositoryObservation(f.root, prepared), prepared.value);
  await fs.appendFile(path.join(f.home, ".gitconfig"), " email = fixture@example.test\n");
  assert.equal(await validateRepositoryObservation(f.root, prepared), undefined);
});

test("recently written files never become a metadata cache hit", async (t) => {
  const f = await fixture(t);
  await fs.utimes(path.join(f.root, "src", "main.ts"), new Date(), new Date());
  const prepared = await prepareRepositoryObservation(f.root, f.load);
  assert.ok(prepared);
  assert.equal(await validateRepositoryObservation(f.root, prepared), undefined);
});

test("a loader edit is rejected by the closing observation", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await prepareRepositoryObservation(f.root, async () => {
      const value = await f.load();
      await fs.writeFile(path.join(f.root, "src", "main.ts"), "changed");
      return value;
    }),
    undefined,
  );
});

test("a transient missing global ignore changes its witnessed parent even with restored mtime", async (t) => {
  const f = await fixture(t),
    directory = path.join(f.xdg, "git");
  const before = await fs.stat(directory);
  assert.equal(
    await prepareRepositoryObservation(f.root, async () => {
      const filename = path.join(directory, "ignore");
      await fs.writeFile(filename, "*.ts\n");
      const value = await f.load();
      await fs.rm(filename);
      await fs.utimes(directory, before.atime, before.mtime);
      return value;
    }),
    undefined,
  );
});

test("configuration states precede Git config interpretation", async (t) => {
  const f = await fixture(t),
    filename = path.join(f.root, ".git", "config");
  const before = await fs.stat(filename),
    original = childProcess.execFile;
  let changed = false;
  const mocked = t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
    const callback = args[args.length - 1] as (...result: unknown[]) => void;
    const command = args[1] as string[];
    if (command.includes("--show-origin")) {
      args[args.length - 1] = async (...result: unknown[]) => {
        await fs.appendFile(filename, "\n[core]\n excludesFile = newly-added-ignore\n");
        await fs.utimes(filename, before.atime, before.mtime);
        changed = true;
        callback(...result);
      };
    }
    return Reflect.apply(original, childProcess, args);
  }) as unknown as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  assert.equal(await prepareRepositoryObservation(f.root, f.load), undefined);
  assert.equal(changed, true);
});

test("physical directory links and indexed Gitlinks use the native fallback", async (t) => {
  const f = await fixture(t);
  await fs.symlink(
    path.join(f.root, "src"),
    path.join(f.root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(await prepareRepositoryObservation(f.root, f.load), undefined);
  await fs.rm(path.join(f.root, "linked"));
  await git(f.root, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},submodule`);
  assert.equal(await prepareRepositoryObservation(f.root, f.load), undefined);
});

for (const unsupported of [
  "include",
  "conditional-include",
  "worktree-config",
  "nested-repository",
  "large-tree",
] as const)
  test(`unsupported ${unsupported} falls back before calling the loader`, async (t) => {
    const f = await fixture(t);
    if (unsupported === "include")
      await git(f.root, "config", "include.path", path.join(f.home, "missing"));
    if (unsupported === "conditional-include")
      await git(f.root, "config", "includeIf.gitdir:/missing/.path", path.join(f.home, "missing"));
    if (unsupported === "worktree-config") await git(f.root, "config", "core.worktree", f.root);
    if (unsupported === "nested-repository") {
      await fs.mkdir(path.join(f.root, "nested"));
      await git(path.join(f.root, "nested"), "init", "--quiet");
    }
    if (unsupported === "large-tree")
      await Promise.all(
        Array.from({ length: 4100 }, (_, i) => fs.writeFile(path.join(f.root, `file-${i}`), "")),
      );
    let calls = 0;
    assert.equal(
      await prepareRepositoryObservation(f.root, async () => {
        calls++;
        return f.load();
      }),
      undefined,
    );
    assert.equal(calls, 0);
  });

test("an unrelated root .tent mutation does not invalidate repository data", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, ".tent"));
  await ageTree(f.root);
  const prepared = await prepareRepositoryObservation(f.root, f.load);
  assert.ok(prepared);
  await fs.writeFile(path.join(f.root, ".tent", "local-state"), "changed");
  setEnv(t, "TENT_TEST_SESSION", "a-different-process");
  assert.deepEqual(await validateRepositoryObservation(f.root, prepared), prepared.value);
});
