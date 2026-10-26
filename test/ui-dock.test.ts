import assert from "node:assert/strict";
import test from "node:test";
import { carried, deskOf, inQueue, moodOf, placeIn, treeAccepts } from "../src/ui/shell/work.js";
import type { Graph } from "../src/ui/data/store.js";
import type { SnapshotCard } from "../src/ui/data/types.js";

const card = (id: string, fields: Partial<SnapshotCard>) =>
  ({
    id,
    state: "consumed",
    status: "stable",
    receivedBy: "role-a",
    target: "role-a",
    sources: [{ kind: "node", id: `node-${id}` }],
    ...fields,
  }) as unknown as SnapshotCard;
const laneOf = (c: SnapshotCard) => c.receivedBy ?? c.target ?? "";

test("a map selection can move through the sidebar, with the same cycle and no-op checks", () => {
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", null],
    ["child", "a"],
    ["deep", "child"],
  ]);
  const graph = {
    nodes: new Map([...parents].map(([id, parentId]) => [id, { id, parentId }])),
    ancestors: (id: string) => {
      const out = [];
      for (let parent = parents.get(id); parent; parent = parents.get(parent))
        out.push({ id: parent });
      return out;
    },
  } as unknown as Graph;
  const item = { kind: "node", id: "a", from: "map" } as const;
  assert.equal(treeAccepts(graph, item, "b", "inside"), true);
  assert.equal(treeAccepts(graph, item, "a", "inside"), false);
  assert.equal(treeAccepts(graph, item, "deep", "inside"), false);
  assert.equal(treeAccepts(graph, { ...item, id: "child" }, "a", "inside"), false);
  assert.equal(treeAccepts(graph, { ...item, ids: ["a", "b"] }, "deep", "before"), false);
});

test("a Card sits on the desk that has to act on it, and leaves every desk once it is done", () => {
  assert.equal(deskOf(card("w", { state: "pending", receivedBy: null }), laneOf), "role-a");
  // To be returned: with its receiver while being done, then with the Role it returns to.
  assert.equal(deskOf(card("d", { returnTo: "role-b" }), laneOf), "role-a");
  assert.equal(deskOf(card("r", { state: "returned", returnTo: "role-b" }), laneOf), "role-b");
  assert.equal(deskOf(card("c", { state: "closed", returnTo: "role-b" }), laneOf), null);
  // Received without a return: receiving finished it.
  assert.equal(deskOf(card("n", {}), laneOf), null);
  assert.equal(deskOf(card("x", { state: "pending", status: "deprecated" }), laneOf), null);
});

test("lighting a robot marks only what the Cards on its desk carry", () => {
  const cards = [
    card("d", { returnTo: "role-b" }),
    card("f", {}),
    card("o", { returnTo: "role-a", receivedBy: "role-b", target: "role-b" }),
    card("r", { state: "returned", returnTo: "role-b" }),
  ];
  const graph = { snapshot: { cards } } as unknown as Graph;
  assert.deepEqual([...carried(graph, laneOf, "role-a")], ["node-d"]);
  assert.deepEqual([...carried(graph, laneOf, "role-b")], ["node-o", "node-r"]);
});

test("a robot shows doing while it holds a Card to return, waiting for Cards to take or results to collect", () => {
  const desk = (doing: number, waiting: number, returned = 0) => ({
    doing,
    waiting,
    returned,
    drafts: 0,
  });
  assert.equal(moodOf(desk(1, 2), false), "doing");
  assert.equal(moodOf(desk(0, 2), false), "waiting");
  assert.equal(moodOf(desk(0, 0, 1), false), "waiting");
  assert.equal(moodOf(desk(0, 0), false), undefined);
  assert.equal(moodOf(desk(1, 0), true), "gone");
});

test("waiting Cards line up by Core's key, oldest first, and a place just chosen shows at once", () => {
  const pub = (id: string, publishedAt: string, orderKey?: string) =>
    card(id, { state: "pending", receivedBy: null, publishedAt, orderKey });
  const a = pub("card-a", "2026-10-17T01:00:00.000Z");
  const b = pub("card-b", "2026-10-17T02:00:00.000Z");
  // Moved to the end: the last key with its own id joined on, before anything published later.
  const c = pub("card-c", "2026-10-17T00:00:00.000Z", "2026-10-17T02:00:00.000Z|card-b~card-c");
  const d = pub("card-d", "2026-10-17T03:00:00.000Z");
  const ids = (cards: SnapshotCard[]) => cards.map((x) => x.id);
  assert.deepEqual(ids(inQueue([d, c, b, a], new Map())), ["card-a", "card-b", "card-c", "card-d"]);
  assert.deepEqual(
    ids(inQueue([d, c, b, a], new Map([["card-d", { ref: "card-a", side: "before" }]]))),
    ["card-d", "card-a", "card-b", "card-c"],
  );
});

test("a Card let go next to another takes that place, and next to itself changes nothing", () => {
  const q = ["card-a", "card-b", "card-c"];
  assert.equal(placeIn(q, "card-c", { ref: "card-a", side: "before" }), 1);
  assert.equal(placeIn(q, "card-a", { ref: "card-c", side: "after" }), 3);
  assert.equal(placeIn(q, "card-a", { ref: "card-b", side: "before" }), null);
  assert.equal(placeIn(q, "card-b", { ref: "card-a", side: "after" }), null);
  assert.equal(placeIn(q, "card-b", { ref: "card-b", side: "after" }), null);
  // From another lane, before the second.
  assert.equal(placeIn(q, "card-x", { ref: "card-b", side: "before" }), 2);
});
