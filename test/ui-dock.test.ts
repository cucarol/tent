import assert from "node:assert/strict";
import test from "node:test";
import { carried, deskOf, moodOf } from "../src/ui/shell/work.js";
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
