import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type { Snapshot, SnapshotCard, SnapshotNode } from "../src/ui/data/types.js";
import {
  afterSave,
  clearOf,
  clearWithin,
  snapTo,
  CLEAR,
  emptyCanvas,
  fitBox,
  heldBy,
  membersOf,
  noPending,
  readCanvas,
  regionOf,
  standClear,
  withPending,
  REGION_PAD,
  type CanvasFile,
  type Region,
} from "../src/ui/map/canvas.js";
import type { Layout, Placed } from "../src/ui/map/layout.js";
import { reachOut, regionLines } from "../src/ui/map/regions.js";
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
      node("out", "goal", {
        type: "output",
        materials: [{ kind: "card", id: "card-1", resource: "/cards/card-1.md", field: "sources" }],
      }),
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
  // One layer out from goal and out: only cards outside related to a member, never two outside ones.
  const reach = reachOut(graph, ["goal", "out"], ["rule", "code", "away", "out"], up);
  assert.deepEqual([...reach].map(([id, l]) => `${id}:${l.map((x) => x.kind).sort()}`).sort(), [
    "rule:card,link,material",
  ]);
  assert.deepEqual(
    reachOut(graph, ["away"], ["goal", "out", "code"], up, [
      { from: "code", to: "away", imports: 1 },
    ])
      .get("code")
      ?.map((l) => l.kind),
    ["code"],
  );
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

test("a card dropped on others moves itself the least way clear of them; the others stay", () => {
  const card = (x: number, y: number) => ({ x, y, w: 296, h: 44 });
  const others = [card(0, 0), card(0, 60), card(0, 120)];
  // Dropped onto empty map: it stays where it was let go.
  assert.deepEqual(clearOf([card(600, 0)], others), [0, 0]);
  // Dropped a little over the top card's right edge: it steps right, just clear of it.
  assert.deepEqual(clearOf([card(270, 2)], others), [296 + CLEAR - 270, 0]);
  // Dropped over the middle of the column: out to whichever side is nearest.
  const [dx, dy] = clearOf([card(20, 62)], others);
  assert.ok(dx === 0 || dy === 0);
  const moved = { ...card(20 + dx, 62 + dy) };
  for (const o of others)
    assert.ok(
      moved.x >= o.x + o.w ||
        moved.x + moved.w <= o.x ||
        moved.y >= o.y + o.h ||
        moved.y + moved.h <= o.y,
    );
  // Two cards dropped together move together.
  const pair = clearOf([card(10, 10), card(10, 70)], others);
  assert.equal(typeof pair[0], "number");
  assert.ok(pair[0] !== 0 || pair[1] !== 0);
});

test("a card dropped in sight steps aside within it, and only says so when there is room", () => {
  const card = (x: number, y: number) => ({ x, y, w: 296, h: 44 });
  const others = [card(0, 0), card(0, 60), card(0, 120)];
  // Room on the left only: it goes left, though right is as near.
  const sight = { x: -400, y: -20, w: 720, h: 200 };
  const [dx, dy] = clearWithin([card(20, 62)], others, sight)!;
  const moved = card(20 + dx, 62 + dy);
  assert.ok(moved.x >= sight.x && moved.x + moved.w <= sight.x + sight.w, "inside sideways");
  assert.ok(moved.y >= sight.y && moved.y + moved.h <= sight.y + sight.h, "inside up and down");
  assert.ok(moved.x + moved.w <= 0, "clear of the column");
  // No room in sight at all.
  assert.equal(clearWithin([card(20, 62)], others, { x: -10, y: -10, w: 316, h: 184 }), null);
});

test("a dragged card lines up with the left edge and the row of the cards near it", () => {
  const card = (x: number, y: number) => ({ x, y, w: 296, h: 44 });
  assert.deepEqual(snapTo(card(5, 300), [card(0, 0)], 8), [-5, 0]);
  assert.deepEqual(snapTo(card(500, 4), [card(0, 0)], 8), [0, -4]);
  assert.deepEqual(snapTo(card(20, 300), [card(0, 0)], 8), [0, 0]);
  // A card far down another column is not one column with it.
  assert.deepEqual(snapTo(card(3, 9000), [card(0, 0)], 8), [0, 0]);
});

test("nothing stands on anything: hand-placed cards are obstacles the laid-out ones make room round", () => {
  const meet = (a: Placed, b: Placed) => {
    const p = { x: a.x, y: a.y - a.h / 2, w: a.w, h: a.h },
      q = { x: b.x, y: b.y - b.h / 2, w: b.w, h: b.h };
    return p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
  };
  const clear = (l: Layout) => {
    const all = [...l.placed.values()];
    return all.every((a, i) => all.slice(i + 1).every((b) => !meet(a, b)));
  };
  // A column of laid-out cards, and a card kept by hand over its second row.
  const tree = layoutOf(card("a", 0, 0), card("b", 0, 60), card("c", 0, 120), card("h", 40, 70));
  const stood = standClear(tree, new Set(["h"]));
  assert.ok(clear(stood));
  // The kept card holds its place; the cards from the first one it meets down move below it, in order.
  assert.deepEqual(stood.placed.get("h"), tree.placed.get("h"));
  assert.deepEqual(stood.placed.get("a"), tree.placed.get("a"));
  assert.ok(stood.placed.get("b")!.y > stood.placed.get("h")!.y);
  assert.equal(stood.placed.get("c")!.y - stood.placed.get("b")!.y, 60);
  // Two kept cards on each other: the later one steps clear, with what it carries.
  const pair: Layout = {
    ...layoutOf(card("p", 0, 0), card("q", 10, 10), card("q1", 400, 10)),
    islands: new Map([["q", ["q1"]]]),
  };
  const apart = standClear(pair, new Set(["p", "q"]));
  assert.ok(clear(apart));
  const step = (l: Layout) => l.placed.get("q1")!.x - l.placed.get("q")!.x;
  assert.equal(step(apart), step(pair));
  // A card dropped on its own among a tree's cards moves only itself; the tree it lands in stays.
  const grove: Layout = {
    ...layoutOf(card("t", 0, 0), card("t1", 400, -60), card("t2", 400, 60), card("d", 410, 70)),
    islands: new Map([["t", ["t1", "t2"]]]),
  };
  const landed = standClear(grove, new Set(["t", "d"]));
  assert.ok(clear(landed));
  for (const id of ["t", "t1", "t2"]) assert.deepEqual(landed.placed.get(id), grove.placed.get(id));
  // Nothing kept by hand: the layout stands as it was.
  assert.equal(standClear(tree, new Set()), tree);
});
