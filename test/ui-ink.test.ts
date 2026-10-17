import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aabb,
  anchorAt,
  anchorsOf,
  boxOf,
  copiesOf,
  edgeOf,
  fitTo,
  inkAt,
  inkChanges,
  inkOf,
  inkWithin,
  layered,
  moveBy,
  restack,
  restyle,
  scaleAll,
  settle,
  withChanges,
  withWords,
  type Anchor,
  type Face,
  type Ink,
  type Line,
} from "../src/ui/map/drawings.js";
import {
  inverseOf,
  laidOver,
  noPending,
  withPending,
  type CanvasFile,
  type Drawing,
  type Pending,
} from "../src/ui/map/canvas.js";

const pen = (id: string, points: [number, number][]): Ink => ({ id, kind: "pen", points });
const note = (id: string, at: [number, number], text: string): Ink => ({
  id,
  kind: "text",
  at,
  text,
});
const rect = (id: string, box: Face["box"], more: Partial<Face> = {}): Face => ({
  id,
  kind: "shape",
  shape: "rect",
  box,
  ...more,
});
const line = (id: string, ends: Line["ends"], more: Partial<Line> = {}): Line => ({
  id,
  kind: "shape",
  shape: "line",
  ends,
  ...more,
});

test("drawings are the pens, texts and shapes this page knows; anything else is not shown", () => {
  const drawings: Drawing[] = [
    pen("a", [
      [0, 0],
      [10, 0],
    ]),
    { id: "box", kind: "rect", at: [0, 0], size: [5, 5] },
    { id: "blank", kind: "text", at: [0, 0], text: "  " },
    { id: "broken", kind: "pen", points: [[1, "x"]] },
    { id: "flat", kind: "shape", shape: "rect", box: [0, 0, 0, 5] },
    { id: "star", kind: "shape", shape: "star", box: [0, 0, 5, 5] },
    { id: "r", kind: "shape", shape: "diamond", box: [0, 0, 5, 5], color: "accent", fill: "pink" },
    {
      id: "l",
      kind: "shape",
      shape: "line",
      ends: [
        [0, 0],
        [5, 5],
      ],
      heads: ["none", "arrow"],
      start: "node-abcdef",
    },
    note("n", [5, 5], "你好"),
  ];
  const ink = inkOf(drawings);
  assert.deepEqual(
    ink.map((d) => d.id),
    ["a", "r", "l", "n"],
  );
  // Values it does not know are dropped, not guessed at.
  assert.deepEqual(ink[1], {
    id: "r",
    kind: "shape",
    shape: "diamond",
    box: [0, 0, 5, 5],
    color: "accent",
  });
  assert.equal((ink[2] as Line).start, "node-abcdef");
});

test("layers order the drawings; without one, the file's order stands", () => {
  const ink = layered([
    { ...pen("a", [[0, 0]]), z: 5 },
    pen("b", [[0, 0]]),
    { ...pen("c", [[0, 0]]), z: 0.5 },
  ]);
  assert.deepEqual(
    ink.map((d) => d.id),
    ["c", "b", "a"],
  );
  const picked = new Set(["b"]);
  assert.deepEqual(
    restack(ink, picked, "front").map((d) => d.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    restack(ink, picked, "down").map((d) => [d.id, d.z]),
    [
      ["b", 0],
      ["c", 1],
      ["a", 2],
    ],
  );
  // Already at the back: nothing to move.
  assert.deepEqual(
    restack(restack(ink, picked, "back"), picked, "down").map((d) => d.id),
    ["b", "c", "a"],
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

test("picking finds the topmost drawing near the pointer, turned ones included", () => {
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
    rect("r", [300, 0, 100, 20], { rot: 90 }),
    line(
      "bent",
      [
        [500, 0],
        [600, 0],
      ],
      { bend: [550, 40] },
    ),
  ];
  assert.equal(inkAt(ink, [50, 2], 5)?.id, "over");
  assert.equal(inkAt(ink, [20, 4], 5)?.id, "under");
  assert.equal(inkAt(ink, [20, 9], 5), null);
  assert.equal(inkAt(ink, [205, 8], 5)?.id, "t");
  assert.equal(inkAt([pen("dot", [[0, 0]])], [3, 0], 5)?.id, "dot");
  // Turned a quarter, the wide box stands upright round its middle.
  assert.equal(inkAt(ink, [350, 45], 2)?.id, "r");
  assert.equal(inkAt(ink, [395, 10], 2), null);
  // A bent line is found along its curve, not along the straight way.
  assert.equal(inkAt(ink, [550, 40], 3)?.id, "bent");
  assert.equal(inkAt(ink, [550, 1], 3), null);
  const turned = aabb(ink[3]);
  assert.deepEqual([turned.x, turned.y, turned.w, turned.h].map(Math.round), [340, -40, 20, 100]);
  assert.deepEqual(
    inkWithin(ink, { x: 290, y: -50, w: 120, h: 120 }).map((d) => d.id),
    ["r"],
  );
});

test("moving and resizing shift every point, rounded to a tenth", () => {
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
  // A text's corner grows its size; a pen stroke stretches with its box.
  const grown = fitTo(
    note("t", [0, 0], "ab"),
    { x: 0, y: 0, w: 20, h: 20 },
    { x: 0, y: 0, w: 40, h: 40 },
  );
  assert.equal(grown.kind === "text" && grown.size, 30);
  const wide = fitTo(
    pen("p", [
      [0, 0],
      [10, 10],
    ]),
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 5, y: 0, w: 20, h: 10 },
  );
  assert.deepEqual(wide.kind === "pen" && wide.points, [
    [5, 0],
    [25, 10],
  ]);
  // A group scales round its far corner, each shape round its own middle.
  const [r] = scaleAll([rect("r", [10, 10, 10, 10])], [0, 0], 2);
  assert.deepEqual((r as Face).box, [20, 20, 20, 20]);
});

test("a line end holds on to a shape or a card, at its outline, and lets go when it is gone", () => {
  const card: Anchor = { id: "node-abcdef", box: { x: 200, y: 0, w: 100, h: 50 }, shape: "rect" };
  const box = rect("r", [0, 0, 100, 50]);
  const ink: Ink[] = [
    box,
    line(
      "l",
      [
        [50, 25],
        [250, 25],
      ],
      { start: "r", end: card.id },
    ),
  ];
  const anchors = anchorsOf(ink, [card]);
  assert.equal(anchorAt(anchors, [104, 25], 8)?.id, "r");
  assert.equal(anchorAt(anchors, [150, 25], 8), null);
  // Ends stop a little outside each outline, facing each other.
  const [, l] = settle(ink, anchors) as [Face, Line];
  assert.deepEqual(l.ends, [
    [106, 25],
    [194, 25],
  ]);
  assert.deepEqual(
    edgeOf({ id: "e", box: { x: 0, y: 0, w: 100, h: 50 }, shape: "ellipse" }, [50, -100]),
    [50, -6],
  );
  // The card moved on: the end follows it.
  const moved = settle(
    ink,
    anchorsOf(ink, [{ ...card, box: { x: 200, y: 100, w: 100, h: 50 } }]),
  )[1] as Line;
  assert.ok(moved.ends[1][1] > 25);
  // The card not on the map: the end stays where it last was.
  assert.equal(settle([l], anchorsOf([box], []))[0].kind, "shape");
  assert.deepEqual((settle([l], [])[0] as Line).ends, l.ends);
});

test("copies get new ids, and lines between copied shapes hold on to the copies", () => {
  const ink: Ink[] = [
    rect("a", [0, 0, 10, 10]),
    rect("b", [50, 0, 10, 10]),
    line(
      "ab",
      [
        [10, 5],
        [50, 5],
      ],
      { start: "a", end: "b" },
    ),
    line(
      "toCard",
      [
        [10, 5],
        [90, 5],
      ],
      { start: "a", end: "node-abcdef" },
    ),
  ];
  let n = 0;
  const made = copiesOf(ink, 16, () => `c${n++}`);
  assert.deepEqual(
    made.map((d) => d.id),
    ["c0", "c1", "c2", "c3"],
  );
  assert.deepEqual([(made[2] as Line).start, (made[2] as Line).end], ["c0", "c1"]);
  // A card is not copied, so the copy lets go of it.
  assert.deepEqual([(made[3] as Line).start, (made[3] as Line).end], ["c0", undefined]);
  assert.deepEqual((made[0] as Face).box, [16, 16, 10, 10]);
});

test("written words close into the drawings as they are then", () => {
  const all: Ink[] = [
    pen("p", [[0, 0]]),
    note("t", [1, 1], "a"),
    rect("r", [0, 0, 10, 10], { label: "x" }),
  ];
  // Esc, or closed unchanged: nothing changes, not even the array.
  assert.equal(withWords(all, "t", null), all);
  // A text edited in place keeps its place; emptied, it goes.
  assert.deepEqual(withWords(all, "t", "b  \n")[1], note("t", [1, 1], "b"));
  assert.deepEqual(
    withWords(all, "t", " ").map((d) => d.id),
    ["p", "r"],
  );
  // A shape's label is set, or taken off, and the shape stays.
  assert.equal((withWords(all, "r", "登录")[2] as Face).label, "登录");
  assert.equal("label" in withWords(all, "r", "")[2], false);
});

test("restyling writes only what differs from the default", () => {
  const r = rect("r", [0, 0, 10, 10], { color: "accent", dash: "dashed" });
  assert.equal("color" in restyle(r, { color: "ink" }), false);
  assert.equal((restyle(r, { fill: "goal" }) as Face).fill, "goal");
  assert.equal("dash" in restyle(r, { dash: "solid" }), false);
  // A text has no line to dash, and only lines have heads.
  const t = note("t", [0, 0], "a");
  assert.equal(restyle(t, { dash: "dotted" }), t);
  assert.equal(restyle(r, { head: [1, "arrow"] }), r);
  assert.deepEqual(
    (
      restyle(
        line("l", [
          [0, 0],
          [1, 1],
        ]),
        { head: [0, "dot"] },
      ) as Line
    ).heads,
    ["dot", "none"],
  );
});

test("undo turns back only the entries its step changed, so what arrived meanwhile stays", () => {
  const file: CanvasFile = {
    version: 2,
    positions: { "node-aaaaaa": [0, 0] },
    regions: [{ id: "g", name: "", box: [0, 0, 10, 10] }],
    drawings: [pen("p", [[0, 0]]) as Drawing],
  };
  // This page moves a card, names the region and writes a text.
  const step: Pending = {
    positions: new Map([["node-aaaaaa", [5, 5]]]),
    regions: new Map([["g", { id: "g", name: "登录", box: [0, 0, 10, 10] }]]),
    drawings: new Map([["t", note("t", [0, 0], "a") as Drawing]]),
  };
  const back = inverseOf(file, step);
  assert.deepEqual([...back.positions], [["node-aaaaaa", [0, 0]]]);
  assert.deepEqual([...back.regions], [["g", file.regions[0]]]);
  assert.deepEqual([...back.drawings], [["t", null]]);
  // Another page then adds a stroke and places a card; undo here leaves both.
  const remote: CanvasFile = withPending(file, {
    ...noPending(),
    positions: new Map([["node-bbbbbb", [1, 1]]]),
    drawings: new Map([["q", pen("q", [[2, 2]]) as Drawing]]),
  });
  const undone = withPending(withPending(remote, step), back);
  assert.deepEqual(undone.positions, { "node-aaaaaa": [0, 0], "node-bbbbbb": [1, 1] });
  assert.deepEqual(
    undone.drawings.map((d) => d.id),
    ["p", "q"],
  );
  assert.equal(undone.regions[0].name, "");
  // Steps laid over each other: the later one wins where both touch.
  const both = laidOver(step, { ...noPending(), positions: new Map([["node-aaaaaa", [9, 9]]]) });
  assert.deepEqual(both.positions.get("node-aaaaaa"), [9, 9]);
  assert.equal(both.drawings.size, 1);
});

test("a gesture hands on only what it changed, laid over the drawings as they are when it ends", () => {
  const begun: Ink[] = [pen("p", [[0, 0]]), rect("r", [0, 0, 10, 10])];
  const moved = begun.map((d) => (d.id === "r" ? moveBy(d, 5, 0) : d));
  const changes = inkChanges(begun, moved);
  assert.deepEqual([...changes.keys()], ["r"]);
  // A stroke from elsewhere arrived during the drag: it stays.
  const now: Ink[] = [...begun, pen("q", [[3, 3]])];
  const out = withChanges(now, changes);
  assert.deepEqual(
    out.map((d) => d.id),
    ["p", "r", "q"],
  );
  assert.deepEqual((out[1] as Face).box, [5, 0, 10, 10]);
  // Taken out and added by id; nothing to change leaves a copy as it was.
  assert.deepEqual(
    withChanges(
      now,
      new Map<string, Ink | null>([
        ["p", null],
        ["n", note("n", [0, 0], "x")],
      ]),
    ).map((d) => d.id),
    ["r", "q", "n"],
  );
  assert.deepEqual(withChanges(now, new Map()), now);
});

test("a fresh text closes into drawings that gained a stroke while it was open", () => {
  const fresh = note("t", [1, 1], "");
  const now: Ink[] = [pen("p", [[0, 0]]), pen("q", [[3, 3]])];
  const out = withWords([...now, fresh], "t", "你好");
  assert.deepEqual(
    out.map((d) => d.id),
    ["p", "q", "t"],
  );
  assert.equal((out[2] as { text: string }).text, "你好");
});
