import assert from "node:assert/strict";
import test from "node:test";
import { keepUnchanged, sameValue } from "../src/ui/map/stable.js";

test("values compare by their entries a few levels down, anything else by identity", () => {
  assert.ok(sameValue({ a: 1, b: [1, { c: "x" }] }, { a: 1, b: [1, { c: "x" }] }));
  assert.ok(!sameValue({ a: 1 }, { a: 2 }));
  assert.ok(!sameValue({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!sameValue([1, 2], [1, 2, 3]));
  assert.ok(!sameValue(new Map(), new Map()));
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.ok(!sameValue(deep, structuredClone(deep), 3));
});

test("the map keeps the object of every card that did not change, and the list when none did", () => {
  const keep = keepUnchanged<{ id: string; x: number }>();
  const first = keep([
    { id: "a", x: 1 },
    { id: "b", x: 2 },
  ]);
  assert.equal(
    keep([
      { id: "a", x: 1 },
      { id: "b", x: 2 },
    ]),
    first,
  );
  const moved = keep([
    { id: "a", x: 1 },
    { id: "b", x: 3 },
  ]);
  assert.notEqual(moved, first);
  assert.equal(moved[0], first[0]);
  assert.notEqual(moved[1], first[1]);
  const reordered = keep([moved[1], { id: "a", x: 1 }]);
  assert.equal(reordered[1], first[0]);
  assert.notEqual(reordered, moved);
  assert.deepEqual(
    keep([{ id: "a", x: 1 }]).map((c) => c.id),
    ["a"],
  );
});
