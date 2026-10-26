import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotNode } from "../src/ui/data/types.js";
import { arrange, CENTRE, type Arranged } from "../src/ui/map/arrange.js";
import { rectOf, type Rect } from "../src/ui/map/layout.js";

const kids = (parent: string, n: number) => Array.from({ length: n }, (_, i) => `${parent}.${i}`);
const treeOf = (spec: Record<string, string[]>) => (id: string | null) =>
  (spec[id ?? ""] ?? []).map((c) => ({ id: c }) as SnapshotNode);
const meet = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function check(layout: Arranged) {
  const all = [...layout.placed.values(), ...layout.summaries.map((s) => s.at)];
  if (!layout.placed.has(layout.centre.id)) all.push(layout.centre);
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      assert.ok(!meet(rectOf(all[i]!), rectOf(all[j]!)), `${all[i]!.id} overlaps ${all[j]!.id}`);
  for (const line of layout.lines) {
    const [a, b, c, d] = line.points;
    const others = all.filter((p) => p.id !== line.source && p.id !== line.target);
    for (let k = 0; k <= 64; k++) {
      const t = k / 64,
        u = 1 - t;
      const x = u ** 3 * a![0] + 3 * u ** 2 * t * b![0] + 3 * u * t ** 2 * c![0] + t ** 3 * d![0];
      const y = u ** 3 * a![1] + 3 * u ** 2 * t * b![1] + 3 * u * t ** 2 * c![1] + t ** 3 * d![1];
      for (const p of others) {
        const r = rectOf(p);
        assert.ok(
          !(x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h),
          `${line.id} crosses ${p.id}`,
        );
      }
    }
  }
}

test("one layout measures each title once and a later layout measures its new dimensions", () => {
  const spec = { "": ["a", "b"], a: kids("a", 5), b: kids("b", 3) };
  const calls = new Map<string, number>();
  let width = 200;
  const input = {
    kidsOf: treeOf(spec),
    closed: new Set<string>(),
    measure: (id: string, depth: number) => {
      const key = `${depth}:${id}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return { w: width, h: depth === 0 ? 52 : 30 };
    },
  };
  const before = arrange(input);
  assert.ok([...calls.values()].every((n) => n === 1));
  assert.equal(before.placed.get("a")!.w, 200);
  calls.clear();
  width = 240;
  const after = arrange(input);
  assert.ok([...calls.values()].every((n) => n === 1));
  assert.equal(after.placed.get("a")!.w, 240);
  check(before);
  check(after);
});

test("default branches follow outline clockwise and stay on their side when expanded", () => {
  const spec = {
    "": ["a", "b", "c", "d"],
    a: kids("a", 3),
    b: kids("b", 2),
    c: kids("c", 4),
    d: kids("d", 2),
    "a.1": kids("a.1", 8),
  };
  const input = { kidsOf: treeOf(spec), closed: new Set(["a.1"]) };
  const before = arrange(input),
    after = arrange({ ...input, closed: new Set() });
  check(before);
  check(after);
  assert.deepEqual(before, arrange(input));
  assert.equal(before.centre.id, CENTRE);
  assert.equal(before.topics.get("a")!.side, 1);
  const clockwise = [...before.placed.values()]
    .filter((p) => before.topics.get(p.id)!.depth === 1)
    .sort((a, b) =>
      before.topics.get(a.id)!.side !== before.topics.get(b.id)!.side
        ? before.topics.get(b.id)!.side - before.topics.get(a.id)!.side
        : (a.y - b.y) * before.topics.get(a.id)!.side,
    )
    .map((p) => p.id);
  assert.deepEqual(clockwise, spec[""]);
  for (const id of spec[""]) assert.equal(before.topics.get(id)!.side, after.topics.get(id)!.side);
  for (const [id, topic] of before.topics)
    if (topic.side === -1) assert.deepEqual(after.placed.get(id), before.placed.get(id));
});

test("expanding a deep topic pins it without moving the opposite branch", () => {
  const spec = {
    "": ["a", "b", "c", "d"],
    a: kids("a", 3),
    b: kids("b", 2),
    c: kids("c", 3),
    d: kids("d", 2),
    "a.1": kids("a.1", 9),
  };
  const before = arrange({ kidsOf: treeOf(spec), closed: new Set(["a.1"]) });
  const clicked = before.placed.get("a.1")!;
  const after = arrange({
    kidsOf: treeOf(spec),
    closed: new Set(),
    anchor: { id: clicked.id, at: [clicked.x, clicked.y] },
  });
  check(after);
  assert.equal(after.placed.get(clicked.id)!.x, clicked.x);
  assert.equal(after.placed.get(clicked.id)!.y, clicked.y);
  for (const [id, topic] of before.topics)
    if (topic.side !== before.topics.get(clicked.id)!.side)
      assert.deepEqual(after.placed.get(id), before.placed.get(id));
});

test("long sibling lists show eleven topics and one count, then open in full", () => {
  const spec = { "": ["p"], p: kids("p", 20) };
  const input = { kidsOf: treeOf(spec), closed: new Set<string>() };
  const limited = arrange(input),
    full = arrange({ ...input, open: new Set(["p"]) });
  assert.equal(limited.placed.size, 12);
  assert.equal(limited.summaries.length, 1);
  assert.equal(limited.summaries[0]!.kind, "more");
  assert.equal(limited.summaries[0]!.count, 9);
  assert.deepEqual(limited.summaries[0]!.ids, spec.p.slice(11));
  assert.equal(full.placed.size, 21);
  assert.equal(full.summaries.length, 0);
  check(limited);
  check(full);
});

test("result outputs share one topic and opening them does not change branch sides", () => {
  const spec = { "": ["a", "b"], a: ["a.0", "a.out1", "a.out2"], b: kids("b", 2) };
  const input = {
    kidsOf: treeOf(spec),
    closed: new Set<string>(),
    results: (_: string, nodes: SnapshotNode[]) =>
      nodes.filter((n) => n.id.includes(".out")).map((n) => n.id),
  };
  const grouped = arrange(input),
    opened = arrange({ ...input, openOutputs: new Set(["a"]) });
  assert.deepEqual(grouped.folds!.get("a"), ["a.out1", "a.out2"]);
  assert.equal(grouped.summaries[0]!.count, 2);
  assert.ok(!grouped.placed.has("a.out1"));
  assert.ok(opened.placed.has("a.out1"));
  assert.equal(grouped.topics.get("b")!.side, opened.topics.get("b")!.side);
  check(grouped);
  check(opened);
});

test("focus uses the selected topic as centre and excludes the rest of the tree", () => {
  const spec = { "": ["a", "b"], a: ["a.0", "a.1"], "a.0": ["a.0.0"] };
  const laid = arrange({ kidsOf: treeOf(spec), closed: new Set(), focus: "a" });
  assert.equal(laid.centre.id, "a");
  assert.equal(laid.centre.y, 0);
  assert.equal(laid.topics.get("a")!.depth, 0);
  assert.ok(!laid.placed.has("b"));
  assert.equal(laid.topics.get("a.0")!.depth, 1);
  check(laid);
});

test("all opening states leave room for different title widths and file previews", () => {
  const spec = {
    "": ["a", "b", "c"],
    a: ["a.0", "a.1"],
    b: ["b.0", "b.1"],
    c: ["c.0", "c.1"],
    "a.0": kids("a.0", 4),
    "b.1": kids("b.1", 5),
    "c.0": kids("c.0", 3),
  };
  for (let bits = 0; bits < 64; bits++) {
    const ids = ["a", "b", "c", "a.0", "b.1", "c.0"];
    const closed = new Set(ids.filter((_, i) => bits & (1 << i)));
    check(
      arrange({
        kidsOf: treeOf(spec),
        closed,
        grown: (id) => (id === "a.1" ? 160 : id === "b.1" ? 120 : 0),
        measure: (id, depth) => ({
          w: id.endsWith("1") ? 296 : depth ? 144 : 176,
          h: depth ? 30 : 52,
        }),
      }),
    );
  }
});

test("focus keeps list summaries and result groups without changing sides on opening or resize", () => {
  const spec = { "": ["p"], p: kids("p", 20) };
  const input = { kidsOf: treeOf(spec), focus: "p", closed: new Set<string>() };
  const capped = arrange(input);
  const full = arrange({ ...input, open: new Set(["p"]) });
  const narrow = arrange({ ...input, open: new Set(["p"]), aspect: 0.8 });
  assert.equal(capped.summaries[0]?.count, 9);
  for (const [id, topic] of capped.topics) assert.equal(full.topics.get(id)?.side, topic.side);
  for (const [id, topic] of full.topics) assert.equal(narrow.topics.get(id)?.side, topic.side);
  assert.equal(arrange({ ...input, closed: new Set(["p"]) }).placed.size, 1);
  const outputs = arrange({ ...input, results: (_, nodes) => nodes.slice(2).map((n) => n.id) });
  assert.equal(outputs.summaries[0]?.kind, "outputs");
  assert.equal(outputs.summaries[0]?.count, 18);
  for (const layout of [capped, full, narrow, outputs]) check(layout);
});

test("left-side expansion and previews preserve the pinned title and every opposite topic", () => {
  const spec = {
    "": ["a", "b", "c", "d"],
    a: kids("a", 3),
    b: kids("b", 2),
    c: kids("c", 3),
    d: kids("d", 2),
    "d.0": kids("d.0", 10),
  };
  const input = {
    kidsOf: treeOf(spec),
    closed: new Set(["d.0"]),
    grown: (id: string) => (id === "d.0" ? 160 : 0),
  };
  const before = arrange(input),
    clicked = before.placed.get("d.0")!;
  assert.equal(before.topics.get(clicked.id)!.side, -1);
  const opened = arrange({
    ...input,
    closed: new Set(),
    anchor: { id: clicked.id, at: [clicked.x, clicked.y] },
  });
  const closed = arrange({ ...input, anchor: { id: clicked.id, at: [clicked.x, clicked.y] } });
  for (const layout of [opened, closed]) {
    check(layout);
    assert.deepEqual(layout.placed.get(clicked.id), clicked);
    for (const [id, topic] of before.topics)
      if (topic.side === 1) assert.deepEqual(layout.placed.get(id), before.placed.get(id));
  }
});

test("a focused centre with a tall preview leaves both sides and their lines clear", () => {
  const spec = { "": ["p"], p: kids("p", 10) };
  const layout = arrange({
    kidsOf: treeOf(spec),
    focus: "p",
    closed: new Set(),
    grown: (id) => (id === "p" ? 200 : 0),
  });
  check(layout);
  assert.equal(layout.centre.h, 252);
});

test("a one-level default packs the visible roots and keeps expansion on its side", () => {
  const spec = { "": ["a", "b", "c", "d"], a: kids("a", 12), b: kids("b", 2), c: kids("c", 8) };
  const input = { kidsOf: treeOf(spec), defaultDepth: 1, closed: new Set(spec[""]) };
  const before = arrange(input),
    clicked = before.placed.get("a")!;
  assert.equal(before.placed.size, 4);
  const ys = [...before.placed.values()].map((p) => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 120);
  const after = arrange({
    ...input,
    closed: new Set(["b", "c", "d"]),
    anchor: { id: "a", at: [clicked.x, clicked.y] },
  });
  assert.deepEqual(after.placed.get("a"), clicked);
  for (const [id, topic] of before.topics)
    if (topic.side === -1) assert.deepEqual(after.placed.get(id), before.placed.get(id));
  check(after);
});
