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

for (const filename of ["During", null])
  test(`an ancestor ${filename === null ? "null" : "named"} rename discovers moved descendants under existing monitors`, async (t) => {
    // These are controlled nonrecursive inputs, independent of native OS event ordering.
    const root = path.join(testScratchRoot(), "ancestor-rescan-virtual");
    const tree = new Map<string, string[]>([
      ["", [".tent", ".git", "node_modules", ".worktrees", ".scratch", "linked"]],
      [
        ".tent",
        [
          "During",
          "Destination",
          "temp",
          ".git",
          "mutation.lock.guard",
          "mutation.lock.stale-test",
        ],
      ],
      [".tent/During", ["Child"]],
      [".tent/During/Child", []],
      [".tent/Destination", []],
    ]);
    const active = new Map<string, nodeFs.FSWatcher>();
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const scanned: string[] = [];
    let blockScans = false;
    let entered!: () => void, release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relative = (value: unknown) => path.relative(root, String(value)).replaceAll("\\", "/");
    t.mock.method(nodeFs, "watch", (...args: unknown[]) => {
      const name = relative(args[0]);
      assert.ok(tree.has(name), `no monitor reaches an ignored directory: ${name}`);
      const watcher = new EventEmitter() as nodeFs.FSWatcher;
      watcher.unref = () => watcher;
      watcher.close = () => {
        if (active.get(name) === watcher) {
          active.delete(name);
          listeners.delete(name);
        }
        watcher.emit("close");
      };
      active.set(name, watcher);
      listeners.set(name, args[2] as (event: string, filename: string | null) => void);
      return watcher;
    });
    t.mock.method(fs, "readdir", async (...args: unknown[]) => {
      const name = relative(args[0]);
      scanned.push(name);
      if (name === ".tent" && blockScans) {
        entered();
        await resumed;
      }
      const children = tree.get(name);
      assert.ok(children, `no scan reaches an ignored directory: ${name}`);
      return children.map((name) => ({
        name,
        isDirectory: () => name !== "linked",
      }));
    });
    syncBuiltinESMExports();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let hints: ReturnType<typeof changeHints>;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      hints = changeHints(root);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    t.after(() => {
      release();
      hints.close();
      assert.equal(active.size, 0, "all monitor handles are released");
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const events = new EventEmitter();
    const response = Object.assign(events, {
      destroyed: false,
      writeHead() {},
      flushHeaders() {},
      write() {
        return true;
      },
      destroy() {
        events.emit("close");
      },
    });
    await hints.subscribe(response as unknown as ServerResponse);
    const rootMonitor = active.get("");
    const destinationMonitor = active.get(".tent/Destination");
    tree.set(".tent", [
      "Destination",
      "temp",
      ".git",
      "mutation.lock.guard",
      "mutation.lock.stale-test",
    ]);
    tree.delete(".tent/During");
    tree.delete(".tent/During/Child");
    tree.set(".tent/Destination", ["During"]);
    tree.set(".tent/Destination/During", ["Child"]);
    tree.set(".tent/Destination/During/Child", []);
    // An ancestor rename alone must reconcile descendants, including its null-filename fallback.
    listeners.get(".tent")!("rename", filename);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(active.has(".tent/Destination/During/Child"));
    assert.ok(!active.has(".tent/During/Child"));
    assert.equal(active.get(""), rootMonitor);
    assert.equal(active.get(".tent/Destination"), destinationMonitor);
    assert.ok(scanned.every((name) => tree.has(name) || name.startsWith(".tent/During")));
    const scannedBeforeIgnored = scanned.length;
    listeners.get(".tent")!("rename", "temp");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scanned.length, scannedBeforeIgnored, "ignored events do not trigger scans");
    tree.set(".tent", []);
    listeners.get(".tent")!("rename", "Destination");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual([...active.keys()].sort(), ["", ".tent"]);
    tree.set(".tent", ["Late"]);
    tree.set(".tent/Late", ["Child"]);
    tree.set(".tent/Late/Child", []);
    blockScans = true;
    listeners.get(".tent")!("rename", "Late");
    await blocked;
    hints.close();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(active.size, 0, "a rescan completing after shutdown cannot recreate monitors");
  });
