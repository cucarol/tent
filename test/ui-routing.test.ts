import assert from "node:assert/strict";
import test from "node:test";
import { arrange } from "../src/ui/map/arrange.js";
import { rectOf, type Rect } from "../src/ui/map/layout.js";
import { selectionPath } from "../src/ui/map/geometry.js";
import type { SnapshotNode } from "../src/ui/data/types.js";

type Point = [number, number];
function same(a: Rect, b: Rect) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
function crosses(p: Point, q: Point, r: Rect, pad = 0) {
  const epsilon = 1e-8,
    left = r.x - pad,
    right = r.x + r.w + pad,
    top = r.y - pad,
    bottom = r.y + r.h + pad;
  return p[1] === q[1]
    ? p[1] > top + epsilon &&
        p[1] < bottom - epsilon &&
        Math.max(p[0], q[0]) > left + epsilon &&
        Math.min(p[0], q[0]) < right - epsilon
    : p[0] > left + epsilon &&
        p[0] < right - epsilon &&
        Math.max(p[1], q[1]) > top + epsilon &&
        Math.min(p[1], q[1]) < bottom - epsilon;
}
function valid(a: Rect, b: Rect, obstacles: Rect[], zoom: number, width: number, clearance = 8) {
  const result = selectionPath(a, b, "link", obstacles, zoom, width);
  assert.equal(
    "blocked" in result,
    false,
    "routing does not expose the old warning/fallback state",
  );
  assert.ok(result.path && result.arrow && result.label && result.points.length >= 2);
  for (let i = 1; i < result.points.length; i++) {
    const p = result.points[i - 1]!,
      q = result.points[i]!;
    assert.ok(p[0] === q[0] || p[1] === q[1], "route segments stay orthogonal");
    for (const r of obstacles.filter((r) => !same(r, a) && !same(r, b)))
      assert.ok(
        !crosses(p, q, r, clearance),
        "segment enters another Node or the feasible layout clearance",
      );
  }
  const label = { x: result.label.x - width / 2 - 3, y: result.label.y - 10, w: width + 6, h: 20 };
  for (const r of obstacles)
    assert.ok(
      !(
        label.x < r.x + r.w &&
        label.x + label.w > r.x &&
        label.y < r.y + r.h &&
        label.y + label.h > r.y
      ),
      "full label outline must stay clear",
    );
  assert.ok(
    result.points.slice(1).some((q, i) => {
      const p = result.points[i]!;
      return (
        p[1] === result.label.y &&
        q[1] === result.label.y &&
        Math.min(p[0], q[0]) <= label.x &&
        Math.max(p[0], q[0]) >= label.x + label.w
      );
    }),
    "the full label width belongs to one clear horizontal route segment",
  );
  const onBoundary = (p: Point, r: Rect) =>
    p[0] >= r.x &&
    p[0] <= r.x + r.w &&
    p[1] >= r.y &&
    p[1] <= r.y + r.h &&
    (p[0] === r.x || p[0] === r.x + r.w || p[1] === r.y || p[1] === r.y + r.h);
  assert.ok(onBoundary(result.points[0]!, a));
  assert.ok(onBoundary(result.points.at(-1)!, b));
  return result;
}

test("the large adjacent-leaf relation keeps complete clearance and an external full-width label", () => {
  const rows = new Map<string | null, { id: string }[]>();
  const add = (parent: string | null, id: string, depth: number) => {
    rows.set(parent, [...(rows.get(parent) ?? []), { id }]);
    for (let i = 0; i < ([5, 4, 4][depth] ?? 0); i++) add(id, `${id}.${i}`, depth + 1);
  };
  for (let i = 0; i < 6; i++) add(null, `r${i}`, 0);
  const zoom = 0.8,
    scale = Math.max(1, 12 / (14 * zoom));
  const view = arrange({
    kidsOf: (id) => (rows.get(id) ?? []) as SnapshotNode[],
    closed: new Set(),
    open: new Set([...rows.keys()].filter((id): id is string => id !== null)),
    measure: (id, depth) => {
      const font = depth === 0 ? 18 * scale : depth === 1 ? 14 * scale : 12,
        hash = [...id].reduce((n, c) => n + c.charCodeAt(0), 0);
      return {
        w:
          depth === 0
            ? Math.ceil(176 * scale)
            : depth === 1
              ? Math.ceil(200 * scale)
              : 130 + (hash % 17) * 7,
        h: Math.max(
          depth === 0 ? 52 : depth === 1 ? 30 : 25,
          Math.ceil(font + (depth === 0 ? 18 : 8)),
        ),
      };
    },
  });
  assert.equal(view.placed.size, 636);
  const obstacles = [...view.placed.values()].map(rectOf),
    a = rectOf(view.placed.get("r0.2.1.1")!),
    b = rectOf(view.placed.get("r0.2.1.2")!);
  valid(a, b, obstacles, zoom, 180);
});

test("line interval queries preserve obstacle boundaries at different zooms", () => {
  const a = { x: 0, y: 0, w: 80, h: 30 },
    b = { x: 360, y: 100, w: 80, h: 30 };
  const obstacles = [
    a,
    b,
    { x: 110, y: -50, w: 55, h: 90 },
    { x: 180, y: 55, w: 90, h: 75 },
    { x: 280, y: -25, w: 45, h: 85 },
  ];
  for (const zoom of [0.4, 0.8, 2]) valid(a, b, obstacles, zoom, 150);
});

test("a later layout rebuilds its interval index instead of retaining old obstacle facts", () => {
  const a = { x: 0, y: 0, w: 100, h: 30 },
    b = { x: 500, y: 0, w: 100, h: 30 },
    obstacles = [a, b];
  const before = valid(a, b, obstacles, 1, 90);
  obstacles.push({ x: 250, y: -20, w: 100, h: 70 });
  assert.ok(before.points.slice(1).some((q, i) => crosses(before.points[i]!, q, obstacles[2]!, 8)));
  const after = valid(a, b, obstacles, 1, 90);
  assert.notEqual(after.path, before.path);
});

test("a feasible zigzag passage retains its relation when simple orthogonal offers are obstructed", () => {
  const a = { x: 0, y: 0, w: 60, h: 30 },
    b = { x: 400, y: 0, w: 60, h: 30 };
  const obstacles = [
    a,
    b,
    { x: -20, y: -40, w: 120, h: 20 },
    { x: -20, y: 50, w: 120, h: 20 },
    { x: -40, y: -40, w: 20, h: 110 },
    { x: 130, y: -30, w: 20, h: 90 },
  ];
  valid(a, b, obstacles, 1, 150);
});

function clearanceOf(points: Point[], obstacles: Rect[]) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++)
    for (const r of obstacles) {
      const p = points[i - 1]!,
        q = points[i]!;
      const dx = Math.max(r.x - Math.max(p[0], q[0]), Math.min(p[0], q[0]) - r.x - r.w, 0);
      const dy = Math.max(r.y - Math.max(p[1], q[1]), Math.min(p[1], q[1]) - r.y - r.h, 0);
      best = Math.min(best, Math.max(dx, dy));
    }
  return best;
}

test("the actual four-Node layout keeps one eight-unit route under every zoom", () => {
  const tree: Record<string, string[]> = { "": ["A"], A: ["A0", "A1", "A2"] };
  const view = arrange({
    kidsOf: (id) => (tree[id ?? ""] ?? []).map((id) => ({ id }) as SnapshotNode),
    closed: new Set(),
  });
  const obstacles = [...view.placed.values()].map(rectOf),
    before = JSON.stringify([...view.placed]);
  const a = rectOf(view.placed.get("A")!),
    b = rectOf(view.placed.get("A1")!);
  const routes = [0.26, 0.3, 0.4, 0.8, 1, 2].map((zoom) => valid(a, b, obstacles, zoom, 120));
  for (const route of routes)
    assert.deepEqual(
      route,
      routes[0],
      "zoom scales the route and arrow rather than reserving screen space",
    );
  assert.equal(JSON.stringify([...view.placed]), before, "routing never reserves layout channels");
});

test("the saved dense 23-Node layout no longer traps a relationship at small zoom", () => {
  const rows = new Map<string | null, { id: string }[]>();
  for (const root of ["r0", "r1"]) {
    rows.set(null, [...(rows.get(null) ?? []), { id: root }]);
    const kids = [0, 1, 2].map((i) => ({ id: `${root}.${i}` }));
    rows.set(root, kids);
    for (const kid of kids)
      rows.set(
        kid.id,
        [0, 1, 2].map((i) => ({ id: `${kid.id}.${i}` })),
      );
  }
  const scale = 12 / (14 * 0.4);
  const view = arrange({
    kidsOf: (id) => (rows.get(id) ?? []) as SnapshotNode[],
    closed: new Set(["r0.1"]),
    open: new Set([...rows.keys()].filter((id): id is string => id !== null)),
    measure: (_id, depth) => {
      const font = depth === 0 ? 18 * scale : depth === 1 ? 14 * scale : 12;
      return {
        w: depth === 0 ? Math.ceil(176 * scale) : depth === 1 ? Math.ceil(200 * scale) : 160,
        h: Math.max(
          depth === 0 ? 52 : depth === 1 ? 30 : 25,
          Math.ceil(font + (depth === 0 ? 18 : 8)),
        ),
      };
    },
  });
  assert.equal(view.placed.size, 23);
  const obstacles = [...view.placed.values()].map(rectOf),
    a = rectOf(view.placed.get("r0.1")!),
    b = rectOf(view.placed.get("r1.1")!);
  const route = valid(a, b, obstacles, 0.4, 120);
  assert.deepEqual(valid(a, b, obstacles, 1, 120), route);
});

test("a six-unit physical passage uses its greatest feasible three-unit clearance and retains a full label", () => {
  const a = { x: 0, y: 0, w: 40, h: 25 },
    b = { x: 180, y: 0, w: 40, h: 25 };
  const ring = [
    { x: -56, y: -50, w: 20, h: 106 },
    { x: 86, y: -50, w: 20, h: 106 },
    { x: -30, y: -76, w: 110, h: 20 },
    { x: -30, y: 62, w: 110, h: 20 },
  ];
  const result = valid(a, b, [a, b, ...ring], 0.3, 80, 3 - 0.01);
  const actual = clearanceOf(result.points, ring);
  assert.ok(
    actual >= 2.99 && actual <= 3.000001,
    `the physical six-unit bottleneck permits three units, got ${actual}`,
  );
  assert.deepEqual(valid(a, b, [a, b, ...ring], 1, 80, 3 - 0.01), result);
});

test("an unlabeled reference does not reserve a phantom label around its endpoints", () => {
  const a = { x: 0, y: 0, w: 100, h: 25 },
    b = { x: 0, y: 31, w: 100, h: 25 };
  const result = selectionPath(a, b, "link", [a, b], 0.26);
  assert.equal("blocked" in result, false);
  assert.ok(result.path && result.arrow);
  assert.deepEqual(
    result.points,
    [
      [50, 25],
      [50, 31],
    ],
    "the empty gap between endpoint bodies needs no dummy text detour",
  );
});
