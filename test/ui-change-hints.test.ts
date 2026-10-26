import assert from "node:assert/strict";
import test from "node:test";
import { followChangeHints, readChangeHints } from "../src/ui/data/change-hints.js";
import { workspaceRefresh } from "../src/ui/data/workspace-refresh.js";
import type { WorkspaceMap } from "../src/core/read/workspace-map.js";
import type { Snapshot } from "../src/ui/data/types.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const idleBurst = () => new Promise((resolve) => setTimeout(resolve, 35));
const map = (revision: string) => ({ workspace: { revision } }) as WorkspaceMap;
const snapshot = (revision: string) => ({ workspace: { revision } }) as Snapshot;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("fragmented UTF-8 SSE frames wake reads, with no data interpreted as workspace facts", async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(
    ': connected\r\n\r\nevent: change\r\ndata: {}\r\n\r\nevent: other\ndata: 中文\n\nevent: change\ndata: {"path":"ignored"}\n\n',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      controller.close();
    },
  });
  const calls: string[] = [];
  await readChangeHints(
    body,
    new AbortController().signal,
    () => calls.push("connected"),
    () => calls.push("hint"),
  );
  assert.deepEqual(calls, ["connected", "hint", "hint"]);
});

test("stopping a fragmented stream cancels its reader and applies no incomplete hint", async () => {
  const abort = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>,
    cancelled = false,
    calls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      source = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const reading = readChangeHints(
    body,
    abort.signal,
    () => calls++,
    () => calls++,
  );
  source.enqueue(new TextEncoder().encode("event: change\ndata: {}\n"));
  await tick();
  abort.abort();
  await reading;
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
});

test("closed connections back off, reconnect with a fresh read, and stop cancels retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let opens = 0,
    reads = 0;
  const signals: AbortSignal[] = [];
  const stop = followChangeHints(
    async (signal) => {
      signals.push(signal);
      opens++;
      return new Response(": connected\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
    () => reads++,
    () => false,
  );
  await tickMicrotasks();
  assert.equal(opens, 1);
  assert.equal(reads, 1);
  t.mock.timers.tick(999);
  await tickMicrotasks();
  assert.equal(opens, 1);
  t.mock.timers.tick(1);
  await tickMicrotasks();
  assert.deepEqual([opens, reads], [2, 2]);
  t.mock.timers.tick(1999);
  await tickMicrotasks();
  assert.equal(opens, 2, "a service that immediately closes does not cause a busy loop");
  stop();
  t.mock.timers.tick(60000);
  await tickMicrotasks();
  assert.equal(opens, 2);
  assert.ok(signals.every((s) => s.aborted));
});

test("unavailable watching leaves polling alone, while unauthorized connections stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let opens = 0,
    reads = 0,
    unauthorized = 0;
  const unavailable = followChangeHints(
    async () => {
      opens++;
      return new Response(null, { status: 503 });
    },
    () => reads++,
    () => {
      unauthorized++;
      return true;
    },
  );
  await tickMicrotasks();
  t.mock.timers.tick(60000);
  await tickMicrotasks();
  assert.deepEqual([opens, reads, unauthorized], [1, 0, 0]);
  unavailable();
  const error = { status: 401 };
  const stop = followChangeHints(
    async () => {
      opens++;
      throw error;
    },
    () => reads++,
    (e) => {
      assert.equal(e, error);
      unauthorized++;
      return true;
    },
  );
  await tickMicrotasks();
  t.mock.timers.tick(60000);
  await tickMicrotasks();
  assert.deepEqual([opens, reads, unauthorized], [2, 0, 1]);
  stop();
});

async function tickMicrotasks() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fixture() {
  const maps: ReturnType<typeof deferred<WorkspaceMap>>[] = [];
  const details: ReturnType<typeof deferred<Snapshot | null>>[] = [];
  const revisions: ReturnType<typeof deferred<{ revision: string }>>[] = [];
  const applied: string[] = [],
    failed: unknown[] = [],
    validators: (string | undefined)[] = [];
  const refresh = workspaceRefresh({
    map: () => {
      const d = deferred<WorkspaceMap>();
      maps.push(d);
      return d.promise;
    },
    snapshot: (revision) => {
      validators.push(revision);
      const d = deferred<Snapshot | null>();
      details.push(d);
      return d.promise;
    },
    revision: () => {
      const d = deferred<{ revision: string }>();
      revisions.push(d);
      return d.promise;
    },
    applyMap: (m) => applied.push(`map:${m.workspace.revision}`),
    applySnapshot: (s) => applied.push(`full:${s.workspace.revision}`),
    applyRevision: (r) => applied.push(`revision:${r}`),
    recovered: () => {},
    failed: (e) => {
      failed.push(e);
      return (e as { status?: number }).status === 401;
    },
  });
  return { refresh, maps, details, revisions, applied, failed, validators };
}

test("same revision polls still observe a fresh Core map for expiry without loading unrequested details", async (t) => {
  const f = fixture();
  t.after(f.refresh.stop);
  f.refresh.poll();
  f.revisions[0]!.resolve({ revision: "same" });
  await idleBurst();
  f.maps[0]!.resolve(map("before-expiry"));
  await tick();
  f.refresh.poll();
  f.revisions[1]!.resolve({ revision: "same" });
  await idleBurst();
  assert.equal(f.maps.length, 2);
  assert.equal(f.details.length, 0);
  f.maps[1]!.resolve(map("after-expiry"));
  await tick();
  assert.ok(f.applied.includes("map:after-expiry"));
});

test("same revision material hints publish fresh successful observations even with snapshot 304, but failed reads publish none", async (t) => {
  const f = fixture();
  t.after(f.refresh.stop);
  f.refresh.want();
  f.details[0]!.resolve(snapshot("same"));
  await tick();
  f.refresh.hint();
  await idleBurst();
  f.maps[0]!.resolve(map("same-map"));
  f.details[1]!.resolve(null);
  f.revisions[0]!.resolve({ revision: "same" });
  await tick();
  assert.equal(f.applied.filter((event) => event.startsWith("map:")).length, 1);
  f.refresh.hint();
  await idleBurst();
  f.maps[1]!.resolve(map("same-map"));
  f.details[2]!.resolve(null);
  f.revisions[1]!.resolve({ revision: "same" });
  await tick();
  assert.equal(f.applied.filter((event) => event.startsWith("map:")).length, 2);
  assert.deepEqual(f.validators, [undefined, "same", "same"]);
  f.refresh.hint();
  await idleBurst();
  f.maps[2]!.reject(new Error("map read failed"));
  f.details[3]!.resolve(null);
  f.revisions[2]!.resolve({ revision: "same" });
  await tick();
  assert.equal(f.failed.length, 1);
  assert.equal(f.applied.filter((event) => event.startsWith("map:")).length, 2);
});

test("hint bursts merge and an in-flight map gets one immediate follow-up without waiting for revision or full", async (t) => {
  const f = fixture();
  t.after(f.refresh.stop);
  f.refresh.want();
  f.refresh.want();
  f.refresh.poll();
  for (let i = 0; i < 8; i++) f.refresh.hint();
  await idleBurst();
  assert.deepEqual([f.maps.length, f.details.length, f.revisions.length], [1, 1, 1]);
  f.maps[0]!.resolve(map("new-topic"));
  await tick();
  assert.deepEqual(
    f.applied,
    ["map:new-topic"],
    "the full snapshot and revision are still pending",
  );
  for (let i = 0; i < 8; i++) f.refresh.hint();
  await idleBurst();
  assert.equal(f.maps.length, 2, "slow full details do not block another map");
  f.refresh.hint();
  f.refresh.hint();
  f.maps[1]!.resolve(map("moved-topic"));
  await tick();
  assert.equal(f.maps.length, 3, "one queued follow-up starts as soon as the active map ends");
  assert.equal(f.details.length, 1, "first details and all hints share the snapshot flight");
  f.details[0]!.resolve(snapshot("older-details"));
  await tick();
  assert.equal(f.details.length, 2);
  assert.deepEqual(f.validators, [undefined, "older-details"]);
  assert.deepEqual(f.applied, ["map:new-topic", "map:moved-topic", "full:older-details"]);
  assert.equal(f.maps.length, 3, "applying late details never reads or overwrites map topology");
});

test("polling compares full revisions and reads only requested details; failures can retry", async (t) => {
  const f = fixture();
  t.after(f.refresh.stop);
  f.refresh.poll();
  f.revisions[0]!.resolve({ revision: "r1" });
  await idleBurst();
  assert.deepEqual([f.maps.length, f.details.length], [1, 0]);
  f.maps[0]!.resolve(map("map-r1"));
  f.refresh.want();
  f.details[0]!.reject(new Error("offline"));
  await tick();
  assert.equal(f.failed.length, 1);
  f.refresh.want();
  f.details[1]!.resolve(snapshot("r1"));
  await tick();
  f.refresh.want();
  f.refresh.poll();
  f.revisions[1]!.resolve({ revision: "r1" });
  await idleBurst();
  assert.deepEqual([f.maps.length, f.details.length], [2, 2]);
  f.maps[1]!.resolve(map("map-r1-fresh"));
  await tick();
  f.refresh.poll();
  f.revisions[2]!.resolve({ revision: "r2" });
  await idleBurst();
  assert.deepEqual([f.maps.length, f.details.length], [3, 3]);
});

test("stopping or a 401 prevents late responses, queued work, and further polling", async () => {
  for (const unauthorized of [false, true]) {
    const f = fixture();
    f.refresh.want();
    f.refresh.hint();
    f.refresh.poll();
    await idleBurst();
    f.refresh.hint();
    if (unauthorized) {
      f.revisions[0]!.reject({ status: 401 });
      await tick();
    } else f.refresh.stop();
    f.details[0]!.resolve(snapshot("late"));
    f.maps[0]!.resolve(map("late"));
    await idleBurst();
    f.refresh.hint();
    f.refresh.want();
    f.refresh.poll();
    await idleBurst();
    assert.deepEqual(f.applied, []);
    assert.deepEqual([f.maps.length, f.details.length, f.revisions.length], [1, 1, 1]);
    f.refresh.stop();
  }
});

test("polling retries a failed map even when the workspace revision has not changed again", async (t) => {
  const f = fixture();
  t.after(f.refresh.stop);
  f.refresh.poll();
  f.revisions[0]!.resolve({ revision: "r1" });
  await idleBurst();
  f.maps[0]!.reject(new Error("offline"));
  await tick();
  f.refresh.poll();
  f.revisions[1]!.resolve({ revision: "r1" });
  await idleBurst();
  assert.equal(f.maps.length, 2);
  f.maps[1]!.resolve(map("recovered"));
  await tick();
  assert.ok(f.applied.includes("map:recovered"));
});

test("a hint's parallel revision invalidates open sections without a second map or full read", async (t) => {
  const f = fixture();
  t.after(f.refresh.stop);
  f.refresh.want();
  f.details[0]!.resolve(snapshot("r1"));
  await tick();
  f.refresh.hint();
  await idleBurst();
  assert.deepEqual([f.maps.length, f.details.length, f.revisions.length], [1, 2, 1]);
  f.maps[0]!.resolve(map("map-r2"));
  f.details[1]!.resolve(snapshot("r2"));
  await tick();
  f.revisions[0]!.resolve({ revision: "r2" });
  await idleBurst();
  assert.ok(f.applied.includes("revision:r2"));
  assert.deepEqual([f.maps.length, f.details.length, f.revisions.length], [1, 2, 1]);
});

test("polling during a hint's revision retains its fallback check and shares the revision flight", async (t) => {
  const f = fixture();
  t.after(f.refresh.stop);
  f.refresh.hint();
  await idleBurst();
  f.refresh.poll();
  f.refresh.poll();
  assert.equal(f.revisions.length, 1);
  f.revisions[0]!.resolve({ revision: "r1" });
  await tick();
  assert.deepEqual([f.maps.length, f.revisions.length], [1, 2]);
  f.revisions[1]!.resolve({ revision: "r2" });
  await tick();
  assert.equal(f.maps.length, 1, "the fallback shares the map flight too");
  f.maps[0]!.resolve(map("map-r1"));
  await tick();
  assert.equal(
    f.maps.length,
    2,
    "the fallback poll still requests the newer map after the active read",
  );
  assert.equal(f.revisions.length, 2, "repeated pending polls collapse into one fallback");
});
