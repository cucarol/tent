import assert from "node:assert/strict";
import test from "node:test";
import { arrange, type Arranged } from "../src/ui/map/arrange.js";
import { rectOf, type Rect } from "../src/ui/map/layout.js";
import type { SnapshotNode } from "../src/ui/data/types.js";
import { stagedTopics, TOPIC_PHASE_MS } from "../src/ui/map/motion.js";
import { selectionPath } from "../src/ui/map/geometry.js";
import { floatingPosition } from "../src/ui/map/pointer.js";
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const makeTree = () => {
  const rows = new Map<string | null, SnapshotNode[]>();
  const add = (parent: string | null, id: string, depth: number) => {
    rows.set(parent, [...(rows.get(parent) ?? []), { id } as SnapshotNode]);
    if (depth < 3) for (let i = 0; i < (depth ? 3 : 4); i++) add(id, `${id}.${i}`, depth + 1);
  };
  for (let i = 0; i < 4; i++) add(null, `branch${i}`, 0);
  return (id: string | null) => rows.get(id) ?? [];
};
function frameBoxes(before: Arranged, after: Arranged, t: number) {
  const stages = stagedTopics(before, after, "move");
  return [...stages]
    .filter(([, s]) => s.appearance === "shown")
    .map(([id, s]) => {
      const old = before.placed.get(id)!;
      return {
        id,
        ...rectOf({ ...s.at, x: old.x + (s.at.x - old.x) * t, y: old.y + (s.at.y - old.y) * t }),
      };
    });
}
test("opening clears survivors before entry, and closing removes departing topics before movement", () => {
  const kidsOf = makeTree(),
    closed = new Set(["branch0", "branch0.0", "branch0.1", "branch1", "branch2"]);
  const input = {
    kidsOf,
    closed,
    measure: (id: string, depth: number) => ({ w: 100 + id.length * 8, h: depth ? 28 : 52 }),
  };
  let before = arrange(input);
  for (const id of ["branch0", "branch0.0", "branch0.1", "branch1", "branch2"]) {
    closed.delete(id);
    const at = before.placed.get(id)!;
    const after = arrange({ ...input, anchor: { id, at: [at.x, at.y] } });
    for (const [from, to] of [
      [before, after],
      [after, before],
    ]) {
      const leaving = stagedTopics(from!, to!, "leave");
      for (const [id, s] of leaving) assert.deepEqual(s.at, from!.placed.get(id));
      const entering = stagedTopics(from!, to!, "enter");
      for (const [id, s] of entering)
        assert.equal(s.appearance, from!.placed.has(id) ? "shown" : "entering");
      for (let step = 0; step <= 40; step++) {
        const all = frameBoxes(from!, to!, step / 40);
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++)
            assert.ok(
              !overlap(all[i]!, all[j]!),
              `${id} t=${step / 40}: ${all[i]!.id} crosses ${all[j]!.id}`,
            );
      }
    }
    before = after;
  }
  assert.equal(
    Object.values(TOPIC_PHASE_MS).reduce((a, b) => a + b, 0),
    180,
  );
});
function checkRoute(zoom: number, labelWidth: number) {
  const a = { x: 0, y: 0, w: 100, h: 30 },
    b = { x: 450, y: 0, w: 100, h: 30 };
  const obstacles = [a, b, { x: 180, y: -45, w: 100, h: 120 }, { x: 310, y: -90, w: 70, h: 110 }];
  const routed = selectionPath(a, b, "link", obstacles, zoom, labelWidth);
  assert.ok(routed.path && routed.points.length > 1);
  assert.ok(routed.points.length >= 4);
  assert.ok(routed.label);
  const pad = 8;
  for (let i = 1; i < routed.points.length; i++) {
    const p = routed.points[i - 1]!,
      q = routed.points[i]!;
    for (let t = 0; t <= 1; t += 0.02) {
      const x = p[0] + (q[0] - p[0]) * t,
        y = p[1] + (q[1] - p[1]) * t;
      for (const r of obstacles.slice(2))
        assert.ok(
          !(
            x > r.x - pad + 1e-6 &&
            x < r.x + r.w + pad - 1e-6 &&
            y > r.y - pad + 1e-6 &&
            y < r.y + r.h + pad - 1e-6
          ),
          `route touches expanded obstacle at ${zoom}`,
        );
    }
  }
  const label = {
    x: routed.label.x - labelWidth / 2 - 3,
    y: routed.label.y - 10,
    w: labelWidth + 6,
    h: 20,
  };
  for (const r of obstacles) assert.ok(!overlap(label, r));
}
test("relation paths keep layout clearance and reserve a full-width blank label segment", () => {
  checkRoute(1, 80);
  checkRoute(0.4, 700);
  checkRoute(2, 800);
});
test("a tight ring retains its relation without crossing Node interiors or showing blocked state", () => {
  const a = { x: 0, y: 0, w: 100, h: 30 },
    b = { x: 400, y: 0, w: 100, h: 30 };
  const ring = [
    { x: -130, y: -10, w: 100, h: 50 },
    { x: 130, y: -10, w: 100, h: 50 },
    { x: -30, y: -40, w: 160, h: 30 },
    { x: -30, y: 40, w: 160, h: 30 },
  ];
  for (let i = 0; i < ring.length; i++)
    for (let j = i + 1; j < ring.length; j++) assert.ok(!overlap(ring[i]!, ring[j]!));
  const result = selectionPath(a, b, "link", [a, b, ...ring], 0.3, 150);
  assert.equal("blocked" in result, false);
  assert.ok(result.points.length > 1);
  for (let i = 1; i < result.points.length; i++) {
    const p = result.points[i - 1]!,
      q = result.points[i]!;
    for (const r of ring)
      for (let t = 0; t <= 1; t += 0.02) {
        const x = p[0] + (q[0] - p[0]) * t,
          y = p[1] + (q[1] - p[1]) * t;
        assert.ok(
          !(x > r.x + 1e-7 && x < r.x + r.w - 1e-7 && y > r.y + 1e-7 && y < r.y + r.h - 1e-7),
        );
      }
  }
  assert.ok(result.path);
  assert.ok(result.label);
});
test("measured floating panels choose an empty side, protecting selection and pointer as hard constraints", () => {
  const room = { x: 0, y: 0, w: 800, h: 600 },
    preferred = { x: 260, y: 210, w: 300, h: 180 };
  const protectedRects = [
    { x: 250, y: 200, w: 200, h: 80 },
    { x: 450, y: 250, w: 24, h: 24 },
  ];
  const best = floatingPosition(room, preferred, protectedRects, [{ x: 0, y: 0, w: 200, h: 250 }]);
  for (const r of protectedRects) assert.ok(!overlap(best, r));
  assert.ok(best.x >= 0 && best.y >= 0 && best.x + best.w <= 800 && best.y + best.h <= 600);
  const crowded = floatingPosition(room, preferred, [{ x: 0, y: 0, w: 800, h: 600 }]);
  assert.ok(
    crowded.x === 0 ||
      crowded.y === 0 ||
      crowded.x + crowded.w === 800 ||
      crowded.y + crowded.h === 600,
  );
});
