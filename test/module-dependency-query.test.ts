import assert from "node:assert/strict";
import test from "node:test";
import { createModuleDependencyQuery } from "../src/core/read/module-dependency-query.js";
import type { ModuleDependencies } from "../src/core/graph/module-dependencies.js";

function graph(head: string): ModuleDependencies {
  return { basis: { head, dirty: true }, modules: [], edges: [], uncovered: 0, unresolved: 0 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("watched dependency reads reuse results and label stale data only inside the transition window", async () => {
  let changed!: () => void;
  let now = 1000;
  let calls = 0;
  let closeCount = 0;
  const update = deferred<ModuleDependencies>();
  const query = createModuleDependencyQuery({
    compute: async () => (++calls === 1 ? graph("one") : update.promise),
    watch: async (onChange) => {
      changed = onChange;
      return { close: () => closeCount++ };
    },
    now: () => now,
    reportMode: () => undefined,
  });
  const first = await query.read();
  assert.equal(first.fresh, true);
  assert.equal(first.mode, "watch");
  assert.deepEqual(await query.read(), first);
  assert.equal(calls, 1);
  changed();
  assert.equal(calls, 2, "invalidation refreshes without waiting for another request");
  assert.deepEqual(await query.read(), { ...first, fresh: false });
  now += 2000;
  let returned = false;
  const waiting = query.read().then((result) => {
    returned = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(returned, false, "an expired old result must not be returned");
  update.resolve(graph("two"));
  assert.equal((await waiting).basis.head, "two");
  assert.equal((await query.read()).computedAt, new Date(now).toISOString());
  await query.close();
  assert.equal(closeCount, 1);
  await assert.rejects(query.read(), /closed/);
});

test("events during computation force a new observation and concurrent readers share it", async () => {
  let changed!: () => void;
  let calls = 0;
  const first = deferred<ModuleDependencies>();
  const second = deferred<ModuleDependencies>();
  const query = createModuleDependencyQuery({
    compute: () => (++calls === 1 ? first.promise : second.promise),
    watch: async (onChange) => {
      changed = onChange;
      return { close() {} };
    },
    reportMode() {},
  });
  const a = query.read();
  const b = query.read();
  await Promise.resolve();
  await Promise.resolve();
  changed();
  first.resolve(graph("mixed"));
  await Promise.resolve();
  await Promise.resolve();
  second.resolve(graph("current"));
  assert.deepEqual(await a, await b);
  assert.equal((await a).basis.head, "current");
  assert.equal(calls, 2);
  await query.close();
});

test("unavailable notifications switch to explicit per-request verification and close the watcher", async () => {
  let unavailable!: (error: unknown) => void;
  let calls = 0;
  let closed = false;
  const modes: unknown[] = [];
  const query = createModuleDependencyQuery({
    compute: async () => graph(String(++calls)),
    watch: async (_onChange, onUnavailable) => {
      unavailable = onUnavailable;
      return {
        close: () => {
          closed = true;
        },
      };
    },
    reportMode: (...args) => modes.push(args),
  });
  await query.read();
  unavailable(new Error("watch limit reached"));
  assert.equal(closed, true);
  const result = await query.read();
  assert.equal(result.mode, "verify");
  assert.equal(result.reason, "watch limit reached");
  assert.equal(result.fresh, true);
  assert.equal(result.basis.head, "2");
  assert.equal((await query.read()).basis.head, "3");
  assert.deepEqual(modes, [["watch"], ["verify", "watch limit reached"]]);
  await query.close();
});

test("setup failure verifies reads and refresh errors never serve an expired graph", async () => {
  let calls = 0;
  const fallback = createModuleDependencyQuery({
    compute: async () => graph(String(++calls)),
    watch: async () => {
      throw new Error("not supported");
    },
    reportMode() {},
  });
  assert.equal((await fallback.read()).mode, "verify");
  assert.equal((await fallback.read()).basis.head, "2");
  await fallback.close();
  let changed!: () => void;
  let now = 0;
  calls = 0;
  const query = createModuleDependencyQuery({
    compute: async () => {
      if (++calls > 1) throw new Error("invalid import config");
      return graph("old");
    },
    watch: async (onChange) => {
      changed = onChange;
      return { close() {} };
    },
    now: () => now,
    reportMode() {},
  });
  await query.read();
  changed();
  now = 2000;
  await assert.rejects(query.read(), /invalid import config/);
  await query.close();
});

test("closing while the watcher is starting releases its eventual handle", async () => {
  let closed = false;
  const watch = deferred<{ close(): void }>();
  const query = createModuleDependencyQuery({
    compute: async () => {
      throw new Error("must not compute after close");
    },
    watch: () => watch.promise,
    reportMode() {},
  });
  const read = query.read();
  const close = query.close();
  watch.resolve({
    close: () => {
      closed = true;
    },
  });
  await close;
  await assert.rejects(read, /closed/);
  assert.equal(closed, true);
});
