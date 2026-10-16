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

/**
 * A line between two cards in a region. Side by side, it runs between their sides like a reference; one
 * above the other, it is a short bracket in the region's margin: parent and child on the left, like the
 * tree, and every other relation on the right, each kind at its own distance so they do not overlap.
 */
export function regionPath(a: Rect, b: Rect, kind: string) {
  if (!(a.x < b.x + b.w && b.x < a.x + a.w)) {
    const { path, arrow } = refPath(a, b);
    const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2,
      my = (a.y + (a.head ?? a.h) / 2 + b.y + (b.head ?? b.h) / 2) / 2;
    return { path, arrow, label: { x: mx, y: my, anchor: "middle" as const } };
  }
  const ay = a.y + (a.head ?? a.h) / 2,
    by = b.y + (b.head ?? b.h) / 2;
  const left = kind === "parent";
  const off = left
    ? 12
    : (({ link: 8, material: 14, code: 20, card: 14 } as Record<string, number>)[kind] ?? 8);
  const sx = left ? a.x : a.x + a.w,
    tx = left ? b.x : b.x + b.w;
  const x0 = left ? Math.min(a.x, b.x) - off : Math.max(a.x + a.w, b.x + b.w) + off;
  const r = Math.min(6, Math.abs(by - ay) / 2, off - 1),
    dir = Math.sign(by - ay) || 1,
    out = left ? -1 : 1;
  const path =
    `M${sx},${ay} H${x0 - out * r} Q${x0},${ay} ${x0},${ay + dir * r}` +
    ` V${by - dir * r} Q${x0},${by} ${x0 - out * r},${by} H${tx}`;
  const back = tx + out * 7;
  return {
    path,
    arrow: `M${tx},${by} L${back},${by - 3.5} L${back},${by + 3.5} Z`,
    label: {
      x: x0 + out * 6,
      y: (ay + by) / 2,
      anchor: left ? ("end" as const) : ("start" as const),
    },
  };
}
