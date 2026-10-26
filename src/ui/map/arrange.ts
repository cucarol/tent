// A mind map from the shown tree. Sides are chosen from the default two-level view;
// opening a branch never sends it across the centre. Topic positions are not stored.
import type { SnapshotNode } from "../data/types.js";
import { rectOf, type Layout, type Placed } from "./layout.js";

export const CENTRE = "@mind-centre";
export const MAX_ROWS = 12;
export const TOPIC = {
  centre: 52,
  first: 30,
  deeper: 25,
  gap: 24,
  branchGap: 32,
  rowGap: 6,
  rootGap: 22,
};
export type Pt = [number, number];
export type Side = -1 | 1;
export type Topic = { depth: number; side: Side; branch: string };
/** Four control points, from the parent's underline to the child's. */
export type Line = { id: string; source: string; target: string; points: Pt[] };
export type Summary = {
  kind: "more" | "outputs";
  parent: string;
  ids: string[];
  count: number;
  at: Placed;
  topic: Topic;
};
export type Arranged = Layout & {
  centre: Placed;
  topics: Map<string, Topic>;
  summaries: Summary[];
  lines: Line[];
};
export type ArrangeInput = {
  kidsOf: (id: string | null) => SnapshotNode[];
  focus?: string | null;
  aspect?: number;
  defaultDepth?: number;
  closed: ReadonlySet<string>;
  /** Explicitly opened parents also show lists longer than twelve in full. */
  open?: ReadonlySet<string>;
  results?: (id: string, kids: SnapshotNode[]) => string[];
  openOutputs?: ReadonlySet<string>;
  grown?: (id: string) => number;
  /** Measured title row including icons, counts and controls. */
  measure?: (id: string, depth: number) => { w: number; h: number };
  /** Pin this topic's title centre while its own side makes room. */
  anchor?: { id: string; at: Pt };
};
type Item = { id: string; summary?: Omit<Summary, "at" | "topic"> };
type Block = {
  item: Item;
  depth: number;
  w: number;
  head: number;
  h: number;
  height: number;
  kids: Block[];
};
const size = (_id: string, depth: number) => ({
  w: depth === 0 ? 176 : depth === 1 ? 200 : 160,
  h: depth === 0 ? TOPIC.centre : depth === 1 ? TOPIC.first : TOPIC.deeper,
});
const stackHeight = (blocks: Block[], gap: number) =>
  blocks.reduce((sum, b) => sum + b.height, 0) + gap * Math.max(0, blocks.length - 1);

/** The tree line joins the final title underlines, including after a historical projection. */
export function topicLine(from: Placed, to: Placed, side: Side, central: boolean): Line {
  const a = rectOf(from),
    b = rectOf(to);
  const start: Pt = [side > 0 ? a.x + a.w : a.x, central ? from.y : a.y + (from.head ?? from.h)];
  const end: Pt = [side > 0 ? b.x : b.x + b.w, b.y + (to.head ?? to.h)];
  const dx = end[0] - start[0];
  return {
    id: `${from.id}>${to.id}`,
    source: from.id,
    target: to.id,
    points: [start, [start[0] + dx * 0.55, start[1]], [start[0] + dx * 0.45, end[1]], end],
  };
}

export function arrange({
  kidsOf,
  focus = null,
  aspect = 1.6,
  defaultDepth = 2,
  closed,
  open = new Set(),
  results = () => [],
  openOutputs = new Set(),
  grown = () => 0,
  measure: measureInput = size,
  anchor,
}: ArrangeInput): Arranged {
  const measured = new Map<string, { w: number; h: number }>();
  const measure = (id: string, depth: number) => {
    const key = `${depth}:${id}`;
    let row = measured.get(key);
    if (!row) {
      row = measureInput(id, depth);
      measured.set(key, row);
    }
    return row;
  };
  const placed = new Map<string, Placed>();
  const topics = new Map<string, Topic>();
  const folds = new Map<string, string[]>();
  const summaries: Summary[] = [];
  const lines: Line[] = [];
  const centreId = focus ?? CENTRE;
  const centreSize = measure(centreId, 0);
  const centre: Placed = {
    id: centreId,
    x: -centreSize.w / 2,
    y: 0,
    w: centreSize.w,
    head: centreSize.h,
    h: centreSize.h + (focus ? grown(focus) : 0),
  };
  if (focus) {
    placed.set(focus, centre);
    topics.set(focus, { depth: 0, side: 1, branch: focus });
  }

  const children = (id: string, baseline: boolean): Item[] => {
    const all = kidsOf(id);
    const away = new Set(baseline || !openOutputs.has(id) ? results(id, all) : []);
    if (!baseline && away.size) folds.set(id, [...away]);
    const items: Item[] = all.filter((n) => !away.has(n.id)).map((n) => ({ id: n.id }));
    if (away.size)
      items.push({
        id: `@outputs:${id}`,
        summary: { kind: "outputs", parent: id, ids: [...away], count: away.size },
      });
    if (items.length <= MAX_ROWS || (!baseline && open.has(id))) return items;
    const hidden = items.slice(MAX_ROWS - 1);
    return [
      ...items.slice(0, MAX_ROWS - 1),
      {
        id: `@more:${id}`,
        summary: {
          kind: "more",
          parent: id,
          ids: hidden.flatMap((item) => item.summary?.ids ?? [item.id]),
          count: hidden.length,
        },
      },
    ];
  };
  const block = (item: Item, depth: number, baseline: boolean): Block => {
    const row = item.summary ? { w: 112, h: 24 } : measure(item.id, depth);
    const h = row.h + (baseline || item.summary ? 0 : grown(item.id));
    const hidden = item.summary || (baseline ? depth >= defaultDepth : closed.has(item.id));
    const kids = hidden
      ? []
      : children(item.id, baseline).map((c) => block(c, depth + 1, baseline));
    return {
      item,
      depth,
      w: row.w,
      head: row.h,
      h,
      kids,
      height: Math.max(h, stackHeight(kids, TOPIC.rowGap)),
    };
  };
  // Split the full default outline, independent of collapsed lists and result summaries.
  const outline = kidsOf(focus).map((n) => ({ id: n.id }));
  const baseline = outline.map((n) => block(n, 1, true));
  const total = stackHeight(baseline, TOPIC.rootGap);
  let cut = outline.length;
  if (outline.length > 1) {
    let used = 0,
      miss = Infinity;
    for (let i = 1; i < outline.length; i++) {
      used += baseline[i - 1]!.height + (i > 1 ? TOPIC.rootGap : 0);
      const other = total - used - TOPIC.rootGap;
      if (Math.abs(used - other) < miss) {
        miss = Math.abs(used - other);
        cut = i;
      }
    }
  }
  const rootSide = new Map(outline.map((n, i) => [n.id, i < cut ? 1 : -1] as const));
  const roots = focus ? (closed.has(focus) ? [] : children(focus, false)) : outline;
  const defaults = focus ? roots.map((n) => block(n, 1, true)) : baseline;
  const blocks = roots.map((n) => block(n, 1, false));
  const sideOf = (item: Item) => rootSide.get(item.summary?.ids[0] ?? item.id) ?? 1;
  // A narrow map uses a shorter centre-to-branch gap; resizing never changes sides.
  const centreGap = TOPIC.branchGap * Math.min(1, Math.max(0.6, aspect / 1.6));
  const connect = (from: Placed, to: Placed, side: Side, central: boolean) => {
    lines.push(topicLine(from, to, side, central));
  };
  const place = (b: Block, x: number, y: number, side: Side, branch: string, parent: Placed) => {
    const at: Placed = {
      id: b.item.id,
      x: side > 0 ? x : x - b.w,
      y,
      w: b.w,
      h: b.h,
      head: b.head,
    };
    const topic = { depth: b.depth, side, branch };
    if (b.item.summary) summaries.push({ ...b.item.summary, at, topic });
    else {
      placed.set(b.item.id, at);
      topics.set(b.item.id, topic);
    }
    connect(parent, at, side, parent.id === centreId);
    let cy = y + (b.h - b.head) / 2 - stackHeight(b.kids, TOPIC.rowGap) / 2;
    for (const child of b.kids) {
      place(
        child,
        side > 0 ? at.x + at.w + TOPIC.gap : at.x - TOPIC.gap,
        cy + child.height / 2 - (child.h - child.head) / 2,
        side,
        branch,
        at,
      );
      cy += child.height + TOPIC.rowGap;
    }
  };
  const localY = (b: Block, id: string, y = 0): number | undefined => {
    if (b.item.id === id) return y;
    let cy = y + (b.h - b.head) / 2 - stackHeight(b.kids, TOPIC.rowGap) / 2;
    for (const child of b.kids) {
      const found = localY(child, id, cy + child.height / 2 - (child.h - child.head) / 2);
      if (found !== undefined) return found;
      cy += child.height + TOPIC.rowGap;
    }
    return undefined;
  };
  const side = (indexes: number[], dir: Side) => {
    const base = indexes.map((i) => defaults[i]!);
    let y = -stackHeight(base, TOPIC.rootGap) / 2;
    const centres = base.map((b) => {
      const at = y + b.height / 2;
      y += b.height + TOPIC.rootGap;
      return at;
    });
    let fixed = -1;
    if (anchor)
      for (let j = 0; j < indexes.length; j++) {
        const b = blocks[indexes[j]!]!;
        const dy = localY(b, anchor.id);
        if (dy !== undefined) {
          fixed = j;
          centres[j] = anchor.at[1] - dy + (b.h - b.head) / 2;
          break;
        }
      }
    const top = (j: number) => centres[j]! - blocks[indexes[j]!]!.height / 2;
    const bottom = (j: number) => centres[j]! + blocks[indexes[j]!]!.height / 2;
    for (let j = (fixed < 0 ? 0 : fixed) + 1; j < indexes.length; j++)
      centres[j] = Math.max(
        centres[j]!,
        bottom(j - 1) + TOPIC.rootGap + blocks[indexes[j]!]!.height / 2,
      );
    for (let j = fixed - 1; j >= 0; j--)
      centres[j] = Math.min(
        centres[j]!,
        top(j + 1) - TOPIC.rootGap - blocks[indexes[j]!]!.height / 2,
      );
    for (let j = 0; j < indexes.length; j++) {
      const b = blocks[indexes[j]!]!;
      place(
        b,
        dir * (centre.w / 2 + centreGap),
        centres[j]! - (b.h - b.head) / 2,
        dir,
        b.item.id,
        centre,
      );
    }
  };
  side(
    blocks.flatMap((b, i) => (sideOf(b.item) === 1 ? [i] : [])),
    1,
  );
  side(blocks.flatMap((b, i) => (sideOf(b.item) === -1 ? [i] : [])).reverse(), -1);
  return { placed, labels: [], folds, centre, topics, summaries, lines };
}
