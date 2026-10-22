// The map's canvas file, `.tent/canvas.json`: where cards were put by hand, the regions round them, and the
// drawings. It is a projection of Tent for looking at and arranging, never Tent data: Agents do not read it.
// Changes wait in `Pending`, by id, and are laid over whatever the file holds when they are written, so a
// save from another page keeps everything this page did not touch. Rules: Tent Node
// "UI-图谱画模块依赖与状态", judge 2026-10-16.
import type { Pt } from "./drawings.js";
import type { Layout, Placed, Rect } from "./layout.js";
import { CARD, rectOf } from "./layout.js";

/** A region keeps only its shape, place and name; the cards in it are whichever stand inside it. */
export type Region = { id: string; name: string; box: [number, number, number, number] };
export type Drawing = { id: string; kind: string; [key: string]: unknown };

export type CanvasFile = {
  version: 2;
  /** Each moved card's top-left corner, in map units. */
  positions: Record<string, Pt>;
  regions: Region[];
  drawings: Drawing[];
};

export const emptyCanvas = (): CanvasFile => ({
  version: 2,
  positions: {},
  regions: [],
  drawings: [],
});

const isNum = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const isPt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && p.every(isNum);
const isRegion = (r: unknown): r is Region => {
  const g = r as Partial<Region> | null;
  return (
    !!g &&
    typeof g.id === "string" &&
    typeof g.name === "string" &&
    Array.isArray(g.box) &&
    g.box.length === 4 &&
    g.box.every(isNum) &&
    g.box[2] > 0 &&
    g.box[3] > 0
  );
};

/** The file as read, or an empty one; anything not shaped like this version is treated as empty. */
export function readCanvas(value: unknown): CanvasFile {
  const c = value as Partial<CanvasFile> | null;
  if (!c || c.version !== 2 || !Array.isArray(c.drawings)) return emptyCanvas();
  const positions: Record<string, Pt> = {};
  for (const [id, p] of Object.entries(c.positions ?? {})) if (isPt(p)) positions[id] = p;
  return {
    version: 2,
    positions,
    regions: Array.isArray(c.regions) ? c.regions.filter(isRegion) : [],
    drawings: c.drawings.filter(
      (d): d is Drawing => !!d && typeof d.id === "string" && typeof d.kind === "string",
    ),
  };
}

/** What this page changed and has not written yet, by id; null takes the entry out. */
export type Pending = {
  positions: Map<string, Pt | null>;
  regions: Map<string, Region | null>;
  drawings: Map<string, Drawing | null>;
};
export const noPending = (): Pending => ({
  positions: new Map(),
  regions: new Map(),
  drawings: new Map(),
});
export const hasPending = (p: Pending) => !!(p.positions.size || p.regions.size || p.drawings.size);

/** A list with the pending entries laid over it: changed ones keep their place, new ones go at the end. */
function over<T extends { id: string }>(list: readonly T[], pending: Map<string, T | null>): T[] {
  if (!pending.size) return [...list];
  const out: T[] = [];
  const left = new Map(pending);
  for (const item of list) {
    if (!left.has(item.id)) out.push(item);
    else {
      const next = left.get(item.id);
      left.delete(item.id);
      if (next) out.push(next);
    }
  }
  for (const next of left.values()) if (next) out.push(next);
  return out;
}

/** The file as it will be once this page's pending changes are written over `file`. */
export function withPending(file: CanvasFile, pending: Pending): CanvasFile {
  if (!hasPending(pending)) return file;
  const positions = { ...file.positions };
  for (const [id, p] of pending.positions)
    if (p) positions[id] = p;
    else delete positions[id];
  return {
    version: 2,
    positions,
    regions: over(file.regions, pending.regions),
    drawings: over(file.drawings, pending.drawings),
  };
}

/** The changes still pending once `sent` was written: entries changed again meanwhile stay. */
export function afterSave(pending: Pending, sent: Pending): Pending {
  const keep = <T>(now: Map<string, T>, then: Map<string, T>) =>
    new Map([...now].filter(([id, v]) => !then.has(id) || then.get(id) !== v));
  return {
    positions: keep(pending.positions, sent.positions),
    regions: keep(pending.regions, sent.regions),
    drawings: keep(pending.drawings, sent.drawings),
  };
}

/**
 * What turns `change` back on `file`: each entry it touches, as the file holds it now; null where the entry
 * is not there. Entries it does not touch are left out, so turning it back keeps them as they are then.
 */
export function inverseOf(file: CanvasFile, change: Pending): Pending {
  const back = noPending();
  for (const id of change.positions.keys()) back.positions.set(id, file.positions[id] ?? null);
  for (const id of change.regions.keys())
    back.regions.set(id, file.regions.find((r) => r.id === id) ?? null);
  for (const id of change.drawings.keys())
    back.drawings.set(id, file.drawings.find((d) => d.id === id) ?? null);
  return back;
}

/** Pending changes with `more` laid over them. */
export const laidOver = (p: Pending, more: Pending): Pending => ({
  positions: new Map([...p.positions, ...more.positions]),
  regions: new Map([...p.regions, ...more.regions]),
  drawings: new Map([...p.drawings, ...more.drawings]),
});

/** Map coordinates to a tenth of a unit: finer than any screen shows, and the file stays small. */
const tenth = (n: number) => Math.round(n * 10) / 10;

/** Where the layout puts each card once the hand-placed ones stand where they were left. */
export function placeCards(layout: Layout, positions: Record<string, Pt>): Layout {
  if (!Object.keys(positions).some((id) => layout.placed.has(id))) return layout;
  const placed = new Map(layout.placed);
  for (const [id, [x, top]] of Object.entries(positions)) {
    const p = placed.get(id);
    if (!p) continue;
    const y = top + (p.head ?? p.h) / 2;
    placed.set(id, { ...p, x, y });
    // What it carries keeps its place beside it.
    for (const c of layout.islands?.get(id) ?? []) {
      const q = placed.get(c)!;
      placed.set(c, { ...q, x: tenth(q.x + x - p.x), y: tenth(q.y + y - p.y) });
    }
  }
  return { ...layout, placed };
}

/** The top-left corner a card moved by `dx`, `dy` from `p` is kept at. */
export const cornerOf = (p: Placed, dx = 0, dy = 0): Pt => {
  const r = rectOf(p);
  return [tenth(r.x + dx), tenth(r.y + dy)];
};

export const boxRect = (r: Region): Rect => ({
  x: r.box[0],
  y: r.box[1],
  w: r.box[2],
  h: r.box[3],
});

/** Whether a card belongs to a region: its centre stands inside it. */
export const inside = (box: Rect, card: Rect) => {
  const cx = card.x + card.w / 2,
    cy = card.y + (card.head ?? card.h) / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
};

/** The region a card stands in: the last drawn wins where regions overlap. */
export function regionOf(regions: readonly Region[], card: Rect): Region | null {
  for (let i = regions.length - 1; i >= 0; i--)
    if (inside(boxRect(regions[i]), card)) return regions[i];
  return null;
}

/**
 * Each region's cards, in the order the layout holds them. Only cards `shown` lets through count, and
 * callers pass hand-placed cards only, so the tree reflowing never slips a card into a region.
 */
export function membersOf(
  regions: readonly Region[],
  layout: Layout,
  shown: (id: string) => boolean,
) {
  const out = new Map<string, string[]>(regions.map((r) => [r.id, []]));
  for (const p of layout.placed.values()) {
    if (!shown(p.id)) continue;
    const r = regionOf(regions, rectOf(p));
    if (r) out.get(r.id)!.push(p.id);
  }
  return out;
}

/**
 * Every hand-placed card a region holds, shown or not. A card hidden by the type switches or inside a folded
 * branch has no place in the layout, so its kept corner and the plain card size stand for it. Moving or
 * dissolving a region acts on these, so hidden cards go with it.
 */
export function heldBy(regions: readonly Region[], positions: Record<string, Pt>, layout: Layout) {
  const out = new Map<string, string[]>(regions.map((r) => [r.id, []]));
  for (const [id, [x, y]] of Object.entries(positions)) {
    const p = layout.placed.get(id);
    const r = regionOf(regions, p ? rectOf(p) : { x, y, w: CARD.w, h: CARD.h });
    if (r) out.get(r.id)!.push(id);
  }
  return out;
}

/** A kept corner moved by `dx`, `dy`. */
export const shifted = ([x, y]: Pt, dx: number, dy: number): Pt => [tenth(x + dx), tenth(y + dy)];

/** Room round the cards inside a region, and above them for its title. */
export const REGION_PAD = { side: 24, top: 48, bottom: 24 };

/** A region box grown, never shrunk, to hold `cards` with room round them. */
export function fitBox(box: Region["box"] | null, cards: Rect[]): Region["box"] {
  const xs = cards.flatMap((c) => [c.x - REGION_PAD.side, c.x + c.w + REGION_PAD.side]);
  const ys = cards.flatMap((c) => [c.y - REGION_PAD.top, c.y + c.h + REGION_PAD.bottom]);
  if (box) (xs.push(box[0], box[0] + box[2]), ys.push(box[1], box[1] + box[3]));
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return [tenth(x), tenth(y), tenth(Math.max(...xs) - x), tenth(Math.max(...ys) - y)];
}

/** Room kept between a dropped card and the cards it is moved clear of. */
export const CLEAR = 12;
/** More room a card placed on its own keeps on its left, where its line comes in, to turn into it. */
const ENTRY = 24;

/** Whether `r` lies wholly inside `box`. */
export const within = (r: Rect, box: Rect) =>
  r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h;

const overlaps = (a: Rect, b: Rect, m: number) =>
  a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/**
 * How far cards dropped at `rects` move to stand clear of `others`: nowhere when nothing is under them,
 * else the shortest move that puts each just beside a card it would meet, all of them together. Only the
 * dropped cards move; the others keep their places.
 */
export function clearOf(rects: Rect[], others: Rect[], m = CLEAR): [number, number] {
  return seek(rects, others, m) ?? [0, 0];
}

/** Like clearOf, but only moves that keep the cards inside `box`; none when there is no room there. */
export function clearWithin(
  rects: Rect[],
  others: Rect[],
  box: Rect,
  m = CLEAR,
): [number, number] | null {
  return seek(rects, others, m, box);
}

function seek(rects: Rect[], others: Rect[], m: number, inside?: Rect): [number, number] | null {
  // Asked many times a drop, so it reads the numbers straight rather than building moved rectangles.
  const hits = (dx: number, dy: number, among = others) => {
    for (const r of rects) {
      if (inside && !within({ ...r, x: r.x + dx, y: r.y + dy }, inside)) return true;
      const x = r.x + dx - m,
        y = r.y + dy - m,
        x2 = r.x + r.w + dx + m,
        y2 = r.y + r.h + dy + m;
      for (const o of among)
        if (x < o.x + o.w && o.x < x2 && y < o.y + o.h && o.y < y2) return true;
    }
    return false;
  };
  if (!rects.length || !hits(0, 0)) return [0, 0];
  const xs = rects.flatMap((r) => [r.x, r.x + r.w]),
    ys = rects.flatMap((r) => [r.y, r.y + r.h]);
  const box = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  // Look round the drop as far as the cards are big, and further each time nothing there is clear.
  // Inside a box, no move longer than the box is worth a look.
  const far = inside ? Math.max(inside.w, inside.h) + Math.max(box.w, box.h) : 1e5;
  for (let reach = Math.max(box.w, box.h) + 400; reach < 2 * far; reach *= 2) {
    const near = others.filter((o) =>
      overlaps(
        o,
        { x: box.x - reach, y: box.y - reach, w: box.w + 2 * reach, h: box.h + 2 * reach },
        m,
      ),
    );
    // The moves that put the cards, taken as one box, just beside a card near them: a few hundred to
    // try however many cards go together.
    const dxs = new Set([0]),
      dys = new Set([0]);
    for (const o of near) {
      dxs.add(o.x - m - (box.x + box.w));
      dxs.add(o.x + o.w + m - box.x);
      dys.add(o.y - m - (box.y + box.h));
      dys.add(o.y + o.h + m - box.y);
    }
    // A move within reach can meet only the cards near the drop. The shortest clear move straight
    // across or down bounds the rest: only moves both ways shorter than it are worth trying.
    const by = (a: readonly number[], b: readonly number[]) => a[2] - b[2];
    const straight = [
      ...[...dxs].map((dx) => [dx, 0, Math.abs(dx)] as const),
      ...[...dys].map((dy) => [0, dy, Math.abs(dy)] as const),
    ]
      .filter((v) => v[2] <= reach)
      .sort(by)
      .find(([dx, dy]) => !hits(dx, dy, near));
    const bound = straight ? straight[2] : reach;
    const xs = [...dxs].filter((dx) => dx && Math.abs(dx) < bound),
      ys = [...dys].filter((dy) => dy && Math.abs(dy) < bound);
    const both = xs
      .flatMap((dx) => ys.map((dy) => [dx, dy, Math.hypot(dx, dy)] as const))
      .filter((v) => v[2] < bound)
      .sort(by)
      .find(([dx, dy]) => !hits(dx, dy, near));
    const best = both ?? straight;
    if (best) return [tenth(best[0]), tenth(best[1])];
  }
  if (inside) return null;
  return [0, tenth(Math.max(...others.map((o) => o.y + o.h)) + m - box.y)];
}

/**
 * The layout with nothing on top of anything (judge 2026-10-21): cards placed by hand (`fixed`) are
 * obstacles, and only the cards that meet something move. A card carrying cards stands as the box round
 * all of them; the trees go first, largest first, each clear of the trees before it. A card on its own then
 * stands clear of every card and of the trees other than its own (`upOf` says whose), with room on its left
 * for its line to turn in, so dropping one moves nothing but itself, and no tree combs into another or over
 * a card kept apart from it. One that meets what stood before steps to the nearest clear spot with what it
 * carries, for the view only. The cards in `keep` step aside inside its box when there is room there.
 * Where laid-out cards meet one, the tree opens a band under its top: every laid-out card from the first
 * one it meets down moves below it, so the tree keeps its order and its columns.
 */
export function standClear(
  layout: Layout,
  fixed: ReadonlySet<string>,
  upOf: (id: string) => string | null = () => null,
  keep?: { ids: ReadonlySet<string>; box: Rect },
  m = CLEAR,
): Layout {
  const ids = [...fixed].filter((id) => layout.placed.has(id)).sort();
  if (!ids.length) return layout;
  const placed = new Map(layout.placed);
  const moveBy = (id: string, dx: number, dy: number) => {
    const p = placed.get(id)!;
    placed.set(id, { ...p, x: tenth(p.x + dx), y: tenth(p.y + dy) });
  };
  const hull = (rs: Rect[]): Rect => {
    const x = Math.min(...rs.map((r) => r.x)),
      y = Math.min(...rs.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...rs.map((r) => r.x + r.w)) - x,
      h: Math.max(...rs.map((r) => r.y + r.h)) - y,
    };
  };
  const entry = (r: Rect): Rect => ({ ...r, x: r.x - ENTRY, w: r.w + ENTRY });
  // Kept cards look for room inside the box first, and go wherever is nearest only when there is none.
  const clear = (unit: string[], rs: Rect[], among: Rect[]): [number, number] => {
    if (!keep || !unit.some((u) => keep.ids.has(u))) return clearOf(rs, among, m);
    return clearWithin(rs, among, keep.box, m) ?? clearOf(rs, among, m);
  };
  const under = (id: string, top: string) => {
    for (let up = upOf(id); up; up = upOf(up)) if (up === top) return true;
    return false;
  };
  const trees = ids
    .filter((id) => layout.islands?.has(id))
    .map((id) => [id, ...layout.islands!.get(id)!])
    .sort((a, b) => b.length - a.length);
  // What stands so far: each tree as its box under its card, each card on its own with its way in; and
  // every card.
  const boxes: { top: string; box: Rect; cards: Rect[] }[] = [];
  const settled: Rect[] = [];
  const cards: Rect[] = [];
  const held = new Set<string>();
  const stand = (unit: string[], dx: number, dy: number, box: boolean) => {
    for (const u of unit) {
      if (dx || dy) moveBy(u, dx, dy);
      held.add(u);
    }
    const now = unit.map((u) => rectOf(placed.get(u)!));
    if (box) boxes.push({ top: unit[0], box: hull(now), cards: now });
    else cards.push(...now);
    settled.push(box ? hull(now) : entry(now[0]));
  };
  for (const unit of trees) {
    const [dx, dy] = clear(
      unit,
      [hull(unit.map((u) => rectOf(placed.get(u)!)))],
      boxes.map((b) => b.box),
    );
    stand(unit, dx, dy, true);
  }
  for (const id of ids) {
    if (held.has(id)) continue;
    // Another tree is its box; its own tree, and the cards on their own, are each a card.
    const around = boxes.flatMap((b) => (under(id, b.top) ? b.cards : [b.box]));
    const [dx, dy] = clear([id], [entry(rectOf(placed.get(id)!))], [...around, ...cards]);
    stand([id], dx, dy, false);
  }
  const auto = [...placed.keys()].filter((id) => !held.has(id));
  for (const f of [...settled].sort((a, b) => a.y - b.y)) {
    const tops = auto
      .map((id) => rectOf(placed.get(id)!))
      .filter((r) => overlaps(r, f, m))
      .map((r) => r.y);
    if (!tops.length) continue;
    const cut = Math.min(...tops);
    const dy = f.y + f.h + m - cut;
    for (const id of auto) if (rectOf(placed.get(id)!).y >= cut - 0.5) moveBy(id, 0, dy);
  }
  return { ...layout, placed };
}

/**
 * How far a card being dragged to `r` slides to line up with the cards near it, each way on its own: its
 * left edge with theirs, its title row's middle with theirs, within `within` map units.
 */
export function snapTo(r: Rect, others: Rect[], within: number): [number, number] {
  const mid = (q: Rect) => q.y + (q.head ?? q.h) / 2;
  let sx = 0,
    sy = 0,
    bx = within,
    by = within;
  // Only cards that could be read as one column or one row with it count.
  const span = 8 * r.w;
  for (const o of others) {
    const ax = o.x - r.x,
      ay = mid(o) - mid(r);
    if (Math.abs(ax) < bx && Math.abs(ay) < span) ((bx = Math.abs(ax)), (sx = ax));
    if (Math.abs(ay) < by && Math.abs(ax) < span) ((by = Math.abs(ay)), (sy = ay));
  }
  return [sx, sy];
}

let made = 0;
export const newRegionId = () =>
  `region-${Date.now().toString(36)}${(made++ % 1296).toString(36).padStart(2, "0")}`;
