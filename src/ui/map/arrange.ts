// A mind map from the shown tree, positioned by @antv/hierarchy: its mindmap for the whole map, its
// compactBox for the tree inside a topic, read from left to right. Our own rules sit around it. Before:
// long lists and result outputs become ordinary items, and sides come from the default two-level view,
// so opening a branch never sends it across the centre. After: the side holding a clicked topic moves
// as one so that topic stays put, and the other side stays where it was. Topic positions are not stored.
import { compactBox, mindmap, type HierarchyData, type HierarchyOptions } from "@antv/hierarchy";
import type { SnapshotNode } from "../data/types.js";
import { rectOf, type Layout, type Placed, type Rect } from "./layout.js";

export const CENTRE = "@mind-centre";
export const MAX_ROWS = 12;
export const TOPIC = {
  centre: 40,
  first: 30,
  deeper: 25,
  gap: 24,
  branchGap: 32,
  rowGap: 6,
  rootGap: 22,
  /** Between a closed topic's title and the count at its fork. */
  fork: 4,
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
  /** The room past a title row, at its fork, for a closed topic's count and the Role faces on a topic. */
  forks: Map<string, Rect>;
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
  /** Measured title row: its icon, name and whatever marks it has. */
  measure?: (id: string, depth: number) => { w: number; h: number };
  /** Width of the count a closed topic shows at its fork, past the title row. */
  foldWidth?: (id: string) => number;
  /** Width of the Role faces a topic carries past its title row and count; lines leave after them. */
  handsWidth?: (id: string) => number;
  /** Width of a "n more" or "n outputs" item, as its words need. */
  summaryWidth?: (kind: Summary["kind"], count: number) => number;
  /** Pin this topic's title centre while its own side makes room. */
  anchor?: { id: string; at: Pt };
};
type Item = { id: string; summary?: Omit<Summary, "at" | "topic"> };
type Block = {
  item: Item;
  depth: number;
  w: number;
  /** Room taken at the fork by a closed topic's count and by Role faces. */
  room: number;
  head: number;
  h: number;
  height: number;
  kids: Block[];
};
/** One box as the layout sees it: the title row plus its fold count, and the gaps around it. */
type Datum = HierarchyData & {
  id: string;
  w: number;
  h: number;
  hgap: number;
  vgap: number;
  sep: number;
  side: Side;
  block?: Block;
  children: Datum[];
};
const datum = (d: HierarchyData) => d as Datum;
const LAYOUT: HierarchyOptions = {
  getId: (d) => datum(d).id,
  getWidth: (d) => datum(d).w,
  getHeight: (d) => datum(d).h,
  getHGap: (d) => datum(d).hgap,
  getVGap: (d) => datum(d).vgap,
  getChildren: (d) => datum(d).children,
  getSubTreeSep: (d) => datum(d).sep,
  getSide: (n) => (datum(n.data).side > 0 ? "right" : "left"),
  // The result is moved onto our centre afterwards.
  fixedRoot: false,
};
const size = (_id: string, depth: number) => ({
  w: depth === 0 ? 176 : depth === 1 ? 200 : 160,
  h: depth === 0 ? TOPIC.centre : depth === 1 ? TOPIC.first : TOPIC.deeper,
});
const stackHeight = (blocks: Block[], gap: number) =>
  blocks.reduce((sum, b) => sum + b.height, 0) + gap * Math.max(0, blocks.length - 1);

type Listing = Pick<ArrangeInput, "kidsOf" | "open" | "results" | "openOutputs">;
/** A parent's items as the map lists them: result outputs fold into one item unless opened, and past
 * twelve the rest go into "n more" unless the parent was opened in full. The default outline, which only
 * settles sides, folds every output and opens nothing. */
function itemsOf(
  { kidsOf, open = new Set(), results = () => [], openOutputs = new Set() }: Listing,
  id: string,
  baseline: boolean,
): { items: Item[]; away: string[] } {
  const all = kidsOf(id);
  const away = new Set(baseline || !openOutputs.has(id) ? results(id, all) : []);
  const items: Item[] = all.filter((n) => !away.has(n.id)).map((n) => ({ id: n.id }));
  if (away.size)
    items.push({
      id: `@outputs:${id}`,
      summary: { kind: "outputs", parent: id, ids: [...away], count: away.size },
    });
  if (items.length <= MAX_ROWS || (!baseline && open.has(id))) return { items, away: [...away] };
  const hidden = items.slice(MAX_ROWS - 1);
  return {
    items: [
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
    ],
    away: [...away],
  };
}

/** The topics a layout will show and their depth, the centre at 0, known before anything is measured. */
export function listed(
  input: Pick<ArrangeInput, "focus" | "closed"> & Listing,
): Map<string, number> {
  const { kidsOf, focus = null, closed } = input;
  const out = new Map<string, number>();
  if (focus) out.set(focus, 0);
  const walk = (items: Item[], depth: number) => {
    for (const item of items) {
      if (item.summary) continue;
      out.set(item.id, depth);
      if (!closed.has(item.id)) walk(itemsOf(input, item.id, false).items, depth + 1);
    }
  };
  if (!focus)
    walk(
      kidsOf(null).map((n) => ({ id: n.id })),
      1,
    );
  else if (!closed.has(focus)) walk(itemsOf(input, focus, false).items, 1);
  return out;
}

/** The tree line joins the final title underlines, including after a historical projection. Every
 * underline, the centre's base line too, is centred on the bottom of its title row; the line leaves from
 * the parent's end and both control points sit halfway across, so it is level at both ends. */
export function topicLine(from: Placed, to: Placed, side: Side, reach = 0): Line {
  const a = rectOf(from),
    b = rectOf(to);
  // Past the parent's title row by the room its faces take, so the line starts clear of them.
  const start: Pt = [side > 0 ? a.x + a.w + reach : a.x - reach, a.y + (from.head ?? from.h)];
  const end: Pt = [side > 0 ? b.x : b.x + b.w, b.y + (to.head ?? to.h)];
  const mid = (start[0] + end[0]) / 2;
  return {
    id: `${from.id}>${to.id}`,
    source: from.id,
    target: to.id,
    points: [start, [mid, start[1]], [mid, end[1]], end],
  };
}

/** A tree line drawn as a filled band that narrows from w0 to w1 along its curve. */
export function taper(points: readonly (readonly [number, number])[], w0: number, w1: number) {
  const [p0, p1, p2, p3] = points as [Pt, Pt, Pt, Pt];
  const left: string[] = [],
    right: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24,
      u = 1 - t;
    const at = (k: 0 | 1) =>
      u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k];
    const slope = (k: 0 | 1) =>
      3 * u * u * (p1[k] - p0[k]) + 6 * u * t * (p2[k] - p1[k]) + 3 * t * t * (p3[k] - p2[k]);
    const [x, y] = [at(0), at(1)],
      [dx, dy] = [slope(0), slope(1)];
    const half = (w0 + (w1 - w0) * t) / 2 / (Math.hypot(dx, dy) || 1);
    left.push(`${(x - dy * half).toFixed(2)},${(y + dx * half).toFixed(2)}`);
    right.push(`${(x + dy * half).toFixed(2)},${(y - dx * half).toFixed(2)}`);
  }
  return `M${left.join(" L")} L${right.reverse().join(" L")} Z`;
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
  foldWidth = () => 0,
  handsWidth = () => 0,
  summaryWidth = () => 112,
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
    const { items, away } = itemsOf({ kidsOf, open, results, openOutputs }, id, baseline);
    if (!baseline && away.length) folds.set(id, away);
    return items;
  };
  // A closed topic's count, then its faces. The default outline keeps neither, so sides never depend on them.
  const roomOf = (id: string, shut: boolean) => {
    const count = shut ? TOPIC.fork + foldWidth(id) : 0,
      hands = handsWidth(id);
    return count + (hands ? TOPIC.fork + hands : 0);
  };
  const block = (item: Item, depth: number, baseline: boolean): Block => {
    const row = item.summary
      ? { w: summaryWidth(item.summary.kind, item.summary.count), h: 24 }
      : measure(item.id, depth);
    const h = row.h + (baseline || item.summary ? 0 : grown(item.id));
    const hidden = item.summary || (baseline ? depth >= defaultDepth : closed.has(item.id));
    const kids = hidden
      ? []
      : children(item.id, baseline).map((c) => block(c, depth + 1, baseline));
    const shut = !baseline && !item.summary && closed.has(item.id) && kidsOf(item.id).length > 0;
    return {
      item,
      depth,
      w: row.w,
      room: baseline || item.summary ? 0 : roomOf(item.id, shut),
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
  // The whole map lists every top-level topic, with no "n more": the project's parts all show at once.
  const roots = focus ? (closed.has(focus) ? [] : children(focus, false)) : outline;
  const blocks = roots.map((n) => block(n, 1, false));
  // Only the whole map has two sides; inside a topic its children keep the left column's order on the right.
  const sideOf = (item: Item): Side =>
    focus ? 1 : (rootSide.get(item.summary?.ids[0] ?? item.id) ?? 1);
  // A narrow map uses a shorter centre-to-branch gap; resizing never changes sides.
  const centreGap = TOPIC.branchGap * Math.min(1, Math.max(0.6, aspect / 1.6));
  // Rows sit rowGap apart and first-level branches rootGap apart: the whole map keeps that between whole
  // branches, the compact tree inside a topic between first-level rows.
  const toDatum = (b: Block, side: Side): Datum => ({
    id: b.item.id,
    w: b.w + b.room,
    h: b.h,
    hgap: TOPIC.gap / 2,
    vgap: (focus && b.depth === 1 ? TOPIC.rootGap : TOPIC.rowGap) / 2,
    sep: b.depth === 1 ? (TOPIC.rootGap - TOPIC.rowGap) / 2 : 0,
    side,
    block: b,
    children: b.kids.map((k) => toDatum(k, side)),
  });
  // Clockwise: the right side from the top, then the left side from the bottom.
  // A topic entered keeps room for its faces past its title, where its lines then leave.
  const centreRoom = focus ? roomOf(focus, false) : 0;
  const tree: Datum = {
    id: centreId,
    w: centre.w + centreRoom,
    h: centreSize.h,
    hgap: centreGap - TOPIC.gap / 2,
    vgap: 0,
    sep: 0,
    side: 1,
    children: [
      ...blocks.filter((b) => sideOf(b.item) === 1).map((b) => toDatum(b, 1)),
      ...blocks
        .filter((b) => sideOf(b.item) === -1)
        .reverse()
        .map((b) => toDatum(b, -1)),
    ],
  };
  const root = focus
    ? compactBox(tree, { ...LAYOUT, direction: "LR" })
    : mindmap(tree, { ...LAYOUT, direction: "H" });

  // Onto our centre; a title row starts past the count a closed topic shows on its left.
  const shift: Pt = [
    centre.x - (root.x + root.hgap),
    centre.y - (root.y + root.vgap + centreSize.h / 2),
  ];
  type Row = { block: Block; side: Side; parent: string; branch: string; at: Placed };
  const rows: Row[] = [];
  const branchOf = new Map<string, string>();
  root.eachNode((n) => {
    if (n.depth === 0) return;
    const { block: b, side } = datum(n.data);
    const parent = n.parent!.id;
    const branch = n.depth === 1 ? n.id : branchOf.get(parent)!;
    branchOf.set(n.id, branch);
    rows.push({
      block: b!,
      side,
      parent,
      branch,
      at: {
        id: n.id,
        x: n.x + n.hgap + (side < 0 ? b!.room : 0) + shift[0],
        y: n.y + n.vgap + b!.head / 2 + shift[1],
        w: b!.w,
        h: b!.h,
        head: b!.head,
      },
    });
  });
  // A clicked topic stays put: its side moves as one, the other side and the centre stay.
  const pinned = anchor && rows.find((r) => !r.block.item.summary && r.at.id === anchor.id);
  if (pinned) {
    const [dx, dy] = [anchor.at[0] - pinned.at.x, anchor.at[1] - pinned.at.y];
    for (const r of rows)
      if (r.side === pinned.side) {
        r.at.x += dx;
        r.at.y += dy;
      }
    [pinned.at.x, pinned.at.y] = anchor.at;
  }
  const forks = new Map<string, Rect>();
  for (const r of rows) {
    if (!r.block.room) continue;
    const w = r.block.room - TOPIC.fork,
      y = r.at.y - r.block.head / 2;
    forks.set(r.at.id, {
      x: r.side > 0 ? r.at.x + r.at.w + TOPIC.fork : r.at.x - r.block.room,
      y,
      w,
      h: r.block.head,
    });
  }
  if (centreRoom)
    forks.set(centreId, {
      x: centre.x + centre.w + TOPIC.fork,
      y: centre.y - centreSize.h / 2,
      w: centreRoom - TOPIC.fork,
      h: centreSize.h,
    });
  const roomAt = new Map(rows.map((r) => [r.at.id, r.block.room] as const));
  roomAt.set(centreId, centreRoom);
  for (const r of rows) {
    const topic = { depth: r.block.depth, side: r.side, branch: r.branch };
    if (r.block.item.summary) summaries.push({ ...r.block.item.summary, at: r.at, topic });
    else {
      placed.set(r.at.id, r.at);
      topics.set(r.at.id, topic);
    }
  }
  for (const r of rows) {
    const from = r.parent === centreId ? centre : placed.get(r.parent)!;
    lines.push(topicLine(from, r.at, r.side, roomAt.get(r.parent) ?? 0));
  }
  return { placed, labels: [], folds, centre, topics, summaries, lines, forks };
}
