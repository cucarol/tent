import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type { Snapshot, SnapshotIncoming, SnapshotNode } from "../src/ui/data/types.js";
import { focusOf, placeMarks } from "../src/ui/map/focus.js";

function node(
  id: string,
  parentId: string | null,
  extra: Partial<SnapshotNode> = {},
): SnapshotNode {
  return {
    id,
    name: id,
    path: id,
    notePath: `${id}/${id}.md`,
    depth: 0,
    type: "prompt",
    tags: [],
    status: "stable",
    archived: false,
    description: "",
    body: "",
    parentId,
    childIds: [],
    links: [],
    materials: [],
    incoming: [],
    history: [],
    ...extra,
  };
}
const cites = (id: string): SnapshotIncoming => ({ from: { kind: "node", id }, via: "link" });

function graphOf(nodes: SnapshotNode[]) {
  for (const n of nodes) n.childIds = nodes.filter((c) => c.parentId === n.id).map((c) => c.id);
  const snapshot: Snapshot = {
    workspace: { id: "ws-test", name: "test", revision: "r0", generatedAt: "" },
    nodes,
    roles: [],
    cards: [],
    commits: [],
    paths: Object.fromEntries(nodes.map((n) => [n.notePath, { kind: "node" as const, id: n.id }])),
  };
  return buildGraph(snapshot);
}

test("a topic in focus marks what it cites and what cites it, and counts the hidden ones on their holder", () => {
  const graph = graphOf([
    node("up", null),
    node("focus", "up", {
      links: [{ label: "a", href: "a.md", ref: { kind: "node", id: "a" } }],
      incoming: [cites("b"), cites("deep"), cites("gone"), cites("kid")],
    }),
    node("kid", "focus"),
    node("a", null),
    node("b", null, { links: [{ label: "f", href: "f.md", ref: { kind: "node", id: "focus" } }] }),
    node("closed", null),
    node("deep", "closed"),
    node("gone", null),
  ]);
  const onMap = (id: string) => !["deep", "gone"].includes(id);
  const counted = (id: string) => id !== "gone";
  const { lit, near } = focusOf(graph, "focus", onMap, counted);
  // Both ways at once read as one mark; the folded one is counted on the topic that holds it.
  assert.deepEqual(
    [...near].sort(([x], [y]) => x.localeCompare(y)),
    [
      ["a", "citedByIt"],
      ["b", "citesIt"],
      ["closed", { inside: 1 }],
    ],
  );
  // Parent and children are lit, not marked: the tree shows them. An archived citer is left out.
  assert.deepEqual([...lit].sort(), ["a", "b", "closed", "focus", "kid", "up"]);
});

test("a mark goes past the far end when clear, before the near end when a line is there, else nowhere", () => {
  const row = { x: 100, y: 0, w: 80, h: 20 };
  const ask = { id: "t", at: { x: 100, y: 0 }, row, side: 1 as const, w: 50, h: 18 };
  assert.deepEqual(placeMarks([ask], [], []).get("t"), { dx: 86, dy: 1 });
  // A line leaving the far end for the children.
  const out = {
    points: [
      [180, 10],
      [220, 10],
      [220, 10],
      [260, 10],
    ] as [number, number][],
  };
  assert.deepEqual(placeMarks([ask], [], [out]).get("t"), { dx: -56, dy: 1 });
  // And a topic before it: no room on either side, so no mark.
  const before = { x: 30, y: 0, w: 60, h: 20 };
  assert.equal(placeMarks([ask], [before], [out]).has("t"), false);
});
