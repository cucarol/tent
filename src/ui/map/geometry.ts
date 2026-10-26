import type { Layout, Placed, Rect } from "./layout.js";

/** References run between card sides and end in an arrow, so they read as "this cites that". */
export function refPath(a: Rect, b: Rect) {
  const ay = a.y + (a.head ?? a.h) / 2,
    by = b.y + (b.head ?? b.h) / 2;
  let sx: number, tx: number, out: number, arrive: number;
  if (b.x >= a.x + a.w + 24) {
    sx = a.x + a.w;
    tx = b.x;
    out = 1;
    arrive = 1;
  } else if (b.x + b.w + 24 <= a.x) {
    sx = a.x;
    tx = b.x + b.w;
    out = -1;
    arrive = -1;
  } else {
    sx = a.x;
    tx = b.x;
    out = -1;
    arrive = 1;
  } // Same column: loop out on the left, clear of the trunks to the next column.
  const reach =
    out === arrive
      ? Math.max(40, Math.abs(tx - sx) / 2)
      : 44 + Math.min(96, Math.abs(by - ay) * 0.22);
  const back = tx - arrive * 7;
  return {
    path: `M${sx},${ay} C${sx + out * reach},${ay} ${tx - arrive * reach},${by} ${back},${by}`,
    arrow: `M${tx},${by} L${back},${by - 3.5} L${back},${by + 3.5} Z`,
  };
}

/** The closest card in a direction, preferring ones in line with the current card. */
export function nearest(
  view: Layout,
  from: Placed,
  [dx, dy]: [number, number],
  shown: (id: string) => boolean,
): string | null {
  let best: string | null = null,
    score = Infinity;
  for (const p of view.placed.values()) {
    if (p.id === from.id || !shown(p.id)) continue;
    const ox = p.x + p.w / 2 - (from.x + from.w / 2),
      oy = p.y - from.y;
    const along = ox * dx + oy * dy,
      across = Math.abs(dx ? oy : ox);
    if (along <= 1) continue;
    const s = along + across * (dx ? 2.5 : 4);
    if (s < score) {
      score = s;
      best = p.id;
    }
  }
  return best;
}

type Point = [number, number];
/** One relation query shares its grid and lazy line-interval index across all endpoint searches. */
function makeRouter(
  blocks: readonly Rect[],
  anchors: readonly Point[],
  pad: number,
  labelWidth: number,
) {
  type Interval = [number, number];
  const horizontal = new Map<number, Interval[]>(),
    vertical = new Map<number, Interval[]>();
  const intervals = (at: number, alongX: boolean) => {
    const cache = alongX ? horizontal : vertical,
      known = cache.get(at);
    if (known) return known;
    const spans: Interval[] = [];
    for (const r of blocks) {
      const low = alongX ? r.y : r.x,
        high = low + (alongX ? r.h : r.w);
      if (at > low && at < high) spans.push(alongX ? [r.x, r.x + r.w] : [r.y, r.y + r.h]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Interval[] = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    cache.set(at, merged);
    return merged;
  };
  const clear = (p: Point, q: Point) => {
    const alongX = p[1] === q[1],
      list = intervals(alongX ? p[1] : p[0], alongX);
    const low = Math.min(alongX ? p[0] : p[1], alongX ? q[0] : q[1]),
      high = Math.max(alongX ? p[0] : p[1], alongX ? q[0] : q[1]);
    // Open rectangle interiors: touching the expanded boundary keeps exactly the requested clearance.
    let lo = 0,
      hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]![1] <= low) lo = mid + 1;
      else hi = mid;
    }
    return lo === list.length || list[lo]![0] >= high;
  };
  const buildSearch = () => {
    const xs = [
      ...new Set([...anchors.map((p) => p[0]), ...blocks.flatMap((r) => [r.x, r.x + r.w])]),
    ].sort((a, b) => a - b);
    const ys = [
      ...new Set([...anchors.map((p) => p[1]), ...blocks.flatMap((r) => [r.y, r.y + r.h])]),
    ].sort((a, b) => a - b);
    xs.unshift(xs[0]! - Math.max(16, pad * 3, labelWidth));
    xs.push(xs.at(-1)! + Math.max(16, pad * 3, labelWidth));
    ys.unshift(ys[0]! - Math.max(16, pad * 3));
    ys.push(ys.at(-1)! + Math.max(16, pad * 3));
    const xIndex = new Map(xs.map((x, i) => [x, i])),
      yIndex = new Map(ys.map((y, i) => [y, i]));
    const key = (x: number, y: number) => y * xs.length + x;
    const point = (id: number): Point => [xs[id % xs.length]!, ys[Math.floor(id / xs.length)]!];
    return (start: Point, end: Point): Point[] | null => {
      const s = key(xIndex.get(start[0])!, yIndex.get(start[1])!),
        goal = key(xIndex.get(end[0])!, yIndex.get(end[1])!);
      const scores = new Map([[s, 0]]),
        prev = new Map<number, number>(),
        closed = new Set<number>();
      const heap: { id: number; score: number }[] = [];
      const push = (id: number, score: number) => {
        heap.push({ id, score });
        let i = heap.length - 1;
        while (i > 0) {
          const up = (i - 1) >> 1;
          if (heap[up]!.score <= score) break;
          [heap[i], heap[up]] = [heap[up]!, heap[i]!];
          i = up;
        }
      };
      const pop = () => {
        const first = heap[0]!,
          last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          while (true) {
            let c = i * 2 + 1;
            if (c >= heap.length) break;
            if (c + 1 < heap.length && heap[c + 1]!.score < heap[c]!.score) c++;
            if (heap[i]!.score <= heap[c]!.score) break;
            [heap[i], heap[c]] = [heap[c]!, heap[i]!];
            i = c;
          }
        }
        return first.id;
      };
      push(s, 0);
      while (heap.length) {
        const id = pop();
        if (closed.has(id)) continue;
        if (id === goal) break;
        closed.add(id);
        const ix = id % xs.length,
          iy = Math.floor(id / xs.length),
          p = point(id);
        const adjacent = [
          [ix - 1, iy],
          [ix + 1, iy],
          [ix, iy - 1],
          [ix, iy + 1],
        ].filter(([x, y]) => x! >= 0 && x! < xs.length && y! >= 0 && y! < ys.length);
        for (const [x, y] of adjacent) {
          const next = key(x!, y!),
            q = point(next);
          if (closed.has(next) || !clear(p, q)) continue;
          const score = scores.get(id)! + Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
          if (score >= (scores.get(next) ?? Infinity)) continue;
          scores.set(next, score);
          prev.set(next, id);
          push(next, score + Math.abs(q[0] - end[0]) + Math.abs(q[1] - end[1]));
        }
      }
      if (s !== goal && !prev.has(goal)) return null;
      const raw = [goal];
      while (raw[raw.length - 1] !== s) raw.push(prev.get(raw[raw.length - 1]!)!);
      return raw
        .reverse()
        .map(point)
        .filter(
          (p, i, all) =>
            !i ||
            i === all.length - 1 ||
            !(
              (p[0] === all[i - 1]![0] && p[0] === all[i + 1]![0]) ||
              (p[1] === all[i - 1]![1] && p[1] === all[i + 1]![1])
            ),
        );
    };
  };
  let search: ReturnType<typeof buildSearch> | undefined;
  return {
    clear,
    route: (start: Point, end: Point) => {
      search ??= buildSearch();
      return search(start, end);
    },
  };
}
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
type RelationRoute = {
  points: Point[];
  label: { x: number; y: number; anchor: "middle"; length: number };
};
/** Try one layout-unit clearance, reusing the same index across bounded offers and A*. */
function relationRoute(
  a: Rect,
  b: Rect,
  third: readonly Rect[],
  labelWidth: number,
  pad: number,
): RelationRoute | null {
  // Endpoints and hand-drawn/projection decorations are not routing obstacles.
  const blocks = third.map((r) => ({
    x: r.x - pad,
    y: r.y - pad,
    w: r.w + pad * 2,
    h: r.h + pad * 2,
  }));
  const bounds = [a, b, ...blocks];
  const ports = (r: Rect): Point[] => [
    [r.x, r.y + (r.head ?? r.h) / 2],
    [r.x + r.w, r.y + (r.head ?? r.h) / 2],
    [r.x + r.w / 2, r.y],
    [r.x + r.w / 2, r.y + r.h],
  ];
  const available = (p: Point) =>
    !blocks.some((r) => p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h);
  const starts = ports(a).filter(available),
    ends = ports(b).filter(available);
  const distance = (p: Point, q: Point) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
  const pairs = starts
    .flatMap((start) => ends.map((end) => ({ start, end })))
    .sort((x, y) => distance(x.start, x.end) - distance(y.start, y.end));
  const left = Math.min(...bounds.map((r) => r.x)) - Math.max(pad * 2, labelWidth / 2 + 10);
  const right = Math.max(...bounds.map((r) => r.x + r.w)) + Math.max(pad * 2, labelWidth / 2 + 10);
  const top = Math.min(...bounds.map((r) => r.y)) - Math.max(pad * 2, 20);
  const bottom = Math.max(...bounds.map((r) => r.y + r.h)) + Math.max(pad * 2, 20);
  const router = pairs.length
    ? makeRouter(
        blocks,
        [...starts, ...ends, [left, top], [right, top], [left, bottom], [right, bottom]],
        pad,
        labelWidth,
      )
    : null;
  const labelOn = (points: Point[]) => {
    if (labelWidth === 0) {
      const p = points[0]!,
        q = points[1]!;
      return {
        x: (p[0] + q[0]) / 2,
        y: (p[1] + q[1]) / 2,
        anchor: "middle" as const,
        length: Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]),
      };
    }
    return points
      .slice(1)
      .flatMap((q, i) => {
        const p = points[i]!;
        if (p[1] !== q[1] || Math.abs(p[0] - q[0]) < labelWidth + 10) return [];
        const x = (p[0] + q[0]) / 2,
          y = p[1],
          box = { x: x - labelWidth / 2 - 3, y: y - 10, w: labelWidth + 6, h: 20 };
        return [a, b, ...third].some((r) => overlap(box, r))
          ? []
          : [{ x, y, anchor: "middle" as const, length: Math.abs(p[0] - q[0]) }];
      })
      .sort((a, b) => b.length - a.length)[0];
  };
  let points: Point[] | null = null;
  let label: ReturnType<typeof labelOn> | undefined;
  const farLeft = Math.min(...bounds.map((r) => r.x)) - Math.max(pad * 2, labelWidth + 16);
  const farRight = Math.max(...bounds.map((r) => r.x + r.w)) + Math.max(pad * 2, labelWidth + 16);
  // Six bounded orthogonal offers per existing port pair. The indexed A* is the fallback.
  fast: for (const { start, end } of pairs) {
    const offers: Point[][] = [
      [start, [start[0], end[1]], end],
      [start, [end[0], start[1]], end],
      [start, [farLeft, start[1]], [farLeft, end[1]], end],
      [start, [farRight, start[1]], [farRight, end[1]], end],
      [start, [start[0], top], [end[0], top], end],
      [start, [start[0], bottom], [end[0], bottom], end],
    ];
    for (const offer of offers) {
      const unique = offer.filter(
        (p, i) => !i || p[0] !== offer[i - 1]![0] || p[1] !== offer[i - 1]![1],
      );
      const candidate = unique.filter(
        (p, i) =>
          !i ||
          i === unique.length - 1 ||
          !(
            (p[0] === unique[i - 1]![0] && p[0] === unique[i + 1]![0]) ||
            (p[1] === unique[i - 1]![1] && p[1] === unique[i + 1]![1])
          ),
      );
      if (
        candidate.length < 2 ||
        !candidate.slice(1).every((q, i) => router!.clear(candidate[i]!, q))
      )
        continue;
      const fits = labelOn(candidate);
      if (!fits) continue;
      points = candidate;
      label = fits;
      break fast;
    }
  }
  if (!points) {
    for (const { start, end } of pairs) {
      points = router!.route(start, end);
      if (points) break;
    }
    label = points ? labelOn(points) : undefined;
  }

  // An outside bridge always reserves a full text-width segment, instead of dropping the label.
  if (points && !label) {
    for (const y of [top, bottom]) {
      const bridgeA: Point = [left, y],
        bridgeB: Point = [right, y];
      let first: Point[] | null = null,
        last: Point[] | null = null;
      for (const p of starts) {
        first = router!.route(p, bridgeA);
        if (first) break;
      }
      if (!first) continue;
      for (const p of ends) {
        last = router!.route(bridgeB, p);
        if (last) break;
      }
      if (first && last) {
        points = [...first, bridgeB, ...last.slice(1)];
        label = { x: (left + right) / 2, y, anchor: "middle", length: right - left };
        break;
      }
    }
  }
  return points && label ? { points, label } : null;
}

/** Eight units at 100%; the chosen route scales with the map rather than reserving screen pixels. */
export function selectionPath(
  a: Rect,
  b: Rect,
  _kind: string,
  obstacles: readonly Rect[] = [],
  _zoom = 1,
  labelWidth = 0,
) {
  const same = (r: Rect, q: Rect) => r.x === q.x && r.y === q.y && r.w === q.w && r.h === q.h;
  const third = obstacles.filter((r) => !same(r, a) && !same(r, b));
  let chosen = relationRoute(a, b, third, labelWidth, 8);
  if (!chosen) {
    // A tight passage keeps the real relation: maximize its uniform layout clearance, never cross a Node.
    chosen = relationRoute(a, b, third, labelWidth, 0);
    if (!chosen)
      throw new Error(
        `No relation route outside Node rectangles: ${JSON.stringify({ a, b, third })}`,
      );
    let low = 0,
      high = 8;
    // At most 1/128 layout unit short of the best feasible clearance under this orthogonal rectangle model.
    for (let i = 0; i < 10; i++) {
      const pad = (low + high) / 2,
        candidate = relationRoute(a, b, third, labelWidth, pad);
      if (candidate) {
        low = pad;
        chosen = candidate;
      } else high = pad;
    }
  }
  const { points, label } = chosen;
  const path = points.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  const end = points.at(-1)!,
    last = points.at(-2)!,
    dx = Math.sign(end[0] - last[0]),
    dy = Math.sign(end[1] - last[1]),
    size = 7;
  const back: Point = [end[0] - dx * size, end[1] - dy * size];
  const arrow = `M${end[0]},${end[1]} L${back[0] - (dy * size) / 2},${back[1] + (dx * size) / 2} L${back[0] + (dy * size) / 2},${back[1] - (dx * size) / 2} Z`;
  return { path, arrow, label, points };
}
