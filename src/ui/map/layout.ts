import { hierarchy, tree, type HierarchyNode } from "d3-hierarchy";
import { primaryOf, type Graph } from "../data/store.js";
import type { SnapshotNode, SyncFlag, SyncFlags } from "../data/types.js";
import { t } from "../i18n.js";

// One line per card, wide enough for a bold name of eight Chinese characters, its tag and three Role faces;
// a top-level card stands a little taller, as the head of its group.
export const CARD = { w: 296, h: 44, top: 52 };
// The gap between columns holds the elbow of the links; tree links turn halfway across it.
export const GAP = 56;
const COLUMN = CARD.w + GAP;
// Rows leave a gap wide enough for a reference line to pass between two cards.
const ROW = CARD.h + 16;

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

/**
 * The behind and ahead Nodes in outline order, each kind with any at all: `ids` keeps only the visible
 * ones, to count and step through, and `all` counts every one.
 */
export function flagRuns(
  graph: Graph,
  flags: SyncFlags,
  visible: (id: string) => boolean,
): { state: keyof SyncFlag; ids: string[]; all: number }[] {
  const order: string[] = [];
  const walk = (parentId: string | null) => {
    for (const n of graph.childrenOf(parentId)) {
      order.push(n.id);
      walk(n.id);
    }
  };
  walk(null);
  return (["behind", "ahead"] as const).flatMap((state) => {
    const all = order.filter((id) => flags[id]?.[state]);
    return all.length ? [{ state, ids: all.filter(visible), all: all.length }] : [];
  });
}

type TreeDatum = { id: string; children: TreeDatum[] };

/**
 * The folder hierarchy read left to right. Top-level branches get extra room so each reads as one group.
 * A card's result outputs fold into a count on it unless its id is in `open`. A card showing a preview of
 * its file is `grown` that much taller below its title row, and the card under it makes room. `kidsOf`
 * gives the tree to lay out, by default all of it.
 */
export function treeLayout(
  graph: Graph,
  collapsed: ReadonlySet<string>,
  open: ReadonlySet<string> = new Set(),
  grown: (id: string) => number = () => 0,
  kidsOf: (id: string | null) => SnapshotNode[] = graph.childrenOf,
): Layout {
  const folds = new Map<string, string[]>();
  const build = (parentId: string | null): TreeDatum[] => {
    const kids = kidsOf(parentId);
    const results =
      parentId && !open.has(parentId) ? kids.filter((c) => isResult(graph, c.id)) : [];
    if (parentId && results.length)
      folds.set(
        parentId,
        results.map((c) => c.id),
      );
    return kids
      .filter((c) => !results.includes(c))
      .map((n) => ({ id: n.id, children: collapsed.has(n.id) ? [] : build(n.id) }));
  };
  const root = hierarchy<TreeDatum>({ id: "__root", children: build(null) }, (d) => d.children);
  const branch = (d: HierarchyNode<TreeDatum>) => d.ancestors().at(-2)?.data.id;
  // A grown card keeps its title on its row and hangs its preview below, so only the card under it in the
  // same column makes room. Of two cards in one column, the upper one comes first in reading order.
  const order = new Map<HierarchyNode<TreeDatum>, number>();
  root.eachBefore((d) => order.set(d, order.size));
  const upper = (a: HierarchyNode<TreeDatum>, b: HierarchyNode<TreeDatum>) =>
    order.get(a)! < order.get(b)! ? a : b;
  tree<TreeDatum>()
    .nodeSize([ROW, COLUMN])
    .separation(
      (a, b) =>
        (a.parent === b.parent ? 1 : branch(a) === branch(b) ? 1.25 : 1.6) +
        grown(upper(a, b).data.id) / ROW,
    )(root);

  const placed = new Map<string, Placed>();
  root.each((d) => {
    if (d.data.id === "__root") return;
    const head = d.depth === 1 ? CARD.top : CARD.h;
    const more = grown(d.data.id);
    placed.set(d.data.id, {
      id: d.data.id,
      x: (d.y ?? 0) - COLUMN,
      y: d.x ?? 0,
      h: head + more,
      w: CARD.w,
      ...(more > 0 ? { head } : {}),
    });
  });
  for (const id of [...folds.keys()]) if (!placed.has(id) || collapsed.has(id)) folds.delete(id);
  return { placed, labels: [], folds };
}

/**
 * One Node and everything directly related to it: what it hangs from and what cites it on the left,
 * what hangs from it and what it cites on the right.
 */
export function lensLayout(graph: Graph, focusId: string, shown: (id: string) => boolean): Layout {
  const n = graph.nodes.get(focusId)!;
  const taken = new Set([focusId]);
  const pick = (ids: string[]) =>
    ids.filter((id) => {
      if (taken.has(id) || !graph.nodes.has(id) || !shown(id)) return false;
      taken.add(id);
      return true;
    });
  const parent = pick(n.parentId ? [n.parentId] : []);
  const children = pick(graph.childrenOf(focusId).map((c) => c.id));
  const outgoing = pick([
    ...n.links.flatMap((l) => (l.ref?.kind === "node" ? [l.ref.id] : [])),
    ...n.materials.flatMap((m) => (m.kind === "node" && m.id ? [m.id] : [])),
  ]);
  const incoming = pick(n.incoming.flatMap((i) => (i.from.kind === "node" ? [i.from.id] : [])));

  const placed = new Map<string, Placed>([
    [focusId, { id: focusId, x: 0, y: 0, h: CARD.h, w: CARD.w }],
  ]);
  const labels: Label[] = [];
  // Narrow enough to stay readable beside the details panel.
  const LABEL = 28,
    GAP = 26,
    SPAN = CARD.w + 64;
  const column = (x: number, groups: [string, string[]][]) => {
    const used = groups.filter(([, ids]) => ids.length);
    const height =
      used.reduce((h, [, ids]) => h + LABEL + ids.length * ROW, 0) + (used.length - 1) * GAP;
    let y = -height / 2;
    for (const [text, ids] of used) {
      labels.push({ id: `label:${text}`, text: `${text} ${ids.length}`, x, y });
      y += LABEL;
      for (const id of ids) {
        placed.set(id, { id, x, y: y + CARD.h / 2, h: CARD.h, w: CARD.w });
        y += ROW;
      }
      y += GAP;
    }
  };
  column(-SPAN, [
    [t.lens.parent, parent],
    [t.lens.incoming, incoming],
  ]);
  column(SPAN, [
    [t.lens.children, children],
    [t.lens.outgoing, outgoing],
  ]);
  return { placed, labels };
}
