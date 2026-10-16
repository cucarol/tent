import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type { Snapshot, SnapshotCard, SnapshotNode } from "../src/ui/data/types.js";
import {
  afterSave,
  emptyCanvas,
  fitBox,
  heldBy,
  membersOf,
  noPending,
  readCanvas,
  regionOf,
  withPending,
  REGION_PAD,
  type CanvasFile,
  type Region,
} from "../src/ui/map/canvas.js";
import type { Layout, Placed } from "../src/ui/map/layout.js";
import { regionLines } from "../src/ui/map/regions.js";
import { regionPath } from "../src/ui/map/geometry.js";

const region = (id: string, box: Region["box"], name = ""): Region => ({ id, name, box });
const card = (id: string, x: number, top: number): Placed => ({
  id,
  x,
  y: top + 22,
  w: 296,
  h: 44,
});
const layoutOf = (...cards: Placed[]): Layout => ({
  placed: new Map(cards.map((c) => [c.id, c])),
  labels: [],
});

test("only this version of the canvas file is read; anything else reads as empty", () => {
  assert.deepEqual(readCanvas(null), emptyCanvas());
  assert.deepEqual(
    readCanvas({ version: 1, forms: {}, positions: {}, drawings: [] }),
    emptyCanvas(),
  );
  const file = readCanvas({
    version: 2,
    positions: { "node-aaaaaa": [10, 20], "node-bbbbbb": [1, "x"] },
    regions: [region("r1", [0, 0, 100, 80], "信号"), { id: "flat", name: "", box: [0, 0, 0, 10] }],
    drawings: [{ id: "p", kind: "pen", points: [[0, 0]] }, { kind: "pen" }],
  });
  assert.deepEqual(file.positions, { "node-aaaaaa": [10, 20] });
  assert.deepEqual(
    file.regions.map((r) => r.id),
    ["r1"],
  );
  assert.deepEqual(
    file.drawings.map((d) => d.id),
    ["p"],
  );
});

test("unsaved changes go over a file saved from elsewhere, entry by entry", () => {
  const theirs: CanvasFile = {
    version: 2,
    positions: { a: [0, 0], b: [5, 5] },
    regions: [region("r1", [0, 0, 100, 80], "theirs"), region("r2", [200, 0, 100, 80])],
    drawings: [
      { id: "x", kind: "pen" },
      { id: "y", kind: "text" },
    ],
  };
  const mine = noPending();
  mine.positions.set("a", [40, 40]).set("b", null).set("c", [9, 9]);
  mine.regions.set("r2", null).set("r3", region("r3", [0, 200, 50, 50]));
  mine.drawings
    .set("x", { id: "x", kind: "pen", points: [[1, 1]] })
    .set("z", { id: "z", kind: "pen" });
  const next = withPending(theirs, mine);
  // Their card "b" was put back here, "a" moved here, "c" is new; nothing else of theirs changes.
  assert.deepEqual(next.positions, { a: [40, 40], c: [9, 9] });
  assert.deepEqual(
    next.regions.map((r) => `${r.id}:${r.name}`),
    ["r1:theirs", "r3:"],
  );
  // A changed drawing keeps its place; a new one goes at the end.
  assert.deepEqual(
    next.drawings.map((d) => d.id),
    ["x", "y", "z"],
  );
  assert.equal(withPending(theirs, noPending()), theirs);
});

test("a write clears only what it carried; what changed again meanwhile still waits", () => {
  const sent = noPending();
  const moved: [number, number] = [1, 1];
  sent.positions.set("a", moved).set("b", [2, 2]);
  const now = noPending();
  now.positions.set("a", moved).set("b", [3, 3]).set("c", [4, 4]);
  const left = afterSave(now, sent);
  assert.deepEqual([...left.positions.keys()], ["b", "c"]);
});

test("a card belongs to the region its centre stands in; the last drawn wins", () => {
  const regions = [region("low", [0, 0, 1000, 1000]), region("high", [0, 0, 400, 200])];
  const laid = layoutOf(card("in-both", 20, 40), card("in-low", 500, 500), card("out", 2000, 0));
  const members = membersOf(regions, laid, () => true);
  assert.deepEqual(members.get("high"), ["in-both"]);
  assert.deepEqual(members.get("low"), ["in-low"]);
  assert.equal(regionOf(regions, { x: 2000, y: 0, w: 296, h: 44 }), null);
  // Cards the map does not show belong nowhere.
  assert.deepEqual(membersOf(regions, laid, (id) => id !== "in-low").get("low"), []);
});

test("a region holds its hidden cards too, by their kept corner, so moving or dissolving carries them", () => {
  const regions = [region("r", [0, 0, 1000, 400])];
  // "shown" is laid out; "hidden" (a type switched off or a folded branch) only has its kept corner.
  const laid = layoutOf(card("shown", 20, 40));
  const positions = {
    shown: [20, 40] as [number, number],
    hidden: [500, 200] as [number, number],
    away: [3000, 0] as [number, number],
  };
  assert.deepEqual(heldBy(regions, positions, laid).get("r"), ["shown", "hidden"]);
  // What the screen counts stays the shown cards only.
  assert.deepEqual(membersOf(regions, laid, (id) => id in positions).get("r"), ["shown"]);
  // A laid-out card is judged by where it stands, not by a stale kept corner.
  const moved = layoutOf({ ...card("shown", 2000, 40) });
  assert.deepEqual(heldBy(regions, positions, moved).get("r"), ["hidden"]);
});

test("a region grows to hold its cards with room round them, and never shrinks", () => {
  const a = { x: 0, y: 0, w: 296, h: 44 };
  const b = { x: 0, y: 60, w: 296, h: 44 };
  const box = fitBox(null, [a, b]);
  assert.deepEqual(box, [
    -REGION_PAD.side,
    -REGION_PAD.top,
    296 + 2 * REGION_PAD.side,
    104 + REGION_PAD.top + REGION_PAD.bottom,
  ]);
  const big: Region["box"] = [-500, -500, 2000, 2000];
  assert.deepEqual(fitBox(big, [a]), big);
});

function graphOf(nodes: SnapshotNode[], cards: SnapshotCard[] = []) {
  for (const n of nodes) n.childIds = nodes.filter((c) => c.parentId === n.id).map((c) => c.id);
  const snapshot = {
    workspace: { id: "ws", name: "ws", revision: "r", generatedAt: "" },
    nodes,
    roles: [],
    cards,
    commits: [],
    paths: {},
  } as unknown as Snapshot;
  return buildGraph(snapshot);
}
const node = (id: string, parentId: string | null, extra: Partial<SnapshotNode> = {}) =>
  ({
    id,
    name: id,
    path: id,
    notePath: `${id}/${id}.md`,
    type: "goal",
    tags: [],
    status: "stable",
    archived: false,
    body: "",
    parentId,
    childIds: [],
    links: [],
    materials: [],
    incoming: [],
    history: [],
    ...extra,
  }) as unknown as SnapshotNode;
const file = (path: string) => ({ kind: "file" as const, resource: path, workspacePath: path });

test("a region draws only relations Tent records between its own cards", () => {
  const graph = graphOf(
    [
      node("goal", null, { materials: [file("docs/SPEC.md")] }),
      node("out", "goal", { type: "output" }),
      node("rule", null, {
        materials: [file("docs/SPEC.md"), file("src/a.ts")],
        incoming: [{ from: { kind: "node", id: "out" }, via: "link" }],
      }),
      node("code", null, { materials: [file("src/a.ts")] }),
      node("away", null, { incoming: [{ from: { kind: "node", id: "rule" }, via: "link" }] }),
    ],
    [
      {
        id: "card-1",
        title: "验收",
        sources: [{ kind: "node", id: "rule", resource: "rule" }],
        outputNodeIds: ["out"],
      } as unknown as SnapshotCard,
    ],
  );
  const up = (id: string) => graph.nodes.get(id)?.parentId ?? null;
  const lines = regionLines(graph, ["goal", "out", "rule", "code"], up, [
    { from: "code", to: "rule", imports: 3 },
    { from: "code", to: "away", imports: 1 },
  ]);
  const said = lines.map((l) => `${l.kind}:${l.from}>${l.to}`).sort();
  assert.deepEqual(said, [
    "card:out>rule",
    "code:code>rule",
    "link:out>rule",
    "material:code>rule",
    "material:goal>rule",
    "parent:goal>out",
  ]);
  assert.deepEqual(lines.find((l) => l.kind === "material" && l.from === "goal")?.files, [
    "SPEC.md",
  ]);
  assert.equal(lines.find((l) => l.kind === "code")?.imports, 3);
  assert.deepEqual(lines.find((l) => l.kind === "card")?.cards, ["验收"]);
  // Cards with nothing between them draw nothing.
  assert.deepEqual(regionLines(graph, ["code", "away"], up), []);
});

test("lines between stacked cards stay in the region's margin: the tree's on the left, others right", () => {
  const a = { x: 0, y: 0, w: 296, h: 44 },
    b = { x: 0, y: 60, w: 296, h: 44 };
  const xs = (path: string) => [...path.matchAll(/[MHQ]\s*(-?[\d.]+)/g)].map((m) => +m[1]);
  const parent = regionPath(a, b, "parent");
  assert.ok(Math.min(...xs(parent.path)) >= -REGION_PAD.side, parent.path);
  assert.ok(Math.max(...xs(parent.path)) <= a.w, parent.path);
  for (const kind of ["link", "material", "code", "card"]) {
    const line = regionPath(a, b, kind);
    assert.ok(Math.max(...xs(line.path)) <= a.w + REGION_PAD.side, `${kind}: ${line.path}`);
    assert.ok(Math.min(...xs(line.path)) >= 0, `${kind}: ${line.path}`);
  }
  // Side by side, a line runs between their sides.
  assert.match(regionPath(a, { ...b, x: 400, y: 0 }, "link").path, /^M296,22 C/);
});
