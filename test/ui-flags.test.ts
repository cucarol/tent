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

const goal = (id: string, status = "stable") => ({ id, type: "goal", status, archived: false });
const pin = (...ids: string[]) => ids.map((id) => ({ kind: "node", id, resource: id }));
const ahead = { ahead: { reasons: ["Goal changed since its outputs were confirmed"] } };

test("a snapshot disagrees with live flags once per disagreement", () => {
  const snapshot = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [
      goal("goal-a"),
      goal("goal-b"),
      goal("goal-old", "deprecated"),
      // Each output stands under the goal its Card counts it for, as Core requires.
      { id: "done", type: "output", parentId: "goal-a", outputAt: "2026-10-09T00:00:00Z" },
      { id: "waiting", type: "output", parentId: "goal-b" },
    ],
    cards: [
      {
        id: "card-a",
        sources: pin("goal-a"),
        totalGoalCount: 1,
        goalCount: 1,
        outputNodeIds: ["done"],
      },
      {
        id: "card-b",
        sources: pin("goal-b", "goal-old"),
        totalGoalCount: 1,
        goalCount: 0,
        outputNodeIds: [],
        reviewGoalCount: 1,
        reviewOutputNodeIds: ["waiting"],
      },
    ],
  } as unknown as Snapshot;
  const expired = { behind: { reasons: ["Expired"] } };
  assert.equal(snapshotDisagrees(snapshot, UNREAD), null);
  // The snapshot's own view: "goal-b" changed after its outputs, so card-b awaits review.
  assert.equal(snapshotDisagrees(snapshot, { "goal-b": ahead }), null);
  // A deprecated goal is outside the count, and output drift alone does not move Card progress.
  assert.equal(
    snapshotDisagrees(snapshot, { "goal-b": ahead, "goal-old": ahead, waiting: expired }),
    null,
  );
  // A goal card-a counted changed outside Tent.
  assert.equal(
    snapshotDisagrees(snapshot, { "goal-a": ahead, "goal-b": ahead }),
    "r1:goal-a+,goal-b+",
  );
  // The goal awaiting review caught up again.
  assert.equal(snapshotDisagrees(snapshot, {}), "r1:");
  // An output with a completion time passed its stale_after.
  assert.equal(snapshotDisagrees(snapshot, { "goal-b": ahead, done: expired }), "r1:done-,goal-b+");
});

test("each goal above a Card's outputs is checked by itself, not hidden behind another goal's count", () => {
  const under = (id: string, parentId: string) => ({ id, type: "output", parentId });
  const card = (fields: Record<string, unknown>) =>
    ({
      workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
      nodes: [
        goal("goal-a"),
        goal("goal-b"),
        under("out-a", "goal-a"),
        under("out-b", "goal-b"),
        { ...goal("goal-inner"), parentId: "goal-b" },
        under("out-inner", "goal-inner"),
      ],
      cards: [{ id: "card", totalGoalCount: 2, outputNodeIds: [], ...fields }],
    }) as unknown as Snapshot;

  // goal-a counted; goal-b still owes the Card an output.
  const partly = card({
    sources: pin("goal-a", "goal-b"),
    goalCount: 1,
    outputNodeIds: ["out-a"],
  });
  assert.equal(snapshotDisagrees(partly, { "goal-b": ahead }), null);
  // Review F1: goal-a's material changed. One ahead against one owed balances the counts, but the
  // counted goal is the one that moved.
  assert.equal(snapshotDisagrees(partly, { "goal-a": ahead }), "r1:goal-a+");
  assert.equal(
    snapshotDisagrees(partly, { "goal-a": ahead, "goal-b": ahead }),
    "r1:goal-a+,goal-b+",
  );

  // goal-a awaits review, goal-b owes an output: both ahead, as the snapshot says.
  const reviewing = card({
    sources: pin("goal-a", "goal-b"),
    goalCount: 0,
    reviewGoalCount: 1,
    reviewOutputNodeIds: ["out-a"],
  });
  assert.equal(snapshotDisagrees(reviewing, { "goal-a": ahead, "goal-b": ahead }), null);
  // The two swap with the same count: goal-a caught up, goal-b is ahead.
  assert.equal(snapshotDisagrees(reviewing, { "goal-b": ahead }), "r1:goal-b+");

  // One output under two pinned goals, counted for the inner one and awaiting review for the outer.
  const nested = card({
    sources: pin("goal-b", "goal-inner"),
    goalCount: 1,
    outputNodeIds: ["out-inner"],
    reviewGoalCount: 1,
    reviewOutputNodeIds: ["out-inner"],
  });
  assert.equal(snapshotDisagrees(nested, { "goal-b": ahead }), null);
  assert.equal(snapshotDisagrees(nested, {}), "r1:");
  assert.equal(
    snapshotDisagrees(nested, { "goal-b": ahead, "goal-inner": ahead }),
    "r1:goal-b+,goal-inner+",
  );
});

test("a shared answer under nested goals, beside a third goal not answered, follows each goal", () => {
  // Review's case on a7: A holds B, B holds O, which answers the Card; C has an output that does not.
  // The Card pins A, B and C.
  const snapshot = (fields: Record<string, unknown>) =>
    ({
      workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
      nodes: [
        goal("A"),
        { ...goal("B"), parentId: "A" },
        goal("C"),
        { id: "O", type: "output", parentId: "B" },
        { id: "OC", type: "output", parentId: "C" },
      ],
      cards: [{ id: "card", sources: pin("A", "B", "C"), totalGoalCount: 3, ...fields }],
    }) as unknown as Snapshot;
  // Built while only B was ahead: A counted through O, B awaits review on the same O.
  const bAhead = snapshot({
    goalCount: 1,
    outputNodeIds: ["O"],
    reviewGoalCount: 1,
    reviewOutputNodeIds: ["O"],
  });
  assert.equal(snapshotDisagrees(bAhead, { B: ahead }), null);
  // C owes no answer, so its own change moves nothing.
  assert.equal(snapshotDisagrees(bAhead, { B: ahead, C: ahead }), null);
  // A's material changes too: Core now has 0 counted, 2 under review and nothing in the counted list.
  assert.equal(snapshotDisagrees(bAhead, { A: ahead, B: ahead }), "r1:A+,B+");
  // B's material goes back: both A and B count O.
  assert.equal(snapshotDisagrees(bAhead, {}), "r1:");

  // The other way round: built with A and B ahead, then A's material goes back.
  const bothAhead = snapshot({
    goalCount: 0,
    outputNodeIds: [],
    reviewGoalCount: 2,
    reviewOutputNodeIds: ["O"],
  });
  assert.equal(snapshotDisagrees(bothAhead, { A: ahead, B: ahead }), null);
  assert.equal(snapshotDisagrees(bothAhead, { A: ahead, B: ahead, C: ahead }), null);
  assert.equal(snapshotDisagrees(bothAhead, { B: ahead }), "r1:B+");
  assert.equal(snapshotDisagrees(bothAhead, {}), "r1:");

  // All three count once C's output answers too, and nothing has changed since.
  const settled = snapshot({ goalCount: 3, outputNodeIds: ["O", "OC"] });
  assert.equal(snapshotDisagrees(settled, {}), null);
  assert.equal(snapshotDisagrees(settled, { C: ahead }), "r1:C+");
});

test("an answering output the snapshot does not hold leaves the Card to its totals", () => {
  const snapshot = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [goal("A"), goal("B")],
    cards: [
      {
        id: "card",
        sources: pin("A", "B"),
        totalGoalCount: 2,
        goalCount: 1,
        outputNodeIds: ["gone"],
      },
    ],
  } as unknown as Snapshot;
  assert.equal(snapshotDisagrees(snapshot, { B: ahead }), null);
  assert.equal(snapshotDisagrees(snapshot, { A: ahead, B: ahead }), "r1:A+,B+");
});

test("a page left open follows a goal material change at the same revision, and back", async (t) => {
  const { reader, requests, finish, published, doc } = watching(t);
  const at = (nodes: SyncFlags) => published.at(-1) ?? nodes;
  const done = {
    workspace: { id: "w", name: "w", revision: "r1", generatedAt: "" },
    nodes: [
      goal("req"),
      { id: "out", type: "output", parentId: "req", outputAt: "2026-10-09T00:00:00Z" },
    ],
    cards: [
      {
        id: "card-a",
        sources: pin("req"),
        totalGoalCount: 1,
        goalCount: 1,
        outputNodeIds: ["out"],
      },
    ],
  } as unknown as Snapshot;
  const review = {
    ...done,
    cards: [
      {
        id: "card-a",
        sources: pin("req"),
        totalGoalCount: 1,
        goalCount: 0,
        outputNodeIds: [],
        reviewGoalCount: 1,
        reviewOutputNodeIds: ["out"],
      },
    ],
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

  // The goal's docs/req.md is edited outside Tent: the revision stays r1, and only the timer sees it.
  t.mock.timers.tick(SYNC_EVERY - 1);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 2);
  await finish(1, "r1", { req: ahead });
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
  // The original bytes return: the goal is no longer ahead, so its response counts again.
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
    nodes: [
      goal("req"),
      { id: "out", type: "output", parentId: "req", outputAt: "2026-10-09T00:00:00Z" },
    ],
    cards: [
      {
        id: "card-a",
        sources: pin("req"),
        totalGoalCount: 1,
        goalCount: 1,
        outputNodeIds: ["out"],
      },
    ],
  } as unknown as Snapshot;
  const newer = { ...snapshot, workspace: { ...snapshot.workspace, revision: "r2" } };
  t.mock.method(api, "freshSnapshot", async () => snapshot);
  let shown: Snapshot | null = snapshot;
  const rebuild = snapshotRebuilder((update) => (shown = update(shown)));
  rebuild(snapshot, { req: ahead });
  shown = newer;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown, newer);
});
