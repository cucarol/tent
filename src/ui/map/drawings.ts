// Drawing on the map: pen strokes and written notes, kept for looking at only. They hold on to nothing:
// each one keeps its own map coordinates (`node: null`), so cards moving, folding or going away never
// move them. They live in the workspace's canvas file next to whatever else it holds, which is kept as
// it was. Rules: Tent Node "UI-图谱画模块依赖与状态", cuca 2026-10-13.

export type Pt = [number, number];
export type Stroke = { id: string; kind: "pen"; node: null; points: Pt[] };
export type Note = { id: string; kind: "text"; node: null; at: Pt; text: string };
export type Ink = Stroke | Note;

/** The canvas file as the service holds it; only `drawings` is ours to change. */
export type CanvasFile = {
  version: 1;
  forms: Record<string, unknown>;
  positions: Record<string, unknown>;
  drawings: Array<{ id: string; kind: string; node: string | null; [key: string]: unknown }>;
};

/** Handwriting size in map units, and how near a pointer has to come to pick a stroke, in screen pixels. */
export const INK = { font: 15, line: 1.35, stroke: 2, reach: 7 };

export const emptyCanvas = (): CanvasFile => ({
  version: 1,
  forms: {},
  positions: {},
  drawings: [],
});

const isPt = (p: unknown): p is Pt =>
  Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));

/** The file as read, or an empty one; anything not shaped like a canvas is treated as empty. */
export function readCanvas(value: unknown): CanvasFile {
  const c = value as Partial<CanvasFile> | null;
  if (!c || c.version !== 1 || !Array.isArray(c.drawings)) return emptyCanvas();
  return {
    version: 1,
    forms: c.forms ?? {},
    positions: c.positions ?? {},
    drawings: c.drawings,
  };
}

/** The free pens and texts in the file. Drawings of any other shape are left alone and not shown. */
export function inkOf(canvas: CanvasFile): Ink[] {
  return canvas.drawings.flatMap((d): Ink[] => {
    if (d.node !== null) return [];
    if (d.kind === "pen" && Array.isArray(d.points) && d.points.length && d.points.every(isPt))
      return [{ id: d.id, kind: "pen", node: null, points: d.points }];
    if (d.kind === "text" && isPt(d.at) && typeof d.text === "string" && d.text.trim())
      return [{ id: d.id, kind: "text", node: null, at: d.at, text: d.text }];
    return [];
  });
}

/**
 * The file with `ink` in place of the drawings it was read from. Drawings that were not ours keep their
 * place in the list; new ones go at the end, in the order drawn.
 */
export function withInk(canvas: CanvasFile, ink: Ink[]): CanvasFile {
  const ours = new Set(inkOf(canvas).map((d) => d.id));
  const next = new Map(ink.map((d) => [d.id, d]));
  const drawings: CanvasFile["drawings"] = [];
  for (const d of canvas.drawings) {
    if (!ours.has(d.id)) drawings.push(d);
    else if (next.has(d.id)) {
      drawings.push(next.get(d.id)!);
      next.delete(d.id);
    }
  }
  return { ...canvas, drawings: [...drawings, ...next.values()] };
}

/** Map coordinates to a tenth of a unit: finer than any screen shows, and the file stays small. */
export const round = ([x, y]: Pt): Pt => [Math.round(x * 10) / 10, Math.round(y * 10) / 10];

let made = 0;
export const newId = (kind: Ink["kind"]) =>
  `${kind}-${Date.now().toString(36)}${(made++ % 1296).toString(36).padStart(2, "0")}`;

/** Text size in map units, roughly: wide characters take a full em. */
export function textSize(text: string): Pt {
  const lines = text.split("\n");
  const width = Math.max(
    ...lines.map((l) => [...l].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.58), 0)),
  );
  return [Math.max(1, width) * INK.font, lines.length * INK.font * INK.line];
}

export type Box = { x: number; y: number; w: number; h: number };

export function boxOf(d: Ink): Box {
  if (d.kind === "text") {
    const [w, h] = textSize(d.text);
    return { x: d.at[0], y: d.at[1], w, h };
  }
  const xs = d.points.map((p) => p[0]),
    ys = d.points.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const toSegment = ([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt) => {
  const dx = bx - ax,
    dy = by - ay;
  const len = dx * dx + dy * dy;
  const k = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + k * dx), py - (ay + k * dy));
};

/** The topmost drawing under `p`, within `reach` map units of a stroke or inside a text; null if none. */
export function inkAt(ink: Ink[], p: Pt, reach: number): Ink | null {
  for (let i = ink.length - 1; i >= 0; i--) {
    const d = ink[i];
    if (d.kind === "text") {
      const b = boxOf(d);
      const inX = p[0] >= b.x - reach && p[0] <= b.x + b.w + reach;
      if (inX && p[1] >= b.y - reach && p[1] <= b.y + b.h + reach) return d;
      continue;
    }
    const pts = d.points;
    // A dot is a stroke of one point: its own segment.
    for (let j = 0; j < pts.length; j++)
      if (toSegment(p, pts[Math.max(0, j - 1)], pts[j]) <= reach) return d;
  }
  return null;
}

export function moveBy(d: Ink, dx: number, dy: number): Ink {
  const shift = ([x, y]: Pt): Pt => round([x + dx, y + dy]);
  return d.kind === "text" ? { ...d, at: shift(d.at) } : { ...d, points: d.points.map(shift) };
}

/** A smooth line through the points: each corner rounds off through the midpoints. */
export function strokePath(points: Pt[]): string {
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M${x},${y} l0.01,0`;
  }
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i],
      [nx, ny] = points[i + 1];
    d += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`;
  }
  const [lx, ly] = points.at(-1)!;
  return `${d} L${lx},${ly}`;
}

/**
 * The drawings once a note closes with `text`: a new note is added, an edited one changes in place, and
 * one left empty goes. Trailing blanks are dropped; null text changes nothing.
 */
export function withNote(
  all: Ink[],
  note: { at: Pt; id?: string },
  text: string | null,
  id: () => string,
): Ink[] {
  if (text === null) return all;
  const clean = text.replace(/\s+$/, "");
  if (note.id) {
    const own = note.id;
    return clean
      ? all.map((d) => (d.id === own && d.kind === "text" ? { ...d, text: clean } : d))
      : all.filter((d) => d.id !== own);
  }
  return clean ? [...all, { id: id(), kind: "text", node: null, at: note.at, text: clean }] : all;
}
