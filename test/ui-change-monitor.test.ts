import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { changeHints } from "../src/ui-server/change-hints.js";
import { testScratchRoot } from "./scratch.js";

test("a nonrecursive topology rescan finishes before its coalesced hint is published", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "change-monitor-"));
  await fs.mkdir(path.join(root, ".tent"));
  const callbacks = new Map<string, (event: string, filename: string) => void>();
  const watchers = new Set<EventEmitter>();
  class Watcher extends EventEmitter {
    unref() {
      return this;
    }
    close() {
      watchers.delete(this);
      this.emit("close");
    }
  }
  t.mock.method(nodeFs, "watch", (...args: unknown[]) => {
    const [directory, _options, listener] = args;
    callbacks.set(String(directory), listener as (event: string, filename: string) => void);
    const watcher = new Watcher();
    watchers.add(watcher);
    return watcher as nodeFs.FSWatcher;
  });
  let blocking = false,
    held = false;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const originalRead = nodeFs.promises.readdir;
  t.mock.method(nodeFs.promises, "readdir", async (...args: Parameters<typeof originalRead>) => {
    if (String(args[0]) === path.join(root, ".tent")) {
      if (blocking) await blocked;
      return [];
    }
    return Reflect.apply(originalRead, nodeFs.promises, args);
  });
  const originalStat = nodeFs.promises.stat;
  t.mock.method(nodeFs.promises, "stat", (...args: Parameters<typeof originalStat>) => {
    if (String(args[0]) === path.join(root, ".tent/mutation.lock"))
      return held
        ? Promise.resolve({} as nodeFs.Stats)
        : Promise.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
    return Reflect.apply(originalStat, nodeFs.promises, args);
  });
  syncBuiltinESMExports();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const hints = changeHints(root);
  Object.defineProperty(process, "platform", platform);
  const frames: string[] = [];
  const events = new EventEmitter();
  const response = Object.assign(events, {
    destroyed: false,
    writeHead() {},
    flushHeaders() {},
    write(frame: string) {
      frames.push(frame);
      return true;
    },
    destroy() {
      response.destroyed = true;
      events.emit("close");
    },
  });
  try {
    await hints.subscribe(response as unknown as ServerResponse);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    blocking = true;
    callbacks.get(path.join(root, ".tent"))!("rename", "mutation.lock");
    for (let i = 0; i < 20; i++) callbacks.get(path.join(root, ".tent"))!("change", "note.md");
    t.mock.timers.tick(50);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(frames, [": connected\n\n"]);
    held = false;
    blocking = false;
    unblock();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    t.mock.timers.tick(50);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(frames, [": connected\n\n", "event: change\ndata: {}\n\n"]);
    t.mock.timers.tick(200);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(frames.length, 2);
    // A later independent lock or file change is never suppressed by a TTL.
    held = true;
    for (let i = 0; i < 20; i++) callbacks.get(path.join(root, ".tent"))!("change", "note.md");
    callbacks.get(path.join(root, ".tent"))!("change", "mutation.lock");
    t.mock.timers.tick(50);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(frames.length, 2);
    held = false;
    callbacks.get(path.join(root, ".tent"))!("change", "mutation.lock");
    t.mock.timers.tick(50);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(frames.length, 3);
    callbacks.get(path.join(root, ".tent"))!("change", "later.md");
    t.mock.timers.tick(50);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(frames.length, 4);
    assert.ok(frames.slice(1).every((frame) => frame === "event: change\ndata: {}\n\n"));
  } finally {
    unblock();
    hints.close();
    assert.equal(watchers.size, 0);
    t.mock.timers.reset();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
