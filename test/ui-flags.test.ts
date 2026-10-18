import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ApiError, api, changes } from "../src/ui/data/api.js";
import { aheadKind } from "../src/ui/data/reasons.js";
import { t } from "../src/ui/i18n.js";
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

const goal = (id: string, status = "stable") => ({ id, type: "goal", status, archived: false });
const pin = (...ids: string[]) => ids.map((id) => ({ kind: "node", id, resource: id }));
const ahead = { ahead: { reasons: ["Goal changed since its outputs were confirmed"] } };

test("a snapshot disagrees with live flags once per disagreement", () => {
  const snapshot = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [
      goal("goal-a"),
      { id: "done", type: "output", parentId: "goal-a", outputAt: "2026-10-09T00:00:00Z" },
      { id: "waiting", type: "output", parentId: "goal-a" },
    ],
    cards: [{ id: "card-a", state: "consumed", sources: pin("goal-a") }],
  } as unknown as Snapshot;
  const expired = { behind: { reasons: ["Expired"] } };
  assert.equal(snapshotDisagrees(snapshot, UNREAD), null);
  // Goals moving say nothing about Cards any more, and an output without a completion time has none to lose.
  assert.equal(snapshotDisagrees(snapshot, { "goal-a": ahead, waiting: expired }), null);
  // An output with a completion time passed its stale_after.
  assert.equal(snapshotDisagrees(snapshot, { "goal-a": ahead, done: expired }), "r1:done-,goal-a+");
  assert.equal(snapshotDisagrees(snapshot, { done: expired }), "r1:done-");
});

test("a page left open follows output expiry at the same revision", async (t) => {
  const { reader, requests, finish, published, doc } = watching(t);
  const at = (nodes: SyncFlags) => published.at(-1) ?? nodes;
  const done = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [
      goal("req"),
      { id: "out", type: "output", parentId: "req", outputAt: "2026-10-09T00:00:00Z" },
    ],
    cards: [],
  } as unknown as Snapshot;
  // Built again after the output expires: it has no completion time.
  const behind = {
    ...done,
    nodes: [goal("req"), { id: "out", type: "output", parentId: "req" }],
  } as unknown as Snapshot;
  const rebuilt = [behind];
  const fresh = t.mock.method(api, "freshSnapshot", async () => rebuilt.shift()!);
  let shown: Snapshot | null = done;
  const rebuild = snapshotRebuilder((update) => (shown = update(shown)));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const expired = { behind: { reasons: ["Expired"] } };

  reader.atRevision("r1");
  await finish(0, "r1");
  rebuild(shown, at({}));
  assert.equal(fresh.mock.callCount(), 0);

  // The output passes stale_after: the revision stays r1, and only the timer sees it.
  t.mock.timers.tick(SYNC_EVERY - 1);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 2);
  await finish(1, "r1", { out: expired });
  rebuild(shown, at({}));
  await settle();
  assert.equal(fresh.mock.callCount(), 1);
  assert.equal(shown, behind);
  // The rebuilt snapshot agrees with the flags, so nothing more is asked.
  rebuild(shown, at({}));
  assert.equal(fresh.mock.callCount(), 1);

  // A tick while a read is in flight does not queue another read behind it.
  t.mock.timers.tick(SYNC_EVERY);
  t.mock.timers.tick(SYNC_EVERY);
  assert.equal(requests.length, 3);
  await finish(2, "r1");
  await settle();
  assert.equal(requests.length, 3);

  // A hidden page stops checking sync flags.
  doc.hidden = true;
  t.mock.timers.tick(SYNC_EVERY);
  assert.equal(requests.length, 3);
});

test("a rebuilt snapshot is dropped when the revision moved meanwhile", async (t) => {
  const snapshot = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [
      goal("req"),
      { id: "out", type: "output", parentId: "req", outputAt: "2026-10-09T00:00:00Z" },
    ],
    cards: [],
  } as unknown as Snapshot;
  const newer = { ...snapshot, workspace: { ...snapshot.workspace, revision: "r2" } };
  let finish!: (snapshot: Snapshot) => void;
  const fresh = t.mock.method(
    api,
    "freshSnapshot",
    () => new Promise<Snapshot>((resolve) => (finish = resolve)),
  );
  let shown: Snapshot | null = snapshot;
  const rebuild = snapshotRebuilder((update) => (shown = update(shown)));
  rebuild(snapshot, { out: { behind: { reasons: ["Expired"] } } });
  assert.equal(fresh.mock.callCount(), 1);
  assert.equal(shown, snapshot);
  shown = newer;
  finish(snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown, newer);
});

test("an ahead goal says whether nothing answers it, no output was confirmed, or the goal itself was not", () => {
  assert.equal(aheadKind(["Goal subtree has no current output Node"]), "empty");
  assert.equal(
    aheadKind([
      "No output under this goal was saved or confirmed against its current content and materials",
    ]),
    "unmatched",
  );
  assert.equal(
    aheadKind([
      "Neither confirmed goal intent nor a current output matches this goal's current content and material declarations",
    ]),
    "intent",
  );
  assert.equal(aheadKind([]), "empty");
  // Each kind reads differently, and the goal's own kind never says it has no output.
  const kinds = ["empty", "unmatched", "intent"] as const;
  assert.equal(new Set(kinds.map((k) => t.map.aheadWhy(null, k))).size, 3);
  assert.equal(new Set(kinds.map((k) => t.map.aheadNext(k))).size, 3);
  assert.doesNotMatch(t.map.aheadWhy(null, "intent"), /还没有产出/);
});
