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

/** Map coordinates to a tenth of a unit: finer than any screen shows, and the file stays small. */
const tenth = (n: number) => Math.round(n * 10) / 10;

/** Where the layout puts each card once the hand-placed ones stand where they were left. */
export function placeCards(layout: Layout, positions: Record<string, Pt>): Layout {
  if (!Object.keys(positions).some((id) => layout.placed.has(id))) return layout;
  const placed = new Map(layout.placed);
  for (const [id, [x, top]] of Object.entries(positions)) {
    const p = placed.get(id);
    if (p) placed.set(id, { ...p, x, y: top + (p.head ?? p.h) / 2 });
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

let made = 0;
export const newRegionId = () =>
  `region-${Date.now().toString(36)}${(made++ % 1296).toString(36).padStart(2, "0")}`;
