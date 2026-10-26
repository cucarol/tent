import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type { Snapshot, SnapshotCard, SnapshotNode } from "../src/ui/data/types.js";
import {
  afterSave,
  emptyCanvas,
  foldOf,
  inverseOf,
  noPending,
  readCanvas,
  withPending,
  type CanvasFile,
} from "../src/ui/map/canvas.js";
import { selectionLines } from "../src/ui/map/relations.js";
import { selectionPath } from "../src/ui/map/geometry.js";

test("only the current canvas schema is read; old schemas fail without resetting", () => {
  assert.deepEqual(readCanvas(null), emptyCanvas());
  for (const value of [
    { version: 2, positions: {}, drawings: [] },
    { ...emptyCanvas(), regions: [] },
    { ...emptyCanvas(), positions: {} },
    { ...emptyCanvas(), open: ["a", "a"] },
    { ...emptyCanvas(), open: ["a"], shut: ["a"] },
    { ...emptyCanvas(), drawings: [{ id: "p", kind: "pen", node: null }] },
  ])
    assert.throws(() => readCanvas(value), /Invalid canvas structure/);
  const file = {
    ...emptyCanvas(),
    open: ["a"],
    shut: ["b"],
    drawings: [{ id: "p", kind: "pen", unknown: true }],
  };
  assert.deepEqual(readCanvas(file), file);
  assert.equal(foldOf(file, "b"), "shut");
  assert.equal(foldOf(file, "c"), null);
});

test("unsaved folds and drawings merge over external saves by id, with no region state", () => {
  const theirs: CanvasFile = {
    ...emptyCanvas(),
    open: ["a", "b"],
    shut: ["t"],
    drawings: [
      { id: "x", kind: "pen" },
      { id: "y", kind: "text", custom: true },
    ],
  };
  const mine = noPending();
  mine.folds.set("a", null).set("t", "open").set("c", "shut");
  mine.drawings
    .set("x", { id: "x", kind: "pen", points: [[1, 1]] })
    .set("z", { id: "z", kind: "pen" });
  const next = withPending(theirs, mine);
  assert.deepEqual(next.open, ["b", "t"]);
  assert.deepEqual(next.shut, ["c"]);
  assert.deepEqual(
    next.drawings.map((d) => d.id),
    ["x", "y", "z"],
  );
  assert.equal(next.drawings[1], theirs.drawings[1]);
  assert.deepEqual(Object.keys(next).sort(), ["drawings", "open", "shut", "version"]);
  assert.deepEqual(Object.keys(mine).sort(), ["drawings", "folds"]);
  assert.equal(withPending(theirs, noPending()), theirs);
});

test("a write clears only sent entries and keeps later changes", () => {
  const drawing = { id: "p", kind: "pen" };
  const sent = noPending();
  sent.drawings.set("p", drawing).set("q", { id: "q", kind: "pen" });
  sent.folds.set("a", "open");
  const now = noPending();
  now.drawings.set("p", drawing).set("q", { id: "q", kind: "pen", custom: true }).set("r", null);
  now.folds.set("a", "open").set("b", "shut");
  const left = afterSave(now, sent);
  assert.deepEqual([...left.drawings.keys()], ["q", "r"]);
  assert.deepEqual([...left.folds.keys()], ["b"]);
});

test("undo changes only touched folds and drawings, preserving external entries", () => {
  const file: CanvasFile = { ...emptyCanvas(), open: ["a"], drawings: [{ id: "p", kind: "pen" }] };
  const change = noPending();
  change.folds.set("a", null).set("b", "open");
  change.drawings.set("p", null).set("q", { id: "q", kind: "text" });
  const back = inverseOf(file, change);
  assert.deepEqual(
    [...back.folds],
    [
      ["a", "open"],
      ["b", null],
    ],
  );
  const remote = {
    ...file,
    shut: ["remote"],
    drawings: [...file.drawings, { id: "remote", kind: "pen" }],
  };
  const undone = withPending(withPending(remote, change), back);
  assert.deepEqual(undone.open, remote.open);
  assert.deepEqual(undone.shut, remote.shut);
  assert.deepEqual(
    [...undone.drawings].sort((a, b) => a.id.localeCompare(b.id)),
    remote.drawings,
  );
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

test("selection draws only relations Tent records between its topics", () => {
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
  const lines = selectionLines(graph, ["goal", "out", "rule", "code"], up, [
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
  assert.deepEqual(selectionLines(graph, ["code", "away"], up), []);
});

test("selected facts route orthogonally between Node boundaries and avoid other Node interiors", () => {
  const a = { x: 0, y: 0, w: 140, h: 30 },
    b = { x: 0, y: 70, w: 160, h: 25 };
  const onBoundary = (p: [number, number], r: typeof a) =>
    p[0] >= r.x &&
    p[0] <= r.x + r.w &&
    p[1] >= r.y &&
    p[1] <= r.y + r.h &&
    (p[0] === r.x || p[0] === r.x + r.w || p[1] === r.y || p[1] === r.y + r.h);
  for (const [target, obstacle] of [
    [b, { x: -10, y: 40, w: 190, h: 15 }],
    [
      { ...b, x: 240, y: 0 },
      { x: 170, y: -10, w: 40, h: 60 },
    ],
  ]) {
    const route = selectionPath(a, target!, "link", [a, target!, obstacle!], 1, 80);
    assert.match(route.path, /^M/);
    assert.ok(route.path.includes("L"));
    assert.doesNotMatch(route.path, /[CQ]/);
    assert.ok(onBoundary(route.points[0]!, a));
    assert.ok(onBoundary(route.points.at(-1)!, target!));
    for (let i = 1; i < route.points.length; i++) {
      const p = route.points[i - 1]!,
        q = route.points[i]!,
        r = obstacle!;
      assert.ok(p[0] === q[0] || p[1] === q[1], "each route segment is orthogonal");
      const crossing =
        p[1] === q[1]
          ? p[1] > r.y &&
            p[1] < r.y + r.h &&
            Math.max(p[0], q[0]) > r.x &&
            Math.min(p[0], q[0]) < r.x + r.w
          : p[0] > r.x &&
            p[0] < r.x + r.w &&
            Math.max(p[1], q[1]) > r.y &&
            Math.min(p[1], q[1]) < r.y + r.h;
      assert.equal(crossing, false);
    }
  }
});
