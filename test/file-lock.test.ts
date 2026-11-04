import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { withFileLock, FileLockBusyError } from "../src/fs/file-lock.js";

const contender = fileURLToPath(new URL("./fixtures/file-lock-contender.ts", import.meta.url));
const DEAD_PID = 2147483647;

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "tent-file-lock-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  return { root, lock: path.join(root, "test.lock") };
}

async function seedOwner(lock: string, pid: number, token = "seeded") {
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ token, pid }));
}

function start(t: TestContext, ...args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", contender, ...args], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  });
  return { child, exit };
}

test("a waiter runs exactly once after the holder releases", async (t) => {
  const { lock } = await setup(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding!: () => void;
  const acquired = new Promise<void>((resolve) => (holding = resolve));
  const holder = withFileLock(lock, async () => {
    holding();
    await held;
  });
  await acquired;
  let calls = 0;
  const waiter = withFileLock(
    lock,
    async () => {
      calls++;
    },
    { waitMs: 5_000 },
  );
  await delay(50);
  assert.equal(calls, 0);
  release();
  await holder;
  await waiter;
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("a timed-out waiter never runs and names the lock; a failed action is not retried", async (t) => {
  const { lock } = await setup(t);
  await seedOwner(lock, process.pid);
  let calls = 0;
  const started = performance.now();
  await assert.rejects(
    withFileLock(lock, async () => void calls++, { waitMs: 100, busyMessage: "busy test" }),
    (error) => error instanceof FileLockBusyError && error.message === "busy test",
  );
  assert.ok(performance.now() - started >= 100);
  assert.equal(calls, 0);
  await fs.rm(lock, { recursive: true });
  await assert.rejects(
    withFileLock(lock, async () => {
      calls++;
      throw new Error("failed after side effect");
    }),
    /failed after side effect/,
  );
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("a live holder is never evicted, however old its lock is", async (t) => {
  const { lock } = await setup(t);
  await seedOwner(lock, process.pid);
  await fs.utimes(lock, new Date(0), new Date(0));
  await assert.rejects(
    withFileLock(lock, async () => undefined, { waitMs: 50 }),
    /still busy/,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")).pid,
    process.pid,
  );
});

test("a dead holder is reclaimed at once and leaves a tombstone", async (t) => {
  const { root, lock } = await setup(t);
  await seedOwner(lock, DEAD_PID, "dead");
  let calls = 0;
  await withFileLock(lock, async () => void calls++, { waitMs: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(root), ["test.lock.stale-dead"]);
});

test("a killed process's lock is reclaimed by the next one", async (t) => {
  const { root, lock } = await setup(t);
  const holder = start(t, root, "hold");
  while (!(await fs.stat(path.join(root, "held")).catch(() => null))) await delay(10);
  await assert.rejects(
    withFileLock(lock, async () => undefined, { waitMs: 50 }),
    /still busy/,
  );
  holder.child.kill("SIGKILL");
  await holder.exit;
  let calls = 0;
  await withFileLock(lock, async () => void calls++);
  assert.equal(calls, 1);
});

test(
  "processes contending over a dead holder's lock never overlap",
  { timeout: 120_000 },
  async (t) => {
    const { root, lock } = await setup(t);
    await seedOwner(lock, DEAD_PID, "dead");
    await fs.writeFile(path.join(root, "counter"), "0");
    const contenders = Array.from({ length: 4 }, () => start(t, root, "count", "25"));
    assert.deepEqual(await Promise.all(contenders.map(({ exit }) => exit)), [0, 0, 0, 0]);
    assert.equal(await fs.readFile(path.join(root, "counter"), "utf8"), "100");
  },
);
