import type { Layout, Placed, Rect } from "./layout.js";

/** References run between card sides and end in an arrow, so they read as "this cites that". */
export function refPath(a: Rect, b: Rect) {
  const ay = a.y + a.h / 2,
    by = b.y + b.h / 2;
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
    const ox = p.x - from.x,
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
