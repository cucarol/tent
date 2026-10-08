import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ApiError, api, changes } from "../src/ui/data/api.js";
import {
  snapshotDisagrees,
  snapshotRebuilder,
  SYNC_EVERY,
  UNREAD,
  watchSyncFlags,
} from "../src/ui/data/flags.js";
import type { Snapshot, SyncFlags } from "../src/ui/data/types.js";

function watching(t: TestContext) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const restore: (() => void)[] = [];
  for (const [name, value] of [
    ["window", win],
    ["document", doc],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() =>
      descriptor
        ? Object.defineProperty(globalThis, name, descriptor)
        : Reflect.deleteProperty(globalThis, name),
    );
  }
  const requests: {
    resolve(value: Awaited<ReturnType<typeof api.sync>>): void;
    reject(error: Error): void;
  }[] = [];
  t.mock.method(
    api,
    "sync",
    () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  );
  t.mock.timers.enable({ apis: ["setInterval"] });
  const published: SyncFlags[] = [];
  const reader = watchSyncFlags((flags) => published.push(flags));
  t.after(() => {
    reader.stop();
    for (const reset of restore) reset();
  });
  const finish = async (index: number, revision: string, nodes: SyncFlags = {}) => {
    requests[index]!.resolve({ revision, nodes });
    await Promise.resolve();
  };
  return { reader, requests, published, finish, win, doc };
}

test("sync starts before the snapshot and reuses a matching startup read in either order", async (t) => {
  for (const snapshotFirst of [true, false]) {
    await t.test(snapshotFirst ? "snapshot first" : "sync first", async (t) => {
      const { reader, requests, finish, published } = watching(t);
      assert.equal(requests.length, 1);
      if (snapshotFirst) reader.atRevision("same");
      await finish(0, "same");
      if (!snapshotFirst) assert.deepEqual(published, []);
      if (!snapshotFirst) reader.atRevision("same");
      assert.equal(requests.length, 1);
      assert.deepEqual(published, [{}]);
    });
  }
});

test("different startup revisions trigger another sync read in either arrival order", async (t) => {
  for (const snapshotFirst of [true, false]) {
    await t.test(snapshotFirst ? "snapshot first" : "sync first", async (t) => {
      const { reader, requests, finish, published } = watching(t);
      if (snapshotFirst) reader.atRevision("new");
      await finish(0, "old");
      if (!snapshotFirst) reader.atRevision("new");
      assert.equal(requests.length, 2);
      assert.deepEqual(published, []);
      const fresh = { changed: { behind: { reasons: ["Material changed"] } } };
      await finish(1, "new", fresh);
      assert.deepEqual(published.at(-1), fresh);
      assert.equal(requests.length, 2);
    });
  }
});

test("a real revision transition during startup is refreshed even when the response matches", async (t) => {
  const { reader, requests, finish } = watching(t);
  reader.atRevision("old");
  reader.atRevision("new");
  assert.equal(requests.length, 1);
  await finish(0, "new");
  assert.equal(requests.length, 2);
  await finish(1, "new");
  reader.atRevision("new");
  assert.equal(requests.length, 2);
});

test("a newer sync stays unread until its snapshot arrives, then still refreshes the revision move", async (t) => {
  const { reader, requests, finish, published } = watching(t);
  reader.atRevision("old");
  await finish(0, "new");
  assert.equal(requests.length, 2);
  await finish(1, "new");
  assert.deepEqual(published, []);
  assert.equal(requests.length, 2);
  reader.atRevision("new");
  assert.deepEqual(published, [{}]);
  assert.equal(requests.length, 3);
  await finish(2, "new");
});

test("focus, visibility and saves coalesce during a read and still refresh unchanged revisions", async (t) => {
  const { reader, requests, finish, win, doc } = watching(t);
  reader.atRevision("same");
  await finish(0, "same");
  win.dispatchEvent(new Event("focus"));
  changes.dispatchEvent(new Event("change"));
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(requests.length, 2);
  await finish(1, "same");
  assert.equal(requests.length, 3);
  await finish(2, "same");
  doc.hidden = true;
  win.dispatchEvent(new Event("focus"));
  changes.dispatchEvent(new Event("change"));
  assert.equal(requests.length, 3);
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(requests.length, 4);
  await finish(3, "same");
  reader.atRevision("new");
  assert.equal(requests.length, 5);
  await finish(4, "new");
});

test("stopping ignores an in-flight result and removes refresh listeners and the timer", async (t) => {
  const { reader, requests, finish, published, win, doc } = watching(t);
  reader.stop();
  await finish(0, "same");
  reader.atRevision("same");
  win.dispatchEvent(new Event("focus"));
  doc.dispatchEvent(new Event("visibilitychange"));
  changes.dispatchEvent(new Event("change"));
  t.mock.timers.tick(SYNC_EVERY);
  assert.equal(requests.length, 1);
  assert.deepEqual(published, []);
});

test("unsupported or unauthorized sync stops; transient failures can retry on first snapshot", async (t) => {
  for (const status of [404, 401, 0]) {
    await t.test(String(status), async (t) => {
      const { reader, requests, win } = watching(t);
      requests[0]!.reject(new ApiError(status, "failure", "failure"));
      await Promise.resolve();
      reader.atRevision("same");
      win.dispatchEvent(new Event("focus"));
      assert.equal(requests.length, status === 0 ? 2 : 1);
    });
  }
});

test("a snapshot disagrees with live flags once per disagreement", () => {
  const snapshot = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [{ id: "done", outputAt: "2026-10-09T00:00:00Z" }, { id: "plain" }],
    cards: [
      { id: "card-a", outputNodeIds: ["done"], reviewOutputNodeIds: [] },
      { id: "card-b", outputNodeIds: [], reviewOutputNodeIds: ["waiting"] },
    ],
  } as unknown as Snapshot;
  const behind = { behind: { reasons: ["Material changed: x"] } };
  assert.equal(snapshotDisagrees(snapshot, UNREAD), null);
  // The snapshot's own view: "waiting" is behind, "done" is not.
  assert.equal(snapshotDisagrees(snapshot, { waiting: behind }), null);
  // A completed output fell behind outside Tent.
  assert.equal(snapshotDisagrees(snapshot, { waiting: behind, done: behind }), "r1:done,waiting");
  // An output awaiting review caught up again.
  assert.equal(snapshotDisagrees(snapshot, {}), "r1:");
});

test("a page left open follows a material change at the same revision, and back", async (t) => {
  const { reader, requests, finish, published, doc } = watching(t);
  const at = (nodes: SyncFlags) => published.at(-1) ?? nodes;
  const done = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [{ id: "out", outputAt: "2026-10-09T00:00:00Z" }],
    cards: [{ id: "card-a", outputNodeIds: ["out"], reviewOutputNodeIds: [] }],
  } as unknown as Snapshot;
  const review = {
    ...done,
    nodes: [{ id: "out" }],
    cards: [{ id: "card-a", outputNodeIds: [], reviewOutputNodeIds: ["out"] }],
  } as unknown as Snapshot;
  const rebuilt = [review, done];
  const fresh = t.mock.method(api, "freshSnapshot", async () => rebuilt.shift()!);
  let shown: Snapshot | null = done;
  const rebuild = snapshotRebuilder((update) => (shown = update(shown)));
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  reader.atRevision("r1");
  await finish(0, "r1");
  rebuild(shown, at({}));
  assert.equal(fresh.mock.callCount(), 0);

  // docs/req.md is edited outside Tent: the revision stays r1, and only the timer sees it.
  const behind = { out: { behind: { reasons: ["Material changed: docs/req.md"] } } };
  t.mock.timers.tick(SYNC_EVERY - 1);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 2);
  await finish(1, "r1", behind);
  rebuild(shown, at({}));
  await settle();
  assert.equal(fresh.mock.callCount(), 1);
  assert.equal(shown, review);
  // The rebuilt snapshot agrees with the flags, so nothing more is asked.
  rebuild(shown, at({}));
  assert.equal(fresh.mock.callCount(), 1);

  // A tick while a read is in flight does not queue another read behind it.
  t.mock.timers.tick(SYNC_EVERY);
  t.mock.timers.tick(SYNC_EVERY);
  assert.equal(requests.length, 3);
  // The original bytes return: the output awaiting review is in sync again.
  await finish(2, "r1");
  await settle();
  assert.equal(requests.length, 3);
  rebuild(shown, at({}));
  await settle();
  assert.equal(fresh.mock.callCount(), 2);
  assert.equal(shown, done);

  // A hidden page stops comparing materials.
  doc.hidden = true;
  t.mock.timers.tick(SYNC_EVERY);
  assert.equal(requests.length, 3);
});

test("a rebuilt snapshot is dropped when the revision moved meanwhile", async (t) => {
  const snapshot = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [{ id: "out", outputAt: "2026-10-09T00:00:00Z" }],
    cards: [{ id: "card-a", outputNodeIds: ["out"], reviewOutputNodeIds: [] }],
  } as unknown as Snapshot;
  const newer = { ...snapshot, workspace: { ...snapshot.workspace, revision: "r2" } };
  t.mock.method(api, "freshSnapshot", async () => snapshot);
  let shown: Snapshot | null = snapshot;
  const rebuild = snapshotRebuilder((update) => (shown = update(shown)));
  rebuild(snapshot, { out: { behind: { reasons: ["Material changed: x"] } } });
  shown = newer;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown, newer);
});
