import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boxOf,
  inkAt,
  inkChanges,
  inkOf,
  moveBy,
  withNote,
  type Ink,
} from "../src/ui/map/drawings.js";
import type { Drawing } from "../src/ui/map/canvas.js";

const pen = (id: string, points: [number, number][]): Ink => ({ id, kind: "pen", points });
const note = (id: string, at: [number, number], text: string): Ink => ({
  id,
  kind: "text",
  at,
  text,
});

test("drawings are only the pens and texts; anything else in the file is not shown", () => {
  const drawings: Drawing[] = [
    pen("a", [
      [0, 0],
      [10, 0],
    ]),
    { id: "box", kind: "rect", at: [0, 0], size: [5, 5] },
    { id: "blank", kind: "text", at: [0, 0], text: "  " },
    { id: "broken", kind: "pen", points: [[1, "x"]] },
    note("n", [5, 5], "你好"),
  ];
  assert.deepEqual(
    inkOf(drawings).map((d) => d.id),
    ["a", "n"],
  );
});

test("a change of drawings is what was added, changed or taken out, by id", () => {
  const a = pen("a", [[0, 0]]),
    b = pen("b", [[1, 1]]);
  const b2 = pen("b", [[2, 2]]),
    c = note("c", [3, 3], "x");
  const changes = inkChanges([a, b], [b2, c]);
  assert.deepEqual([...changes.keys()].sort(), ["a", "b", "c"]);
  assert.equal(changes.get("a"), null);
  assert.equal(changes.get("b"), b2);
  assert.equal(changes.get("c"), c);
  // Unchanged drawings are not written again.
  assert.equal(inkChanges([a, b], [a, b]).size, 0);
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
