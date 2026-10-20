import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { batchRead } from "../src/ui-server/read-batch.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function response() {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const events = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    req: { socket },
  });
  return {
    res: events as unknown as ServerResponse,
    events,
    socket,
    close() {
      events.destroyed = true;
      events.emit("close");
    },
    disconnect() {
      socket.destroyed = true;
      socket.emit("close");
    },
  };
}

test("late readers share a fresh batch, never the observation already in progress", async () => {
  const firstStarted = gate(),
    firstFinish = gate(),
    nextStarted = gate(),
    nextFinish = gate();
  let version = "before",
    calls = 0,
    active = 0,
    maximum = 0;
  const read = batchRead<string, { version: string; readers: string[] }>(async (readers) => {
    const call = ++calls,
      observed = version;
    maximum = Math.max(maximum, ++active);
    if (call === 1) {
      firstStarted.release();
      await firstFinish.promise;
    } else if (call === 2) {
      nextStarted.release();
      await nextFinish.promise;
    }
    active--;
    return { version: observed, readers: readers() };
  });
  const a = response(),
    b = response(),
    c = response(),
    d = response();
  const older = read("a", a.res);
  await firstStarted.promise;
  version = "after";
  const newer = [read("b", b.res), read("c", c.res)];
  assert.equal(calls, 1);
  firstFinish.release();
  assert.deepEqual(await older, { version: "before", readers: ["a"] });
  await nextStarted.promise;
  assert.equal(calls, 2);
  nextFinish.release();
  assert.deepEqual(await Promise.all(newer), [
    { version: "after", readers: ["b", "c"] },
    { version: "after", readers: ["b", "c"] },
  ]);
  version = "latest";
  assert.deepEqual(await read("d", d.res), { version: "latest", readers: ["d"] });
  assert.equal(calls, 3);
  assert.equal(maximum, 1);
  for (const client of [a, b, c, d]) {
    assert.equal(client.events.listenerCount("close"), 0);
    assert.equal(client.socket.listenerCount("close"), 0);
  }
});

test("disconnected waiting readers create no later work and leave no listeners", async () => {
  const started = gate(),
    finish = gate();
  let calls = 0;
  const read = batchRead<string, string[]>(async (readers) => {
    calls++;
    started.release();
    await finish.promise;
    return readers();
  });
  const a = response(),
    b = response(),
    c = response();
  const first = read("a", a.res);
  await started.promise;
  const abandoned = [read("b", b.res), read("c", c.res)];
  b.close();
  c.disconnect();
  assert.deepEqual(await Promise.all(abandoned), [undefined, undefined]);
  finish.release();
  assert.deepEqual(await first, ["a"]);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(await read("already closed", b.res), undefined);
  assert.equal(await read("already disconnected", c.res), undefined);
  for (const client of [a, b, c]) {
    assert.equal(client.events.listenerCount("close"), 0);
    assert.equal(client.socket.listenerCount("close"), 0);
  }
});

test("a running batch can skip its next phase after disconnect and still serve waiting readers", async () => {
  const started = gate(),
    finish = gate();
  let calls = 0,
    expensivePhases = 0;
  const read = batchRead<string, string[]>(async (readers) => {
    if (++calls === 1) {
      started.release();
      await finish.promise;
    }
    if (!readers().length) return;
    expensivePhases++;
    return readers();
  });
  const a = response(),
    b = response(),
    c = response();
  const abandoned = read("a", a.res);
  await started.promise;
  const closedWaiting = read("b", b.res),
    remaining = read("c", c.res);
  a.close();
  b.close();
  assert.equal(await abandoned, undefined);
  assert.equal(await closedWaiting, undefined);
  finish.release();
  assert.deepEqual(await remaining, ["c"]);
  assert.equal(calls, 2);
  assert.equal(expensivePhases, 1);
});

test("a failed read rejects its live callers without poisoning the next batch", async () => {
  const started = gate(),
    finish = gate(),
    failureStarted = gate(),
    failureFinish = gate();
  const failure = new Error("read failed");
  let calls = 0;
  const read = batchRead<string, string[]>(async (readers) => {
    if (++calls === 1) {
      started.release();
      await finish.promise;
    } else if (calls === 2) {
      failureStarted.release();
      await failureFinish.promise;
      throw failure;
    }
    return readers();
  });
  const a = response(),
    b = response(),
    c = response(),
    d = response();
  const first = read("a", a.res);
  await started.promise;
  const failed = [
    assert.rejects(read("b", b.res), (error) => error === failure),
    assert.rejects(read("c", c.res), (error) => error === failure),
  ];
  finish.release();
  assert.deepEqual(await first, ["a"]);
  await failureStarted.promise;
  const next = read("d", d.res);
  failureFinish.release();
  await Promise.all(failed);
  assert.deepEqual(await next, ["d"]);
  for (const client of [a, b, c, d]) {
    assert.equal(client.events.listenerCount("close"), 0);
    assert.equal(client.socket.listenerCount("close"), 0);
  }
});
