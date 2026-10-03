import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { renameWithRetry } from "../src/fs/rename-with-retry.js";

function simulateRename(
  t: TestContext,
  platform: NodeJS.Platform,
  implementation: typeof fsPromises.rename,
) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  const mocked = t.mock.method(fsPromises, "rename", implementation);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", originalPlatform);
  });
  return mocked;
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`Windows publication retries two ${code} failures before succeeding`, async (t) => {
    let attempts = 0;
    const mocked = simulateRename(t, "win32", async (from, to) => {
      assert.equal(from, "staging");
      assert.equal(to, "destination");
      if (++attempts <= 2) throw Object.assign(new Error("temporarily occupied"), { code });
    });
    await renameWithRetry("staging", "destination");
    assert.equal(mocked.mock.callCount(), 3);
  });
}

for (const code of ["ENOENT", "EEXIST", "ENOTEMPTY", "EXDEV", "EIO"]) {
  test(`Windows publication preserves ${code} without retrying`, async (t) => {
    const failure = Object.assign(new Error("cannot publish"), { code });
    const mocked = simulateRename(t, "win32", async () => {
      throw failure;
    });
    await assert.rejects(renameWithRetry("staging", "destination"), (error) => error === failure);
    assert.equal(mocked.mock.callCount(), 1);
  });
}

test("Windows publication exhausts its short retry and preserves the final rename error", async (t) => {
  let failure: Error;
  const delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    delays.push(delay);
    callback();
  });
  const mocked = simulateRename(t, "win32", async () => {
    failure = Object.assign(new Error("still occupied"), { code: "EPERM" });
    throw failure;
  });
  await assert.rejects(renameWithRetry("staging", "destination"), (error) => error === failure);
  assert.equal(mocked.mock.callCount(), 10);
  assert.equal(delays.length, 9);
  assert.ok(delays.every((delay, index) => index === 0 || delay >= delays[index - 1]!));
  assert.ok(delays.reduce((total, delay) => total + delay, 0) <= 1_000);
});

test("publication on other platforms preserves a sharing error without retrying", async (t) => {
  const failure = Object.assign(new Error("access denied"), { code: "EPERM" });
  const mocked = simulateRename(t, "linux", async () => {
    throw failure;
  });
  await assert.rejects(renameWithRetry("staging", "destination"), (error) => error === failure);
  assert.equal(mocked.mock.callCount(), 1);
});
