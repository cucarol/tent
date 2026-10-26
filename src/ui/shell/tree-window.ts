import type { Graph } from "../data/store.js";
import type { SnapshotNode } from "../data/types.js";

export const TREE_ROW_HEIGHT = 30;
const OVERSCAN = 8;

export type TreeRow = {
  node: SnapshotNode;
  depth: number;
  parent: string | null;
  folded: boolean;
  children: number;
  position: number;
  siblings: number;
};

/** The complete visible outline, independent of which rows have DOM elements. */
export function treeRows(
  graph: Pick<Graph, "childrenOf">,
  collapsed: ReadonlySet<string>,
  shown: ReadonlySet<string> | null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    const siblings = graph.childrenOf(parent).filter((n) => !shown || shown.has(n.id));
    siblings.forEach((node, i) => {
      const children = graph.childrenOf(node.id).length;
      const folded = children > 0 && !shown && collapsed.has(node.id);
      rows.push({
        node,
        depth,
        parent,
        folded,
        children,
        position: i + 1,
        siblings: siblings.length,
      });
      if (!folded) walk(node.id, depth + 1);
    });
  };
  walk(null, 0);
  return rows;
}

/** Mount the viewport and a small buffer, retaining a focused row when it scrolls out of view. */
export function treeWindow(count: number, top: number, height: number, focused = -1): number[] {
  const visibleHeight = Math.max(TREE_ROW_HEIGHT, height);
  const scroll = Math.max(0, Math.min(top, count * TREE_ROW_HEIGHT - visibleHeight));
  const start = Math.max(0, Math.floor(scroll / TREE_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(count, Math.ceil((scroll + visibleHeight) / TREE_ROW_HEIGHT) + OVERSCAN);
  const indices = Array.from({ length: end - start }, (_, i) => start + i);
  if (focused >= 0 && focused < count) {
    if (focused < start) indices.unshift(focused);
    else if (focused >= end) indices.push(focused);
  }
  return indices;
}

/** Scroll just far enough to reveal a logical row, even before that row is mounted. */
export function treeScrollTop(index: number, top: number, height: number): number {
  const y = index * TREE_ROW_HEIGHT;
  if (y < top || height < TREE_ROW_HEIGHT) return y;
  return Math.max(top, y + TREE_ROW_HEIGHT - height);
}

export function treeKeyTarget(
  rows: readonly TreeRow[],
  at: number,
  key: string,
): string | undefined {
  const row = rows[at];
  if (!row) return;
  switch (key) {
    case "ArrowDown":
      return rows[at + 1]?.node.id;
    case "ArrowUp":
      return rows[at - 1]?.node.id;
    case "Home":
      return rows[0]?.node.id;
    case "End":
      return rows.at(-1)?.node.id;
    case "ArrowLeft":
      return row.parent ?? undefined;
    case "ArrowRight":
      return !row.folded && rows[at + 1]?.parent === row.node.id
        ? rows[at + 1]!.node.id
        : undefined;
  }
}
