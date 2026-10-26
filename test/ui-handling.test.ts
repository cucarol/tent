import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeCardSummary } from "../src/core/read/node-details-types.js";
import {
  handlingFromNodeCards,
  handlingOf,
  handlingOnTopics,
  handsOf,
} from "../src/ui/data/handling.js";
import type { SnapshotCard } from "../src/ui/data/types.js";

const card = (id: string, over: Partial<SnapshotCard>): SnapshotCard => ({
  id,
  title: id,
  state: "pending",
  target: null,
  receivedBy: null,
  status: "active",
  body: "",
  sources: [],
  path: `.tent/cards/${id}.md`,
  history: [],
  publishedAt: null,
  updatedAt: null,
  ...over,
});
const from = (...ids: string[]) =>
  ids.map((id) => ({ id, resource: id }) as SnapshotCard["sources"][number]);
const laneOf = (c: SnapshotCard) => c.receivedBy ?? c.target ?? "";
const isNode = (id: string) => id.startsWith("node-");

test("a Node lists the Cards waiting for it and those being done, never returned, received or withdrawn ones", () => {
  const map = handlingOf(
    [
      card("card-wait", { target: "role-lab", sources: from("node-a", "role-x") }),
      card("card-open", { sources: from("node-a") }),
      card("card-doing", {
        state: "consumed",
        returnTo: "role-judge",
        receivedBy: "role-main",
        sources: from("node-a", "node-a"),
      }),
      card("card-back", {
        state: "returned",
        returnTo: "role-judge",
        receivedBy: "role-main",
        sources: from("node-a"),
      }),
      card("card-taken", { state: "consumed", receivedBy: "role-main", sources: from("node-a") }),
      card("card-gone", { status: "deprecated", target: "role-lab", sources: from("node-a") }),
    ],
    laneOf,
    isNode,
  );
  assert.deepEqual([...map.keys()], ["node-a"]);
  assert.deepEqual(
    map.get("node-a")!.map((h) => [h.card.id, h.lane, h.doing]),
    [
      ["card-doing", "role-main", true],
      ["card-wait", "role-lab", false],
      ["card-open", "", false],
    ],
  );
});

test("faces show each lane once, a Role doing any of the Cards as doing", () => {
  const map = handlingOf(
    [
      card("c1", { target: "role-main", sources: from("node-a") }),
      card("c2", {
        state: "consumed",
        returnTo: "role-judge",
        receivedBy: "role-main",
        sources: from("node-a"),
      }),
      card("c3", { target: "role-lab", sources: from("node-a") }),
      card("c4", { target: "role-lab", sources: from("node-a") }),
      card("c5", { sources: from("node-a") }),
    ],
    laneOf,
    isNode,
  );
  assert.deepEqual(handsOf(map.get("node-a")!), {
    doing: ["role-main"],
    waiting: ["role-lab", ""],
  });
});

test("a Node page names who is on it from its own Cards before the page has the Card list", () => {
  const item = (id: string, over: Partial<NodeCardSummary>): NodeCardSummary => ({
    id,
    title: id,
    state: "pending",
    status: "stable",
    target: null,
    receivedBy: null,
    publishedAt: "2026-10-23T00:00:00.000Z",
    sources: [],
    lane: { id: null, title: null },
    ...over,
  });
  assert.deepEqual(
    handlingFromNodeCards([
      item("c-wait", { target: "role-lab", lane: { id: "role-lab", title: "lab" } }),
      item("c-doing", {
        state: "consumed",
        returnTo: "role-judge",
        target: "role-main",
        receivedBy: "role-main",
        lane: { id: "role-main", title: "main" },
      }),
      item("c-done", { state: "returned", returnTo: "role-judge", receivedBy: "role-main" }),
      item("c-gone", { status: "deprecated", target: "role-lab" }),
    ]).map((h) => [h.card.id, h.lane, h.doing, h.who]),
    [
      ["c-doing", "role-main", true, "main"],
      ["c-wait", "role-lab", false, "lab"],
    ],
  );
});

test("faces follow named ancestors in a distant or folded view and omit future replay topics", () => {
  const cards = [
    card("c-shared", { target: "role-main", sources: from("node-a", "node-b") }),
    card("c-doing", {
      state: "consumed",
      returnTo: "role-ui",
      receivedBy: "role-lab",
      sources: from("node-b"),
    }),
    card("c-future", { target: "role-main", sources: from("node-future") }),
  ];
  const handling = handlingOf(cards, laneOf, isNode);
  const upOf = (id: string) => (id === "node-parent" ? null : "node-parent");
  const exists = (id: string) => id !== "node-future";
  const distant = handlingOnTopics(handling, upOf, (id) => id === "node-parent", exists);
  assert.deepEqual([...distant.keys()], ["node-parent"]);
  assert.deepEqual(
    distant.get("node-parent")!.map((h) => h.card.id),
    ["c-doing", "c-shared"],
  );
  const close = handlingOnTopics(handling, upOf, () => true, exists);
  assert.deepEqual([...close.keys()], ["node-a", "node-b"]);
  assert.equal(close.get("node-a")![0]!.card.id, "c-shared");
  assert.equal(handlingOnTopics(handling, upOf, () => false, exists).size, 0);
});
