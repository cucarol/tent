import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachInk,
  projectInk,
  inkOf,
  moveBy,
  inkChanges,
  withChanges,
  settle,
  anchorsOf,
  type Ink,
  type InkContext,
  type Line,
  type Pt,
} from "../src/ui/map/drawings.js";
import {
  emptyCanvas,
  inverseOf,
  noPending,
  readCanvas,
  withPending,
} from "../src/ui/map/canvas.js";

const context = (topics: [string, Pt][], ids = ["a", "b"], focus = "@mind-centre"): InkContext => ({
  topics: new Map(topics),
  existingIds: new Set(ids),
  centre: { id: focus, at: [0, 0] },
});
const stroke: Ink = {
  id: "p",
  kind: "pen",
  points: [
    [10, 10],
    [30, 20],
  ],
};

test("every drawing kind follows the nearest title centre and reattaches after geometry edits", () => {
  const c = context([
    ["a", [0, 0]],
    ["b", [200, 0]],
  ]);
  const list: Ink[] = [
    stroke,
    { id: "t", kind: "text", at: [15, 15], text: "文字" },
    { id: "s", kind: "shape", shape: "ellipse", box: [10, 10, 20, 10] },
    {
      id: "l",
      kind: "shape",
      shape: "line",
      ends: [
        [10, 10],
        [30, 20],
      ],
      bend: [15, 25],
    },
  ];
  const attached = list.map((d) => attachInk(d, c));
  assert.ok(attached.every((d) => d.attachment?.topic === "a"));
  const next = projectInk(
    attached,
    context([
      ["a", [100, 50]],
      ["b", [200, 0]],
    ]),
  );
  for (let i = 0; i < list.length; i++) {
    const expected = moveBy(attached[i], 100, 50);
    assert.deepEqual(
      { ...next.all[i], attachment: undefined },
      { ...expected, attachment: undefined },
    );
    assert.equal(next.visible[i], next.all[i]);
  }
  assert.equal(attachInk(moveBy(attached[0], 180, 0), c).attachment?.topic, "b");
  const again = projectInk(
    next.all,
    context([
      ["a", [100, 50]],
      ["b", [200, 0]],
    ]),
  );
  assert.ok(again.all.every((d, i) => d === next.all[i]));
});

test("folding, filtering and focus changes hide without deleting, and restoration follows the target", () => {
  const c = context([["a", [0, 0]]]);
  const first = projectInk([stroke], c);
  assert.equal(first.all[0].attachment?.topic, "a");
  const hidden = projectInk(first.all, context([]));
  assert.equal(hidden.all[0], first.all[0]);
  assert.deepEqual(hidden.visible, []);
  const restored = projectInk(hidden.all, context([["a", [100, 20]]]));
  assert.deepEqual((restored.visible[0] as typeof stroke).points, [
    [110, 30],
    [130, 40],
  ]);
  const deleted = projectInk(restored.all, context([], ["b"]));
  assert.equal(deleted.visible[0], restored.all[0]);
  assert.deepEqual(projectInk(deleted.all, context([], ["b"], "b")).all, deleted.all);
  const refocused = projectInk(restored.all, context([], ["a", "b"], "b"));
  const reloaded = inkOf(JSON.parse(JSON.stringify(refocused.all)));
  const back = projectInk(reloaded, context([["a", [200, 40]]]));
  assert.deepEqual((back.visible[0] as typeof stroke).points, [
    [210, 50],
    [230, 60],
  ]);
});

test("far drawings belong to their original centre across focus changes and reloads", () => {
  const far = moveBy(stroke, 2000, 2000);
  const first = projectInk([far], context([["a", [0, 0]]]));
  assert.equal(first.all[0].attachment?.topic, "@mind-centre");
  assert.deepEqual(projectInk(first.all, context([["b", [0, 0]]], ["a", "b"], "b")).visible, []);
  const file = readCanvas(JSON.parse(JSON.stringify({ ...emptyCanvas(), drawings: first.all })));
  assert.deepEqual(projectInk(inkOf(file.drawings), context([["a", [0, 0]]])).all, first.all);
  const onNode = attachInk(far, context([["a", [0, 0]]], ["a", "b"], "a"));
  assert.equal(onNode.attachment?.topic, "a");
  assert.deepEqual(projectInk([onNode], context([], ["a", "b"], "b")).visible, []);
});

test("unknown drawing fields and attachment survive parse, movement and whole-file roundtrip", () => {
  const custom = { retained: [1, "future"] };
  const d = { ...attachInk(stroke, context([["a", [0, 0]]])), custom };
  const file = readCanvas(JSON.parse(JSON.stringify({ ...emptyCanvas(), drawings: [d] })));
  const moved = projectInk(inkOf(file.drawings), context([["a", [50, 30]]])).all;
  assert.deepEqual((moved[0] as Ink & { custom: unknown }).custom, custom);
  const reloaded = inkOf(
    readCanvas(JSON.parse(JSON.stringify({ ...file, drawings: moved }))).drawings,
  );
  assert.deepEqual(projectInk(reloaded, context([["a", [50, 30]]])).all, moved);
});

test("arrow endpoints follow their outlines, hide with absent visible topics, and freeze on deletion", () => {
  const c = context([
    ["a", [0, 0]],
    ["b", [100, 0]],
  ]);
  const arrow: Line = {
    id: "l",
    kind: "shape",
    shape: "line",
    ends: [
      [0, 0],
      [100, 0],
    ],
    start: "a",
    end: "b",
    heads: ["none", "arrow"],
  };
  const all = projectInk([arrow], c).all;
  assert.deepEqual(projectInk(all, context([["a", [0, 0]]])).visible, []);
  const projected = projectInk(
    all,
    context([
      ["a", [50, 0]],
      ["b", [200, 0]],
    ]),
  );
  const settled = settle(
    projected.visible,
    anchorsOf(projected.visible, [
      { id: "a", box: { x: 40, y: -10, w: 20, h: 20 }, shape: "rect" },
      { id: "b", box: { x: 190, y: -10, w: 20, h: 20 }, shape: "rect" },
    ]),
  );
  assert.deepEqual((settled[0] as Line).ends, [
    [66, 0],
    [184, 0],
  ]);
  const deleted = projectInk(settled, context([], []));
  assert.deepEqual(deleted.visible, settled);
  assert.deepEqual(settle(deleted.visible, []), settled);
});

test("gesture diff, undo and external saves retain hidden drawings", () => {
  const initial = [
    attachInk(stroke, context([["a", [0, 0]]])),
    attachInk({ ...stroke, id: "hidden" }, context([["b", [0, 0]]])),
  ];
  const projected = projectInk(initial, context([["a", [0, 0]]]));
  const edited = projected.visible.map((d) =>
    attachInk(moveBy(d, 10, 0), context([["a", [0, 0]]])),
  );
  const next = withChanges(projected.all, inkChanges(projected.visible, edited));
  assert.equal(next[1], initial[1]);
  const file = { ...emptyCanvas(), drawings: initial };
  const changes = { ...noPending(), drawings: inkChanges(initial, next) };
  const undo = inverseOf(file, changes);
  const external = { ...file, drawings: [...initial, { ...stroke, id: "remote" }] };
  assert.deepEqual(withPending(withPending(external, changes), undo), external);
});
