import type { Rect } from "./layout.js";

/**
 * References drawn as right-angled lines that keep clear of every card. A line leaves the side of its card
 * that faces the target (within one column, both on the side the link says, the right by default), runs
 * through the gaps between columns and between cards, and ends in an arrow on the target's side. The middle of
 * a card's side is left to the tree's lines: references attach above or below it, towards their other end.
 * Lines sharing a gap are spread apart, and so are lines sharing a card side.
 *
 * The search runs on a sparse grid: lines just outside every card's edges, two lanes in each gap between
 * columns (a stub's length from either side, clear of the tree's trunk halfway across), and the ends of each
 * link. A turn costs as much as BEND pixels of length, so routes stay simple rather than merely short, and
 * running along a card's edge costs HUG times its length, so lines travel in the lanes instead.
 */
/** `loop` picks the side a link within one column goes round on: -1 left, 1 right (the default). */
export type RefLink = { id: string; from: Rect; to: Rect; loop?: -1 | 1 };
/** The line as SVG path and arrow, and the corners it turns at, ends included. */
export type Route = { path: string; arrow: string; points: Pt[] };

/** Clearance kept around cards; half the gap between two stacked cards, so a line can pass between them. */
const M = 7;
/** Straight run out of a card's side before the first turn. */
const STUB = 20;
const BEND = 36;
const HUG = 3;
/** Spacing between lines that share a card side or a gap. */
const SPREAD = 6;
const NUDGE = 4;
const ARROW = 7;

export type Pt = { x: number; y: number };
type End = {
  link: RefLink;
  start: boolean;
  x: number;
  y: number;
  h: number;
  dir: 1 | -1;
  far: number;
};

/** Which sides a link uses: the ones facing each other, or the same side of both within one column. */
function sidesOf(a: Rect, b: Rect, loop: -1 | 1) {
  if (b.x >= a.x + a.w + 24) return { sx: a.x + a.w, out: 1 as const, tx: b.x, arrive: 1 as const };
  if (b.x + b.w + 24 <= a.x)
    return { sx: a.x, out: -1 as const, tx: b.x + b.w, arrive: -1 as const };
  return loop === 1
    ? { sx: a.x + a.w, out: 1 as const, tx: b.x + b.w, arrive: -1 as const }
    : { sx: a.x, out: -1 as const, tx: b.x, arrive: 1 as const };
}
/** How far from the middle of a side references attach, and how far apart. */
const OFF = 8;

const cy = (r: Rect) => r.y + r.h / 2;
const round = (v: number) => Math.round(v * 2) / 2;

export function routeLinks(obstacles: Rect[], links: RefLink[]): Map<string, Route> {
  const out = new Map<string, Route>();
  if (!links.length) return out;

  // Ends on the same card side fan out along it, above or below its middle towards their other end.
  const ends: End[] = [];
  for (const link of links) {
    const s = sidesOf(link.from, link.to, link.loop ?? 1);
    const { from, to } = link;
    ends.push({ link, start: true, x: s.sx, y: cy(from), h: from.h, dir: s.out, far: cy(to) });
    ends.push({
      link,
      start: false,
      x: s.tx,
      y: cy(to),
      h: to.h,
      dir: -s.arrive as 1 | -1,
      far: cy(from),
    });
  }
  const bySide = new Map<string, End[]>();
  for (const e of ends) {
    const key = `${round(e.x)}:${round(e.y)}`;
    bySide.set(key, [...(bySide.get(key) ?? []), e]);
  }
  for (const group of bySide.values()) {
    const mid = group[0]!.y,
      room = group[0]!.h / 2 - 4;
    const up = group.filter((e) => e.far < mid).sort((a, b) => a.far - b.far);
    const down = group.filter((e) => e.far >= mid).sort((a, b) => a.far - b.far);
    // A crowded half packs its lines closer rather than stacking them.
    const gap = (n: number) => (n > 1 ? Math.min(SPREAD, (room - OFF) / (n - 1)) : 0);
    // Use the grid's precision so even tightly packed ends leave their sides horizontally.
    up.forEach((e, i) => (e.y = round(mid - OFF - (up.length - 1 - i) * gap(up.length))));
    down.forEach((e, i) => (e.y = round(mid + OFF + i * gap(down.length))));
  }
  const endOf = (link: RefLink, start: boolean) =>
    ends.find((e) => e.link === link && e.start === start)!;

  const grid = buildGrid(
    obstacles,
    ends.map((e) => e.x + e.dir * STUB),
    ends.map((e) => e.y),
  );
  const routes: { link: RefLink; points: Pt[] }[] = [];
  for (const link of links) {
    const a = endOf(link, true),
      b = endOf(link, false);
    const from = { x: a.x + a.dir * STUB, y: a.y },
      to = { x: b.x + b.dir * STUB, y: b.y };
    const middle = search(grid, from, a.dir === 1 ? 0 : 1, to, b.dir === 1 ? 1 : 0);
    if (!middle) continue;
    routes.push({ link, points: simplify([{ x: a.x, y: a.y }, ...middle, { x: b.x, y: b.y }]) });
  }
  nudge(routes.map((r) => r.points));
  for (const { link, points } of routes) out.set(link.id, draw(points));
  return out;
}

// ---------- grid ----------

type Grid = {
  xs: number[];
  ys: number[];
  /** Per horizontal line, the x ranges cards block; per vertical line, the y ranges. */
  rowBlocks: [number, number][][];
  colBlocks: [number, number][][];
  /** Vertical lines that run just along a card's side. */
  hug: boolean[];
};

function buildGrid(obstacles: Rect[], extraX: number[], extraY: number[]): Grid {
  const xs = new Set<number>(extraX.map(round)),
    ys = new Set<number>(extraY.map(round));
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  const margins = new Set<number>();
  for (const r of obstacles) {
    margins.add(round(r.x - M));
    margins.add(round(r.x + r.w + M));
    ys.add(round(r.y - M));
    ys.add(round(r.y + r.h + M));
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  margins.forEach((x) => xs.add(x));
  // Two lanes in each gap between columns, a stub's length in from either side: the tree's trunk runs halfway.
  const lanes = new Set<number>();
  const lefts = [...new Set(obstacles.map((r) => r.x))].sort((a, b) => a - b);
  for (const right of new Set(obstacles.map((r) => r.x + r.w))) {
    const next = lefts.find((l) => l > right + 2 * STUB + 8);
    if (next === undefined) continue;
    lanes.add(round(right + STUB));
    lanes.add(round(next - STUB));
  }
  lanes.forEach((x) => xs.add(x));
  for (const e of extraX) {
    x1 = Math.min(x1, e);
    x2 = Math.max(x2, e);
  }
  for (const e of extraY) {
    y1 = Math.min(y1, e);
    y2 = Math.max(y2, e);
  }
  // A way round everything.
  xs.add(round(x1 - 32));
  xs.add(round(x2 + 32));
  ys.add(round(y1 - 32));
  ys.add(round(y2 + 32));

  const X = [...xs].sort((a, b) => a - b),
    Y = [...ys].sort((a, b) => a - b);
  const rowBlocks = Y.map((y) =>
    obstacles
      .filter((r) => r.y - M < y - 0.1 && y + 0.1 < r.y + r.h + M)
      .map((r) => [r.x - M, r.x + r.w + M] as [number, number]),
  );
  const colBlocks = X.map((x) =>
    obstacles
      .filter((r) => r.x - M < x - 0.1 && x + 0.1 < r.x + r.w + M)
      .map((r) => [r.y - M, r.y + r.h + M] as [number, number]),
  );
  const hug = X.map((x) => margins.has(x) && !lanes.has(x));
  return { xs: X, ys: Y, rowBlocks, colBlocks, hug };
}

const clear = (blocks: [number, number][], a: number, b: number) => {
  const lo = Math.min(a, b),
    hi = Math.max(a, b);
  return !blocks.some(([s, e]) => s < hi - 0.1 && e > lo + 0.1);
};
const free = (blocks: [number, number][], v: number) =>
  !blocks.some(([s, e]) => s < v - 0.1 && v + 0.1 < e);

// ---------- search ----------

// Directions: 0 east, 1 west, 2 south, 3 north.
const DX = [1, -1, 0, 0],
  DY = [0, 0, 1, -1];

/**
 * Cheapest path from `from`, leaving in direction `startDir`, to `to`, arriving in direction `endDir`.
 * Both points are on the grid. Returns the grid points passed, `from` and `to` included.
 */
function search(grid: Grid, from: Pt, startDir: number, to: Pt, endDir: number): Pt[] | null {
  const { xs, ys, rowBlocks, colBlocks, hug } = grid;
  const W = xs.length;
  const fi = xs.indexOf(round(from.x)),
    fj = ys.indexOf(round(from.y));
  const ti = xs.indexOf(round(to.x)),
    tj = ys.indexOf(round(to.y));
  if (fi < 0 || fj < 0 || ti < 0 || tj < 0) return null;
  const key = (i: number, j: number, d: number) => ((j * W + i) << 2) | d;
  const cost = new Map<number, number>();
  const back = new Map<number, number>();
  const heap = new Heap();
  const h = (i: number, j: number) => Math.abs(xs[i]! - to.x) + Math.abs(ys[j]! - to.y);
  const startKey = key(fi, fj, startDir);
  cost.set(startKey, 0);
  heap.push(startKey, h(fi, fj));
  // Arriving across the target's side still works, one turn dearer; the best arrival wins.
  let done: { key: number; cost: number } | null = null;
  while (heap.size && (!done || heap.peek() < done.cost)) {
    const k = heap.pop();
    const d = k & 3,
      p = k >> 2,
      i = p % W,
      j = (p - i) / W;
    const c = cost.get(k)!;
    if (i === ti && j === tj) {
      const total = c + (d === endDir ? 0 : d >> 1 === endDir >> 1 ? 2 * BEND : BEND);
      if (!done || total < done.cost) done = { key: k, cost: total };
      continue;
    }
    for (let nd = 0; nd < 4; nd++) {
      // No turning back on itself.
      if ((d ^ 1) === nd && d >> 1 === nd >> 1) continue;
      const ni = i + DX[nd]!,
        nj = j + DY[nd]!;
      if (ni < 0 || nj < 0 || ni >= W || nj >= ys.length) continue;
      const ok =
        nd < 2
          ? clear(rowBlocks[j]!, xs[i]!, xs[ni]!) && free(colBlocks[ni]!, ys[j]!)
          : clear(colBlocks[i]!, ys[j]!, ys[nj]!) && free(rowBlocks[nj]!, xs[i]!);
      if (!ok) continue;
      const step = Math.abs(xs[ni]! - xs[i]!) + Math.abs(ys[nj]! - ys[j]!) * (hug[i] ? HUG : 1);
      const nc = c + step + (nd === d ? 0 : BEND);
      const nk = key(ni, nj, nd);
      if (nc < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, nc);
        back.set(nk, k);
        heap.push(nk, nc + h(ni, nj));
      }
    }
  }
  if (!done) return null;
  const path: Pt[] = [];
  for (let at: number | undefined = done.key; at !== undefined; at = back.get(at)) {
    const q = at >> 2;
    path.push({ x: xs[q % W]!, y: ys[(q - (q % W)) / W]! });
  }
  return path.reverse();
}

/** A small binary heap of keys by priority. */
class Heap {
  private keys: number[] = [];
  private pri: number[] = [];
  get size() {
    return this.keys.length;
  }
  /** The lowest priority waiting. */
  peek() {
    return this.pri[0] ?? Infinity;
  }
  push(key: number, priority: number) {
    const { keys, pri } = this;
    let n = keys.length;
    keys.push(key);
    pri.push(priority);
    while (n > 0) {
      const up = (n - 1) >> 1;
      if (pri[up]! <= pri[n]!) break;
      [keys[up], keys[n]] = [keys[n]!, keys[up]!];
      [pri[up], pri[n]] = [pri[n]!, pri[up]!];
      n = up;
    }
  }
  pop(): number {
    const { keys, pri } = this;
    const top = keys[0]!;
    const lastKey = keys.pop()!,
      lastPri = pri.pop()!;
    if (keys.length) {
      keys[0] = lastKey;
      pri[0] = lastPri;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1,
          r = l + 1;
        let m = n;
        if (l < keys.length && pri[l]! < pri[m]!) m = l;
        if (r < keys.length && pri[r]! < pri[m]!) m = r;
        if (m === n) break;
        [keys[m], keys[n]] = [keys[n]!, keys[m]!];
        [pri[m], pri[n]] = [pri[n]!, pri[m]!];
        n = m;
      }
    }
    return top;
  }
}

// ---------- shape ----------

/** Drops points in the middle of straight runs. */
function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out.at(-2);
    if (
      last &&
      prev &&
      ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))
    )
      out.pop();
    out.push(p);
  }
  return out;
}

/**
 * Lines that run along the same grid line over the same stretch move apart, a few pixels each way.
 * Only inner runs move; the first and last stay on their card sides.
 */
function nudge(routes: Pt[][]) {
  type Run = { points: Pt[]; at: number; lo: number; hi: number };
  const runs = new Map<string, Run[]>();
  for (const points of routes)
    for (let at = 1; at < points.length - 2; at++) {
      const a = points[at]!,
        b = points[at + 1]!;
      const vertical = a.x === b.x;
      const key = vertical ? `x${a.x}` : `y${a.y}`;
      const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x),
        hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
      runs.set(key, [...(runs.get(key) ?? []), { points, at, lo, hi }]);
    }
  for (const [key, list] of runs) {
    if (list.length < 2) continue;
    // Tracks by first fit: runs on one track do not overlap.
    list.sort((a, b) => a.lo - b.lo);
    const ends: number[] = [];
    const track = list.map((r) => {
      let t = ends.findIndex((end) => end <= r.lo + 0.5);
      if (t < 0) t = ends.push(r.hi) - 1;
      else ends[t] = r.hi;
      return t;
    });
    if (ends.length < 2) continue;
    list.forEach((r, n) => {
      // Lanes have room either side; the gap between two stacked cards has less.
      const room = key[0] === "x" ? 5 : M - 3;
      const shift = Math.max(-room, Math.min(room, (track[n]! - (ends.length - 1) / 2) * NUDGE));
      const a = r.points[r.at]!,
        b = r.points[r.at + 1]!;
      if (key[0] === "x") a.x = b.x = a.x + shift;
      else a.y = b.y = a.y + shift;
    });
  }
}

/** The line with rounded turns, stopping short of the arrow, and the arrow into the target's side. */
function draw(points: Pt[]): Route {
  const end = points.at(-1)!,
    prev = points.at(-2)!;
  const dir = Math.sign(end.x - prev.x) || 1;
  const tip = { ...end };
  const stop = { x: end.x - dir * ARROW, y: end.y };
  const pts = [...points.slice(0, -1), stop];
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1]!,
      p = pts[k]!,
      b = pts[k + 1]!;
    const r = Math.min(
      6,
      Math.hypot(p.x - a.x, p.y - a.y) / 2,
      Math.hypot(b.x - p.x, b.y - p.y) / 2,
    );
    const inX = Math.sign(p.x - a.x),
      inY = Math.sign(p.y - a.y),
      outX = Math.sign(b.x - p.x),
      outY = Math.sign(b.y - p.y);
    d += ` L${p.x - inX * r},${p.y - inY * r} Q${p.x},${p.y} ${p.x + outX * r},${p.y + outY * r}`;
  }
  d += ` L${stop.x},${stop.y}`;
  return {
    points,
    path: d,
    arrow: `M${tip.x},${tip.y} L${stop.x},${tip.y - 3.5} L${stop.x},${tip.y + 3.5} Z`,
  };
}
