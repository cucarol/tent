import { hierarchy, tree, type HierarchyNode } from "d3-hierarchy";
import { primaryOf, type Graph } from "../data/store.js";
import { t } from "../i18n.js";

// One line per card, wide enough for a bold name of eight Chinese characters, its tag and three Role faces;
// a top-level card stands a little taller, as the head of its group.
export const CARD = { w: 264, h: 38, top: 44 };
// The gap between columns holds the elbow of the links; tree links turn halfway across it.
export const GAP = 56;
const COLUMN = CARD.w + GAP;
// Rows leave a gap wide enough for a reference line to pass between two cards.
const ROW = CARD.h + 14;

/** Position of a card's left-centre point, its height and width. */
export type Placed = { id: string; x: number; y: number; h: number; w: number };
export type Label = { id: string; text: string; x: number; y: number };
export type Layout = {
  placed: Map<string, Placed>;
  labels: Label[];
  /** In the tree, the result outputs folded into each card's count. */
  folds?: Map<string, string[]>;
};
export type Rect = { x: number; y: number; w: number; h: number };

export const rectOf = (p: Placed): Rect => ({ x: p.x, y: p.y - p.h / 2, w: p.w, h: p.h });

/** An output with nothing under it is a result rather than structure. */
export const isResult = (graph: Graph, id: string) => {
  const n = graph.nodes.get(id);
  return !!n && primaryOf(n.type) === "output" && graph.childrenOf(id).length === 0;
};

type TreeDatum = { id: string; children: TreeDatum[] };

/**
 * The folder hierarchy read left to right. Top-level branches get extra room so each reads as one group.
 * A card's result outputs fold into a count on it unless its id is in `open`.
 */
export function treeLayout(
  graph: Graph,
  collapsed: ReadonlySet<string>,
  open: ReadonlySet<string> = new Set(),
): Layout {
  const folds = new Map<string, string[]>();
  const build = (parentId: string | null): TreeDatum[] => {
    const kids = graph.childrenOf(parentId);
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
  tree<TreeDatum>()
    .nodeSize([ROW, COLUMN])
    .separation((a, b) => (a.parent === b.parent ? 1 : branch(a) === branch(b) ? 1.25 : 1.6))(root);

  const placed = new Map<string, Placed>();
  root.each((d) => {
    if (d.data.id !== "__root")
      placed.set(d.data.id, {
        id: d.data.id,
        x: (d.y ?? 0) - COLUMN,
        y: d.x ?? 0,
        h: d.depth === 1 ? CARD.top : CARD.h,
        w: CARD.w,
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
