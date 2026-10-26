import { primaryOf, type Graph } from "../data/store.js";
import type { SnapshotNode } from "../data/types.js";

// One line per card, wide enough for a bold name of eight Chinese characters, its tag and three Role faces;
// a top-level card stands a little taller, as the head of its group.
export const CARD = { w: 296, h: 44, top: 52 };
// The gap between columns holds the elbow of the links; tree links turn halfway across it.
export const GAP = 56;

/**
 * Position of a card's left-centre point, its height and width. A card showing a preview has a `head`,
 * its title row: `y` is the middle of that row, links meet it there, and the preview hangs below.
 */
export type Placed = { id: string; x: number; y: number; h: number; w: number; head?: number };
export type Label = { id: string; text: string; x: number; y: number };
export type Layout = {
  placed: Map<string, Placed>;
  labels: Label[];
  /** In the tree, the result outputs folded into each card's count. */
  folds?: Map<string, string[]>;
};
export type Rect = { x: number; y: number; w: number; h: number; head?: number };

export const rectOf = (p: Placed): Rect =>
  p.head === undefined
    ? { x: p.x, y: p.y - p.h / 2, w: p.w, h: p.h }
    : { x: p.x, y: p.y - p.head / 2, w: p.w, h: p.h, head: p.head };

/** An output with nothing under it is a result rather than structure. */
export const isResult = (graph: Graph, id: string) => {
  const n = graph.nodes.get(id);
  return !!n && primaryOf(n.type) === "output" && graph.childrenOf(id).length === 0;
};

/** The tree as the type switches show it: what hangs from each shown card, and what each hangs from. */
export type Shown = {
  kidsOf: (id: string | null) => SnapshotNode[];
  upOf: (id: string) => string | null;
};

/** A switched-off card drops out and what is shown under it hangs from its nearest shown ancestor. */
export function shownTree(graph: Graph, visible: (id: string) => boolean): Shown {
  const kids = new Map<string | null, SnapshotNode[]>();
  const kidsOf = (id: string | null): SnapshotNode[] => {
    let out = kids.get(id);
    if (!out) {
      out = graph.childrenOf(id).flatMap((c) => (visible(c.id) ? [c] : kidsOf(c.id)));
      kids.set(id, out);
    }
    return out;
  };
  const upOf = (id: string): string | null => {
    let up = graph.nodes.get(id)?.parentId ?? null;
    while (up && !(graph.nodes.has(up) && visible(up))) up = graph.nodes.get(up)?.parentId ?? null;
    return up;
  };
  return { kidsOf, upOf };
}
