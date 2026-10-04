import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import {
  mayReclaimLock,
  readMutationLockRecord,
  releaseMutationLockIfOwned,
  withFileMutationLock,
} from "../src/fs/mutation-lock.js";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(testScratchRoot(), "tent-mutation-lock-"));
}

test("bounded acquisition waiting never executes a timed-out action or retries action failures", async (t) => {
  const dir = await tempRoot();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "mutation.lock");
  const options = { busyMessage: "busy", acquireFailedMessage: "failed", waitMs: 100 };
  let acquired!: () => void,
    release!: () => void,
    calls = 0;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const holder = withFileMutationLock(
    lockPath,
    async () => {
      acquired();
      await held;
    },
    options,
  );
  await ready;
  const start = performance.now();
  try {
    await assert.rejects(
      withFileMutationLock(
        lockPath,
        async () => {
          calls++;
        },
        options,
      ),
      /busy/,
    );
    assert.ok(performance.now() - start >= 100);
    assert.equal(calls, 0);
  } finally {
    release();
    await holder;
  }
  await assert.rejects(
    withFileMutationLock(
      lockPath,
      async () => {
        calls++;
        throw new Error("busy after side effect");
      },
      options,
    ),
    /busy after side effect/,
  );
  assert.equal(calls, 1);
});

test("mutation lock rejects a concurrent holder and releases for the next", async () => {
  const dir = await tempRoot();
  const lockPath = path.join(dir, "mutation.lock");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withFileMutationLock(lockPath, () => held, {
    busyMessage: "busy",
    acquireFailedMessage: "failed",
  });
  while (
    !(await fs.stat(lockPath).then(
      () => true,
      () => false,
    ))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok((await readMutationLockRecord(lockPath))?.ownerToken);
  await assert.rejects(
    () =>
      withFileMutationLock(lockPath, async () => undefined, {
        busyMessage: "busy",
        acquireFailedMessage: "failed",
      }),
    /busy/,
  );
  release();
  await first;
  await withFileMutationLock(lockPath, async () => undefined, {
    busyMessage: "busy",
    acquireFailedMessage: "failed",
  });
});

test("mutation lock release is ownership-safe", async () => {
  const dir = await tempRoot();
  const lockPath = path.join(dir, "mutation.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({ ownerToken: "new", pid: process.pid, createdAt: new Date().toISOString() }),
  );
  await releaseMutationLockIfOwned(lockPath, "old");
  assert.equal((await readMutationLockRecord(lockPath))?.ownerToken, "new");
  await releaseMutationLockIfOwned(lockPath, "new");
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
});

test("live process blocks age-only reclaim", async () => {
  const dir = await tempRoot();
  const lockPath = path.join(dir, "mutation.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({ ownerToken: "live", pid: process.pid, createdAt: new Date(0).toISOString() }),
  );
  assert.equal(
    await mayReclaimLock(
      lockPath,
      () => Date.now(),
      1,
      () => true,
    ),
    false,
  );
});

test("dead process permits stale reclaim", async () => {
  const dir = await tempRoot();
  const lockPath = path.join(dir, "mutation.lock");
  await fs.writeFile(
    lockPath,
    JSON.stringify({ ownerToken: "dead", pid: 999999, createdAt: new Date(0).toISOString() }),
  );
  await fs.utimes(lockPath, new Date(0), new Date(0));
  assert.equal(
    await mayReclaimLock(
      lockPath,
      () => Date.now(),
      1,
      () => false,
    ),
    true,
  );
});
