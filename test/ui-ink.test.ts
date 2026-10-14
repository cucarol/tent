import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boxOf,
  emptyCanvas,
  inkAt,
  inkOf,
  moveBy,
  readCanvas,
  withInk,
  withNote,
  type CanvasFile,
  type Ink,
} from "../src/ui/map/drawings.js";

const pen = (id: string, points: [number, number][]): Ink => ({
  id,
  kind: "pen",
  node: null,
  points,
});
const note = (id: string, at: [number, number], text: string): Ink => ({
  id,
  kind: "text",
  node: null,
  at,
  text,
});

test("drawings are only the free pens and texts; anything else in the file is not shown", () => {
  const file: CanvasFile = {
    version: 1,
    forms: { "node-aaaaaa": "box" },
    positions: { "@root": { "node-aaaaaa": [10, 20] } },
    drawings: [
      pen("a", [
        [0, 0],
        [10, 0],
      ]),
      { id: "held", kind: "pen", node: "node-aaaaaa", points: [[1, 1]] },
      { id: "box", kind: "rect", node: null, at: [0, 0], size: [5, 5] },
      { id: "blank", kind: "text", node: null, at: [0, 0], text: "  " },
      { id: "broken", kind: "pen", node: null, points: [[1, "x"]] },
      note("n", [5, 5], "你好"),
    ],
  };
  assert.deepEqual(
    inkOf(file).map((d) => d.id),
    ["a", "n"],
  );
});

test("saving drawings keeps the rest of the file as it was, in place", () => {
  const held = { id: "held", kind: "pen", node: "node-aaaaaa", points: [[1, 1]] };
  const file: CanvasFile = {
    version: 1,
    forms: { "node-aaaaaa": "box" },
    positions: { "@root": { "node-aaaaaa": [10, 20] } },
    drawings: [pen("a", [[0, 0]]), held, pen("b", [[1, 1]])],
  };
  const next = withInk(file, [pen("b", [[2, 2]]), note("c", [3, 3], "x")]);
  assert.deepEqual(next.forms, file.forms);
  assert.deepEqual(next.positions, file.positions);
  // "a" is gone, "held" keeps its place, "b" changed in place, "c" is new at the end.
  assert.deepEqual(
    next.drawings.map((d) => d.id),
    ["held", "b", "c"],
  );
  assert.deepEqual(next.drawings[1], pen("b", [[2, 2]]));
  assert.equal(next.drawings[0], held);
});

test("a missing or unreadable file reads as an empty canvas", () => {
  assert.deepEqual(readCanvas(null), emptyCanvas());
  assert.deepEqual(readCanvas({ version: 2, drawings: [] }), emptyCanvas());
  assert.deepEqual(withInk(readCanvas(null), [note("c", [0, 0], "x")]).drawings.length, 1);
});

test("picking finds the topmost drawing near the pointer", () => {
  const ink = [
    pen("under", [
      [0, 0],
      [100, 0],
    ]),
    pen("over", [
      [50, -20],
      [50, 20],
    ]),
    note("t", [200, 0], "ab"),
  ];
  assert.equal(inkAt(ink, [50, 2], 5)?.id, "over");
  assert.equal(inkAt(ink, [20, 4], 5)?.id, "under");
  assert.equal(inkAt(ink, [20, 9], 5), null);
  assert.equal(inkAt(ink, [205, 8], 5)?.id, "t");
  assert.equal(inkAt([pen("dot", [[0, 0]])], [3, 0], 5)?.id, "dot");
});

test("moving a drawing shifts every point, rounded to a tenth", () => {
  const moved = moveBy(
    pen("a", [
      [0, 0],
      [10, 5],
    ]),
    1.234,
    -2,
  );
  assert.deepEqual(moved.kind === "pen" && moved.points, [
    [1.2, -2],
    [11.2, 3],
  ]);
  const box = boxOf(moveBy(note("t", [0, 0], "ab\ncd"), 10, 10));
  assert.equal(box.x, 10);
  assert.equal(box.y, 10);
  assert.ok(box.h > box.w / 2);
});

test("a note closing keeps what was written, against the drawings as they are then", () => {
  const id = () => "new";
  const stroke = pen("p", [[0, 0]]);
  // Written while a stroke landed: both stay.
  assert.deepEqual(
    withNote([stroke], { at: [5, 5] }, "先做这个  \n", id).map((d) => d.id),
    ["p", "new"],
  );
  assert.deepEqual(
    withNote([stroke], { at: [5, 5] }, "先做这个", id)[1],
    note("new", [5, 5], "先做这个"),
  );
  // Esc, or closed unchanged: nothing changes, not even the array.
  const all = [stroke, note("t", [1, 1], "a")];
  assert.equal(withNote(all, { at: [1, 1], id: "t" }, null, id), all);
  // Edited in place, keeping its position in the list; emptied, it goes.
  assert.deepEqual(withNote(all, { at: [1, 1], id: "t" }, "b", id)[1], note("t", [1, 1], "b"));
  assert.deepEqual(
    withNote(all, { at: [1, 1], id: "t" }, " ", id).map((d) => d.id),
    ["p"],
  );
  // An empty new note adds nothing.
  assert.equal(withNote(all, { at: [9, 9] }, "  ", id), all);
});
