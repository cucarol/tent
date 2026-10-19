import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { checkedSourceFile } from "../src/fs/checked-source-file.js";
import { observeSourceFile } from "../src/fs/source-observation.js";
import { testScratchRoot } from "./scratch.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";

test("overlapping path checks share pending ancestry reads but later checks see replacement links", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "checked-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
  let paths = 0;
  let secondary: Promise<unknown> | undefined;
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
      // observeSourceFile's fourth leaf realpath follows its final handle.stat().
      if (String(args[0]) === file && ++paths === 4) {
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
    await assert.rejects(observeSourceFile(root, file), /Material changed while observing/);
    assert.equal(heldOnce, true);
  } finally {
    release();
    await secondary;
    statMock.mock.restore();
    pathMock.mock.restore();
    syncBuiltinESMExports();
  }
});
