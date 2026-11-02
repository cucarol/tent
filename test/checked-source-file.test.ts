import { removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { checkedSourceFile, initialSourceFile } from "../src/fs/checked-source-file.js";
import { readSourceFile } from "../src/fs/source-observation.js";
import { testScratchRoot } from "./scratch.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";

test("overlapping path checks share pending ancestry reads but later checks see replacement links", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "checked-source-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const directory = path.join(root, "src");
  const other = path.join(root, "other");
  await fs.mkdir(directory);
  await fs.mkdir(other);
  for (const name of ["a.ts", "b.ts"]) {
    await fs.writeFile(path.join(directory, name), "original");
    await fs.writeFile(path.join(other, name), "replacement");
  }
  const original = fs.realpath;
  let roots = 0;
  const mocked = t.mock.method(fs, "realpath", async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === root) {
      roots++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const check = () =>
      withFileReadScope(() =>
        Promise.all(
          ["a.ts", "b.ts"].map((name) => checkedSourceFile(root, path.join(directory, name))),
        ),
      );
    assert.ok((await check()).every((entry) => entry.isFile()));
    assert.equal(roots, 1);
    await check();
    assert.equal(roots, 2, "settled root observations cannot authorize a later read");
    await fs.rename(directory, path.join(root, "saved"));
    await fs.symlink(other, directory, "junction");
    await assert.rejects(check(), /Symbolic links/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("failed path checks do not survive repair", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "checked-repair-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const file = path.join(root, "new.txt");
  const failed = await Promise.allSettled([
    checkedSourceFile(root, file),
    checkedSourceFile(root, file),
  ]);
  assert.ok(failed.every((result) => result.status === "rejected"));
  await fs.writeFile(file, "now readable");
  assert.equal((await checkedSourceFile(root, file)).size, 12);
});

test("final material identity check does not share an earlier in-flight ancestry sample", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "checked-final-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const file = path.join(root, "material.txt");
  await fs.writeFile(file, "old material\n");
  const originalLstat = fs.lstat;
  const originalRealpath = fs.realpath;
  const originalIdentity = await originalLstat(file);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sampleReady!: () => void;
  const sampled = new Promise<void>((resolve) => {
    sampleReady = resolve;
  });
  let holdNextSample = false;
  let heldOnce = false;
  let contentRead = false;
  let secondary: Promise<unknown> | undefined;
  const originalOpen = fs.open;
  const openMock = t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) !== file) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "read")
          return async (...readArgs: unknown[]) => {
            const result = await Reflect.apply(target.read, target, readArgs);
            contentRead = true;
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const statMock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof originalLstat>) => {
    const stat = await originalLstat(...args);
    if (String(args[0]) === file && holdNextSample && !heldOnce) {
      heldOnce = true;
      sampleReady();
      await held;
    }
    return stat;
  });
  const pathMock = t.mock.method(
    fs,
    "realpath",
    async (...args: Parameters<typeof originalRealpath>) => {
      const actual = await originalRealpath(...args);
      // Hold an older ancestry sample while the primary read checks its final path.
      if (String(args[0]) === file && contentRead && !heldOnce) {
        holdNextSample = true;
        secondary = checkedSourceFile(root, file).catch(() => undefined);
        await sampled;
        await fs.rename(file, path.join(root, "saved.txt"));
        await fs.writeFile(file, "new material\n");
        assert.notEqual((await originalLstat(file)).ino, originalIdentity.ino);
        // The primary check reaches its final identity query before this release.
        setImmediate(release);
      }
      return actual;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(readSourceFile(root, file), /Material changed while observing/);
    assert.equal(heldOnce, true);
  } finally {
    release();
    await secondary;
    statMock.mock.restore();
    pathMock.mock.restore();
    openMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("initial source failures do not remain after a repair in the same request", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "checked-initial-repair-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const file = path.join(root, "new", "a.ts");
  await withFileReadScope(async () => {
    await assert.rejects(initialSourceFile(root, file), { code: "ENOENT" });
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, "restored");
    assert.equal((await initialSourceFile(root, file)).stat.size, 8n);
  });
});

test("a forced content read independently rejects a parent reported as a link after reading", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "checked-parent-swap-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const directory = path.join(root, "src");
  await fs.mkdir(directory);
  const filename = path.join(directory, "a.ts"),
    cache = path.join(root, "cache");
  await fs.writeFile(filename, "original");
  const old = new Date(Date.now() - 5_000);
  await fs.utimes(filename, old, old);
  await readSourceFile(root, filename);
  const originalOpen = fs.open,
    originalStat = fs.lstat;
  let replaced = false;
  // Windows can prevent renaming an open parent directory. Inject the later
  // kernel link observation; the preceding test uses a real junction between requests.
  const statMock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof originalStat>) => {
    const stat = await originalStat(...args);
    if (String(args[0]) !== directory || !replaced) return stat;
    return new Proxy(stat, {
      get(target, key) {
        if (key === "isSymbolicLink") return () => true;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) !== filename) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "read")
          return async (...readArgs: unknown[]) => {
            const result = await Reflect.apply(target.read, target, readArgs);
            replaced = true;
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withFileReadScope(() => readSourceFile(root, filename), true),
      /Symbolic links|changed/,
    );
    assert.equal(replaced, true);
  } finally {
    mocked.mock.restore();
    statMock.mock.restore();
    syncBuiltinESMExports();
  }
});
