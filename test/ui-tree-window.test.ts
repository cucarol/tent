import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotNode } from "../src/ui/data/types.js";
import {
  TREE_ROW_HEIGHT,
  treeKeyTarget,
  treeRows,
  treeScrollTop,
  treeWindow,
} from "../src/ui/shell/tree-window.js";

function tree(spec: Record<string, string[]>) {
  return {
    childrenOf: (parent: string | null) =>
      (spec[parent ?? ""] ?? []).map((id) => ({ id }) as SnapshotNode),
  };
}

test("the outline retains sibling order, depth and parent through folds and filtering", () => {
  const graph = tree({ "": ["g", "p", "o"], g: ["a", "b"], a: ["match"], p: ["c"] });
  const folded = treeRows(graph, new Set(["g"]), null);
  assert.deepEqual(
    folded.map((r) => [r.node.id, r.depth, r.parent, r.folded]),
    [
      ["g", 0, null, true],
      ["p", 0, null, false],
      ["c", 1, "p", false],
      ["o", 0, null, false],
    ],
  );
  const filtered = treeRows(graph, new Set(["g", "a"]), new Set(["g", "a", "match", "o"]));
  assert.deepEqual(
    filtered.map((r) => r.node.id),
    ["g", "a", "match", "o"],
  );
  assert.deepEqual(
    filtered.map((r) => [r.position, r.siblings]),
    [
      [1, 2],
      [1, 1],
      [1, 1],
      [2, 2],
    ],
  );
  assert.equal(treeKeyTarget(filtered, 2, "ArrowLeft"), "a");
  assert.equal(treeKeyTarget(filtered, 0, "ArrowRight"), "a");
  assert.equal(treeKeyTarget(folded, 0, "ArrowRight"), undefined);
  // A filtered parent can retain its own match while all of its children disappear.
  const ownMatch = treeRows(graph, new Set(), new Set(["g", "o"]));
  assert.equal(treeKeyTarget(ownMatch, 0, "ArrowRight"), undefined);
});

test("a long outline mounts bounded windows and reaches both ends without gaps", () => {
  const count = 727;
  const height = 600;
  const reached = new Set<number>();
  for (let top = 0; top <= count * TREE_ROW_HEIGHT; top += height) {
    const indices = treeWindow(count, top, height);
    assert.ok(indices.length <= height / TREE_ROW_HEIGHT + 16);
    for (const i of indices) {
      assert.ok(i >= 0 && i < count);
      reached.add(i);
    }
  }
  assert.equal(reached.size, count);
  assert.equal(treeWindow(count, 0, height)[0], 0);
  assert.equal(treeWindow(count, count * TREE_ROW_HEIGHT, height).at(-1), count - 1);
  assert.deepEqual(treeWindow(0, 10000, height), []);
  assert.deepEqual(treeWindow(3, 10000, height), [0, 1, 2]);
});

test("keyboard targets and selection reveal use the full outline across DOM windows", () => {
  const ids = Array.from({ length: 727 }, (_, i) => `n${i}`);
  const rows = treeRows(tree({ "": ids }), new Set(), null);
  const first = treeWindow(rows.length, 0, 600);
  const end = treeKeyTarget(rows, 0, "End")!;
  const endIndex = rows.findIndex((r) => r.node.id === end);
  assert.equal(end, "n726");
  assert.ok(!first.includes(endIndex));
  const top = treeScrollTop(endIndex, 0, 600);
  const last = treeWindow(rows.length, top, 600);
  assert.ok(last.includes(endIndex));
  assert.equal(top + 600, rows.length * TREE_ROW_HEIGHT);
  assert.equal(treeKeyTarget(rows, endIndex, "Home"), "n0");
  assert.equal(treeScrollTop(0, top, 600), 0);
  assert.equal(treeKeyTarget(rows, endIndex, "ArrowDown"), undefined);
  assert.equal(treeKeyTarget(rows, 0, "ArrowUp"), undefined);
  const edge = first.at(-1)!;
  assert.equal(treeKeyTarget(rows, edge, "ArrowDown"), `n${edge + 1}`);
  assert.ok(treeWindow(rows.length, treeScrollTop(edge + 1, 0, 600), 600).includes(edge + 1));
  assert.equal(treeScrollTop(5, 0, 600), 0);
  assert.equal(treeScrollTop(5, 0, 0), 150);
});

test("manual scrolling retains one focused row at its logical position without widening the window", () => {
  const normal = treeWindow(727, 20000, 600);
  const pinned = treeWindow(727, 20000, 600, 0);
  assert.deepEqual(pinned, [0, ...normal]);
  assert.equal(treeWindow(727, 0, 600, 726).at(-1), 726);
  assert.deepEqual(treeWindow(727, 20000, 600, normal[0]), normal);
  assert.deepEqual(treeWindow(3, 0, 600, 726), [0, 1, 2]);
});
