import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodeFs, { type FSWatcher, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { changeHints } from "../src/ui-server/change-hints.js";

const originals = {
  watch: nodeFs.watch,
  stat: fs.stat,
  readdir: fs.readdir,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  platform: Object.getOwnPropertyDescriptor(process, "platform")!,
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Timer = { due: number; fire: () => void; unref(): void };

/** No native watches or timers: event delivery and lock visibility are independent inputs. */
async function fixture(t: TestContext, recursive: boolean) {
  const workspaceRoot = path.resolve(".scratch", "change-hint-ordering");
  const timers = new Set<Timer>();
  const monitors = new Map<string, (event: string, filename: string) => void>();
  const scanGates = new Map<string, Promise<void>>();
  const releases: Array<() => void> = [];
  const frames: string[] = [];
  let now = 0,
    held = true;
  const relative = (filename: unknown) =>
    path.relative(workspaceRoot, String(filename)).replaceAll("\\", "/");
  const restore = () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(nodeFs.watch, originals.watch);
    assert.equal(fs.stat, originals.stat);
    assert.equal(fs.readdir, originals.readdir);
    assert.equal(globalThis.setTimeout, originals.setTimeout);
    assert.equal(globalThis.clearTimeout, originals.clearTimeout);
    assert.deepEqual(Object.getOwnPropertyDescriptor(process, "platform"), originals.platform);
  };
  // Also check the preceding fixture restored its process-wide mocks.
  restore();
  t.mock.method(nodeFs, "watch", (...args: unknown[]) => {
    const directory = relative(args[0]);
    assert.equal((args[1] as { recursive: boolean }).recursive, recursive);
    const callback = args[2] as (event: string, filename: string) => void;
    const watcher = new EventEmitter();
    Object.assign(watcher, {
      close: () => monitors.delete(directory),
      unref: () => watcher,
    });
    monitors.set(directory, callback);
    return watcher as FSWatcher;
  });
  t.mock.method(fs, "stat", async (...args: unknown[]) => {
    if (relative(args[0]) === ".tent/mutation.lock") {
      if (held) return {} as Stats;
      throw Object.assign(new Error("lock absent"), { code: "ENOENT" });
    }
    assert.equal(relative(args[0]), ".tent/Main/Main.md");
    return { isDirectory: () => false } as Stats;
  });
  t.mock.method(fs, "readdir", async (...args: unknown[]) => {
    const directory = relative(args[0]);
    const gate = scanGates.get(directory);
    if (gate) {
      scanGates.delete(directory);
      await gate;
    }
    const children = directory === "" ? [".tent"] : directory === ".tent" ? ["Main"] : [];
    return children.map((name) => ({ name, isDirectory: () => true }));
  });
  t.mock.method(globalThis, "setTimeout", (fire: () => void, delay: number) => {
    const timer = { due: now + delay, fire, unref() {} };
    timers.add(timer);
    return timer as unknown as NodeJS.Timeout;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: unknown) => timers.delete(timer as Timer));
  syncBuiltinESMExports();

  // changeHints selects its watch strategy synchronously; restore the host before any await.
  let hints: ReturnType<typeof changeHints>;
  try {
    Object.defineProperty(process, "platform", {
      ...originals.platform,
      value: recursive ? "win32" : "darwin",
    });
    hints = changeHints(workspaceRoot);
  } finally {
    Object.defineProperty(process, "platform", originals.platform);
  }
  t.after(async () => {
    try {
      hints.close();
      for (const release of releases) release();
      await settle();
      assert.equal(monitors.size, 0, "closing releases every synthetic watcher");
      assert.equal(timers.size, 0, "closing cancels every pending hint timer");
    } finally {
      restore();
    }
  });
  const response = new EventEmitter();
  Object.assign(response, {
    destroyed: false,
    writeHead() {},
    flushHeaders() {},
    write(frame: string) {
      frames.push(frame);
      return true;
    },
    destroy: () => response.emit("close"),
  });
  await hints.subscribe(response as ServerResponse);
  assert.deepEqual(frames, [": connected\n\n"]);

  async function event(directory: string, kind: "change" | "rename", filename: string) {
    const callback = monitors.get(recursive ? "" : directory);
    assert.ok(callback, `watch installed for ${directory}`);
    callback(kind, recursive ? path.posix.join(directory, filename) : filename);
    await settle();
  }
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a.due - b.due)[0];
      if (!next || next.due > target) break;
      now = next.due;
      timers.delete(next);
      next.fire();
      await settle();
    }
    now = target;
    // A released rescan can schedule a timer even when this tick had no timer to fire.
    await settle();
  }
  return {
    advance,
    document: () => event(".tent/Main", "change", "Main.md"),
    releaseEvent: () => event(".tent", "rename", "mutation.lock"),
    unlock: () => {
      held = false;
    },
    blockRescan() {
      let release!: () => void;
      scanGates.set(
        ".tent",
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      releases.push(release);
      return release;
    },
    expectHints(count: number) {
      assert.equal(frames.length, count + 1);
      assert.ok(frames.slice(1).every((frame) => frame === "event: change\ndata: {}\n\n"));
    },
    expectIdle() {
      assert.equal(timers.size, 0, "no hint timer is queued without another event");
    },
  };
}

for (const recursive of [false, true]) {
  const strategy = recursive ? "recursive" : "nonrecursive";
  test(`${strategy} watch merges one pending batch and stays silent while the lock is held`, async (t) => {
    const f = await fixture(t, recursive);
    for (let i = 0; i < 20; i++) await f.document();
    await f.advance(50);
    f.expectHints(0);
    f.unlock();
    await f.releaseEvent();
    await f.advance(50);
    f.expectHints(1);
    await f.advance(5_000);
    f.expectHints(1);
    f.expectIdle();
  });

  test(`${strategy} watch may deliver a late release after the held-lock poll already sent a hint`, async (t) => {
    const f = await fixture(t, recursive);
    await f.document();
    await f.advance(50);
    f.expectHints(0);
    f.unlock();
    await f.advance(50);
    f.expectHints(1);
    await f.advance(60);
    await f.releaseEvent();
    await f.advance(50);
    f.expectHints(2);
    await f.advance(5_000);
    f.expectHints(2);
    f.expectIdle();
  });

  test(`${strategy} lock release alone wakes a read without any document notification`, async (t) => {
    const f = await fixture(t, recursive);
    f.unlock();
    await f.releaseEvent();
    await f.advance(50);
    f.expectHints(1);
    f.expectIdle();
  });

  test(`${strategy} watch preserves a genuine later document change after an earlier hint`, async (t) => {
    const f = await fixture(t, recursive);
    f.unlock();
    await f.document();
    await f.advance(50);
    f.expectHints(1);
    await f.document();
    await f.advance(50);
    f.expectHints(2);
    await f.advance(5_000);
    f.expectHints(2);
    f.expectIdle();
  });
}

test("one pending nonrecursive batch waits for its rescan before sending an empty hint", async (t) => {
  const f = await fixture(t, false);
  f.unlock();
  const release = f.blockRescan();
  await f.releaseEvent();
  await f.advance(50);
  f.expectHints(0);
  release();
  await f.advance(0);
  await f.advance(50);
  f.expectHints(1);
  await f.advance(5_000);
  f.expectHints(1);
  f.expectIdle();
});

test("a nonrecursive rescan started after a sent hint can send a later empty hint", async (t) => {
  const f = await fixture(t, false);
  f.unlock();
  await f.document();
  await f.advance(50);
  f.expectHints(1);
  const release = f.blockRescan();
  await f.releaseEvent();
  await f.advance(50);
  f.expectHints(1);
  release();
  await f.advance(0);
  await f.advance(50);
  f.expectHints(2);
  await f.advance(5_000);
  f.expectHints(2);
  f.expectIdle();
});
