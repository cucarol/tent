import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/file-lock-contender.ts", import.meta.url));

async function setup(t: TestContext) {
  await fs.mkdir(".scratch", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".scratch/mutation-race-"));
  const lock = path.join(root, "mutation.lock");
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  let diagnostics = "";
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(exits);
    await fs.rm(root, { recursive: true, force: true });
  });
  const marker = (id: string, stage: string) => path.join(root, `${id}.${stage}`);
  const start = (id: string, gate = false, mode = "normal") => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture, root, id, gate ? "gate" : "none", mode],
      {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-4096);
    });
    children.push(child);
    const exit = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    exits.push(exit);
    return { child, exit };
  };
  const wait = async (
    id: string,
    stage: string,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await fs.readFile(marker(id, stage), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      await delay(10);
    }
    throw new Error(`Missing ${id}.${stage}: ${diagnostics}`);
  };
  const signal = (id: string, stage: string) => fs.writeFile(marker(id, stage), "{}");
  const absent = async (id: string, stage: string) => {
    await assert.rejects(fs.access(marker(id, stage)), { code: "ENOENT" });
  };
  const owner = async () => JSON.parse(await fs.readFile(lock, "utf8"));
  const seed = async () => {
    await fs.writeFile(
      lock,
      JSON.stringify({ ownerToken: "stale", pid: 2147483647, createdAt: "2000-01-01T00:00:00Z" }),
    );
    await fs.utimes(lock, new Date(0), new Date(0));
  };
  const assertOwner = async (id: string, pid: number) => {
    const record = await owner();
    assert.equal(record.ownerToken, id);
    assert.equal(record.pid, pid);
  };
  const guard = () => fs.stat(`${lock}.guard`, { bigint: true });
  const guardOwner = async (directory = `${lock}.guard`) =>
    JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8"));
  const guardTombstones = async () =>
    (await fs.readdir(root)).filter((name) => name.startsWith("mutation.lock.guard.stale-"));
  return {
    start,
    wait,
    signal,
    absent,
    owner,
    seed,
    assertOwner,
    guard,
    guardOwner,
    guardTombstones,
    root,
    lock,
  };
}

test(
  "mutation: guard timeout preserves owner and guard while its holder is paused",
  { timeout: 40_000 },
  async (t) => {
    const harness = await setup(t);
    await harness.seed();
    const a = harness.start("a", true);
    await harness.wait("a", "probe");
    const ownerBefore = await harness.owner();
    const guardBefore = await harness.guard();
    const b = harness.start("b", false, "timeout");
    await harness.wait("b", "blocked");
    await harness.wait("b", "heartbeat");
    await harness.absent("b", "failed");
    const failure = String((await harness.wait("b", "failed", 25_000)).message);
    assert.match(failure, /Lock bookkeeping guard is still busy/);
    assert.ok(failure.includes(`${harness.lock}.guard`));
    assert.match(failure, /Manual cleanup is safe only after all Tent writers have stopped/);
    await b.exit;
    await harness.absent("b", "probe");
    await harness.absent("b", "acquired");
    assert.deepEqual(await harness.owner(), ownerBefore);
    const guardAfter = await harness.guard();
    assert.equal(guardAfter.ino, guardBefore.ino);
    assert.equal(guardAfter.dev, guardBefore.dev);
    await harness.signal("a", "release-gate");
    await harness.wait("a", "acquired");
    await harness.assertOwner("a", a.child.pid!);
    await harness.signal("a", "release");
    await harness.wait("a", "released");
  },
);

for (const crash of [false, true]) {
  test(`mutation: ${crash ? "killed" : "paused"} stale reclaimer cannot race another process's publication`, async (t) => {
    const harness = await setup(t);
    await harness.seed();
    const a = harness.start("a", true);
    assert.equal((await harness.wait("a", "probe")).pid, 2147483647);
    const b = harness.start("b");
    await harness.wait("b", "blocked");
    await harness.absent("b", "probe");
    await harness.absent("b", "acquired");
    assert.equal((await harness.owner()).pid, 2147483647);
    if (crash) {
      assert.equal((await harness.guardOwner()).pid, a.child.pid);
      a.child.kill("SIGKILL");
      await a.exit;
      await harness.wait("b", "acquired");
      const tombstones = await harness.guardTombstones();
      assert.equal(tombstones.length, 1);
      assert.equal(
        (await harness.guardOwner(path.join(harness.root, tombstones[0]))).pid,
        a.child.pid,
      );
      await harness.assertOwner("b", b.child.pid!);
      await harness.signal("b", "release");
      await harness.wait("b", "released");
    } else {
      await harness.signal("a", "release-gate");
      await harness.wait("a", "acquired");
      assert.match(
        String((await harness.wait("b", "failed")).message),
        /already owned|mutation busy/,
      );
      await harness.assertOwner("a", a.child.pid!);
      await harness.signal("a", "release");
      await harness.wait("a", "released");
    }
  });
}

test(`mutation: concurrent live-owner denial and wrong-owner release preserve the published owner`, async (t) => {
  const harness = await setup(t);
  const live = harness.start("live");
  await harness.wait("live", "acquired");
  const before = await harness.owner();
  harness.start("denied", true);
  assert.equal((await harness.wait("denied", "probe")).pid, live.child.pid);
  harness.start("old", false, "wrong-release");
  await harness.wait("old", "blocked");
  assert.deepEqual(await harness.owner(), before);
  await harness.signal("denied", "release-gate");
  assert.match(
    String((await harness.wait("denied", "failed")).message),
    /already owned|mutation busy/,
  );
  const released = await harness.wait("old", "released");
  assert.equal(released.removed, false);
  assert.deepEqual(await harness.owner(), before);
  await harness.assertOwner("live", live.child.pid!);
  await harness.signal("live", "release");
  await harness.wait("live", "released");
});
