import assert from "node:assert/strict";
import test from "node:test";
import { carried, moodOf, onDesk } from "../src/ui/shell/work.js";
import type { Graph } from "../src/ui/data/store.js";
import type { SnapshotCard } from "../src/ui/data/types.js";

const card = (id: string, fields: Partial<SnapshotCard>) =>
  ({
    id,
    state: "consumed",
    status: "stable",
    progress: null,
    receivedBy: "role-a",
    target: "role-a",
    sources: [{ kind: "node", id: `node-${id}` }],
    ...fields,
  }) as unknown as SnapshotCard;

test("a robot's desk holds Cards waiting, in progress or awaiting review, not finished or withdrawn ones", () => {
  assert.equal(onDesk(card("w", { state: "pending", receivedBy: null })), true);
  assert.equal(onDesk(card("d", { progress: "received-no-output" })), true);
  assert.equal(onDesk(card("r", { progress: "needs-review" })), true);
  assert.equal(onDesk(card("f", { progress: "has-output" })), false);
  assert.equal(onDesk(card("x", { state: "pending", status: "deprecated" })), false);
  // Received with no goal pinned: Tent cannot say it is still open, so it is not counted as held.
  assert.equal(onDesk(card("n", { progress: null })), false);
});

test("lighting a robot marks only what the Cards on its desk carry", () => {
  const cards = [
    card("d", { progress: "received-no-output" }),
    card("f", { progress: "has-output" }),
    card("o", { progress: "received-no-output", receivedBy: "role-b", target: "role-b" }),
  ];
  const graph = { snapshot: { cards } } as unknown as Graph;
  const laneOf = (c: SnapshotCard) => c.receivedBy ?? c.target ?? "";
  assert.deepEqual([...carried(graph, laneOf, "role-a")], ["node-d"]);
  assert.deepEqual([...carried(graph, laneOf, "role-b")], ["node-o"]);
});

test("a robot shows doing while it holds a received Card, waiting when only Cards to take are left", () => {
  const desk = (doing: number, waiting: number) => ({ doing, waiting, review: 0, drafts: 0 });
  assert.equal(moodOf(desk(1, 2), false), "doing");
  assert.equal(moodOf(desk(0, 2), false), "waiting");
  assert.equal(moodOf(desk(0, 0), false), undefined);
  assert.equal(moodOf(desk(1, 0), true), "gone");
});
