import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { NodeFs } from "../src/fs/node-fs.js";
import { durableReplace, syncDirectory } from "../src/fs/durable-file.js";
import { GitDocumentHistory } from "../src/core/store/git-history.js";

async function fixture(t: TestContext) {
  await fs.mkdir(path.resolve(".scratch"), { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".scratch/durable-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return { root, adapter: new NodeFs(root) };
}

function restoreBuiltins(t: TestContext) {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("writes into new nested directories complete, including Windows namespaced mkdir results", async (t) => {
  const { root, adapter } = await fixture(t);
  await adapter.writeFile("new/nested/document.md", "new directory bytes");
  assert.equal(
    await fs.readFile(path.join(root, "new/nested/document.md"), "utf8"),
    "new directory bytes",
  );
});

test("text and binary replacements sync prepared bytes before publication", async (t) => {
  const { root, adapter } = await fixture(t);
  const events: string[] = [];
  const open = fs.open,
    rename = fs.rename;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes(".tmp-")) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        events.push("sync");
        await sync();
      });
    }
    return handle;
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    events.push("rename");
    await rename(...args);
  });
  restoreBuiltins(t);
  await adapter.writeFile("text.md", "原文\n");
  await adapter.writeBinary("data.bin", Uint8Array.from([0, 255, 1, 128]));
  assert.deepEqual(events, ["sync", "rename", "sync", "rename"]);
  assert.equal(await fs.readFile(path.join(root, "text.md"), "utf8"), "原文\n");
  assert.deepEqual(await fs.readFile(path.join(root, "data.bin")), Buffer.from([0, 255, 1, 128]));
});

test("failed file sync rejects the save, keeps the original and removes the prepared file", async (t) => {
  const { root, adapter } = await fixture(t);
  await fs.writeFile(path.join(root, "keep.md"), "last complete bytes");
  const failure = Object.assign(new Error("injected flush failure"), { code: "EIO" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes(".tmp-"))
      t.mock.method(handle, "sync", async () => {
        throw failure;
      });
    return handle;
  });
  restoreBuiltins(t);
  await assert.rejects(adapter.writeFile("keep.md", "new bytes"), (error) => error === failure);
  assert.equal(await fs.readFile(path.join(root, "keep.md"), "utf8"), "last complete bytes");
  assert.deepEqual(await fs.readdir(root), ["keep.md"]);
});

test("publication failure keeps the original and cleans up the synced temporary", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "keep.md");
  await fs.writeFile(file, "original");
  const failure = Object.assign(new Error("rename failed"), { code: "EIO" });
  t.mock.method(fs, "rename", async () => {
    throw failure;
  });
  restoreBuiltins(t);
  await assert.rejects(durableReplace(file, "replacement"), (error) => error === failure);
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.deepEqual(await fs.readdir(root), ["keep.md"]);
});

test(
  "POSIX directory sync errors are not hidden",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root } = await fixture(t);
    const failure = Object.assign(new Error("directory sync failed"), { code: "EIO" });
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      t.mock.method(handle, "sync", async () => {
        throw failure;
      });
      return handle;
    });
    restoreBuiltins(t);
    await assert.rejects(syncDirectory(root), (error) => error === failure);
  },
);

test("every private Git process overrides durability settings without changing repository config", async (t) => {
  const { root } = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet");
  git("config", "core.fsync", "none");
  git("config", "core.fsyncMethod", "batch");
  const config = await fs.readFile(path.join(root, ".git/config"));
  const calls: string[][] = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    calls.push(args[1] as string[]);
    return spawn(...args);
  });
  restoreBuiltins(t);
  const history = new GitDocumentHistory(root);
  const first = await history.captureUnlocked([{ path: "A/A.md", raw: "first" }]);
  const second = await history.captureUnlocked([{ path: "A/A.md", raw: "second" }]);
  assert.equal(await history.read(first.versions[0]!), "first");
  assert.equal(await history.currentCommit(), second.commit);
  assert.ok(calls.some((args) => args.includes("update-ref")));
  for (const args of calls) {
    assert.ok(args.includes("core.fsync=all"));
    assert.ok(args.includes("core.fsyncMethod=fsync"));
    assert.ok(args.includes("core.logAllRefUpdates=false"));
  }
  assert.deepEqual(await fs.readFile(path.join(root, ".git/config")), config);
  git("fsck", "--full", "--no-dangling");
});

test("index mirror storage failure is reported even after the commit was published", async (t) => {
  const { root } = await fixture(t);
  execFileSync("git", ["-C", root, "init", "--quiet"], { windowsHide: true });
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const options = args[2] as { env?: NodeJS.ProcessEnv };
    if ((args[1] as string[]).includes("read-tree") && !options.env?.GIT_INDEX_FILE)
      return spawn("git", ["tent-injected-storage-failure"], options);
    return spawn(...args);
  });
  restoreBuiltins(t);
  const history = new GitDocumentHistory(root);
  await assert.rejects(
    history.captureUnlocked([{ path: "A/A.md", raw: "retained" }]),
    /Git read-tree failed/,
  );
  assert.ok(await history.currentCommit(), "failed response does not hide that HEAD may be live");
});

test("an external index lock defers only the index mirror; the next capture repairs it", async (t) => {
  const { root } = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet");
  const history = new GitDocumentHistory(root);
  const lock = path.join(root, ".git/index.lock");
  await fs.writeFile(lock, "other process");
  const saved = await history.captureUnlocked([{ path: "A/A.md", raw: "retained" }]);
  assert.equal(await history.currentCommit(), saved.commit);
  assert.equal(await fs.readFile(lock, "utf8"), "other process");
  await fs.unlink(lock);
  assert.equal(
    (await history.captureUnlocked([{ path: "A/A.md", raw: "retained" }])).created,
    false,
  );
  assert.equal(git("diff", "--cached", "--name-only"), "");
});

test("publication flushes HEAD and its branch without creating reflogs", async (t) => {
  const { root } = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet");
  const branch = git("symbolic-ref", "HEAD");
  const flushed = new Set<string>();
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[1] === "r+") {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        await sync();
        flushed.add(path.relative(root, String(args[0])).replaceAll("\\", "/"));
      });
    }
    return handle;
  });
  restoreBuiltins(t);
  await new GitDocumentHistory(root).captureUnlocked([{ path: "A/A.md", raw: "stored" }]);
  assert.deepEqual(flushed, new Set([".git/HEAD", `.git/${branch}`]));
  await assert.rejects(fs.stat(path.join(root, ".git/logs")), { code: "ENOENT" });
});

test("a failed HEAD flush reports a published but incomplete save; unchanged retry flushes it", async (t) => {
  const { root } = await fixture(t);
  execFileSync("git", ["-C", root, "init", "--quiet"], { windowsHide: true });
  const failure = Object.assign(new Error("injected HEAD sync failure"), { code: "EIO" });
  let fail = true,
    flushed = false;
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]).replaceAll("\\", "/").endsWith("/.git/HEAD")) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        if (fail) throw failure;
        await sync();
        flushed = true;
      });
    }
    return handle;
  });
  restoreBuiltins(t);
  const history = new GitDocumentHistory(root);
  await assert.rejects(
    history.captureUnlocked([{ path: "A/A.md", raw: "stored" }]),
    (error) => error === failure,
  );
  const published = await history.currentCommit();
  assert.ok(published);
  fail = false;
  const retry = await history.captureUnlocked([{ path: "A/A.md", raw: "stored" }]);
  assert.equal(retry.created, false);
  assert.equal(retry.commit, published);
  assert.equal(flushed, true);
});

test("a failed legacy reflog flush aborts migration and capture without deleting the old bytes", async (t) => {
  const { root } = await fixture(t);
  execFileSync("git", ["-C", root, "init", "--quiet"], { windowsHide: true });
  const history = new GitDocumentHistory(root);
  const first = await history.captureUnlocked([{ path: "A/A.md", raw: "old" }]);
  const log = path.join(root, ".git/logs/HEAD");
  await fs.mkdir(path.dirname(log), { recursive: true });
  const bytes = `${"0".repeat(first.commit!.length)} ${first.commit} Tent <tent@local.invalid> 1792870000 +0800\n`;
  await fs.writeFile(log, bytes);
  const failure = Object.assign(new Error("legacy log flush failed"), { code: "EIO" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === log)
      t.mock.method(handle, "sync", async () => {
        throw failure;
      });
    return handle;
  });
  restoreBuiltins(t);
  await assert.rejects(
    history.captureUnlocked([{ path: "A/A.md", raw: "new" }]),
    (error) => error === failure,
  );
  assert.equal(await history.currentCommit(), first.commit);
  assert.equal(await fs.readFile(log, "utf8"), bytes);
  await assert.rejects(fs.stat(path.join(root, ".git/tent-reflogs")), { code: "ENOENT" });
});
