// Drawing on the map, as in Excalidraw: pen strokes, texts, rectangles, diamonds, ellipses, lines and arrows.
// They follow topics only for the look and record no relation in Tent. They live in the
// canvas file (canvas.ts) beside folds. Rules: Tent Node "UI-图谱画模块依赖与状态",
// cuca 2026-10-13 and 2026-10-17.
import type { Drawing } from "./canvas.js";

export type Pt = [number, number];
export type Box = { x: number; y: number; w: number; h: number };

/** Tent's own colours for drawing: ink, accent, goal, new and warn. */
export const COLORS = ["ink", "accent", "goal", "blue", "amber"] as const;
export type Color = (typeof COLORS)[number];
export const DASHES = ["solid", "dashed", "dotted"] as const;
export type Dash = (typeof DASHES)[number];
export const HEADS = ["none", "arrow", "dot"] as const;
export type Head = (typeof HEADS)[number];
export const FACES = ["rect", "diamond", "ellipse"] as const;
export type FaceShape = (typeof FACES)[number];

/** Physical attachment only: offset from the topic title, and the last projected drawing centre. */
export type Attachment = { topic: string; offset: Pt; lastAt: Pt };
/** What every drawing may carry: its colour, its line, its turn, layer and attachment. */
type Look = { color?: Color; dash?: Dash; rot?: number; z?: number; attachment?: Attachment };
export type Stroke = Look & { id: string; kind: "pen"; points: Pt[] };
/** A text: `w` wraps it to that width, else it is as wide as its longest line. */
export type Note = Look & {
  id: string;
  kind: "text";
  at: Pt;
  text: string;
  w?: number;
  size?: number;
};
export type Face = Look & {
  id: string;
  kind: "shape";
  shape: FaceShape;
  box: [number, number, number, number];
  fill?: Color | "none";
  label?: string;
};
/**
 * A line from `ends[0]` to `ends[1]`, bent through `bend` at its middle. `start` and `end` name a shape or a
 * Node card the end holds on to; the ends keep where it last met that thing.
 */
export type Line = Look & {
  id: string;
  kind: "shape";
  shape: "line";
  ends: [Pt, Pt];
  bend?: Pt;
  heads?: [Head, Head];
  start?: string;
  end?: string;
  label?: string;
};
export type Ink = Stroke | Note | Face | Line;

/** Text size and line height in map units, the stroke width, and how near a pointer picks, in screen pixels. */
export const INK = { font: 15, line: 1.35, stroke: 2, reach: 7 };
/** How much of a shape's width its label may use. */
export const INNER: Record<FaceShape, number> = { rect: 0.86, ellipse: 0.7, diamond: 0.52 };

export const isFace = (d: Ink): d is Face => d.kind === "shape" && d.shape !== "line";
export const isLine = (d: Ink): d is Line => d.kind === "shape" && d.shape === "line";

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isPt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && p.every(isNum);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  list.includes(v as T) ? (v as T) : undefined;

/** Parse known drawing fields while retaining fields owned by other UI versions. */
function lookOf(d: Drawing): Look {
  // Unknown UI fields survive reading, geometry edits and saving. Recognized fields are parsed below.
  const out = { ...d } as Record<string, unknown> & Look;
  for (const key of [
    "id",
    "kind",
    "color",
    "dash",
    "rot",
    "z",
    "attachment",
    "points",
    "at",
    "text",
    "w",
    "size",
    "shape",
    "box",
    "fill",
    "label",
    "ends",
    "bend",
    "heads",
    "start",
    "end",
  ])
    delete out[key];
  const attachment = d.attachment as Partial<Attachment> | null;
  if (
    attachment &&
    typeof attachment.topic === "string" &&
    isPt(attachment.offset) &&
    isPt(attachment.lastAt)
  )
    out.attachment = attachment as Attachment;
  const color = oneOf(COLORS, d.color),
    dash = oneOf(DASHES, d.dash);
  if (color) out.color = color;
  if (dash) out.dash = dash;
  if (isNum(d.rot) && d.rot) out.rot = d.rot;
  if (isNum(d.z)) out.z = d.z;
  return out;
}
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** The drawings this page can show, in layer order. Anything else in the file is left alone and not shown. */
export function inkOf(drawings: readonly Drawing[]): Ink[] {
  const out = drawings.flatMap((d): Ink[] => {
    const look = lookOf(d);
    if (d.kind === "pen" && Array.isArray(d.points) && d.points.length && d.points.every(isPt))
      return [{ ...look, id: d.id, kind: "pen", points: d.points }];
    if (d.kind === "text" && isPt(d.at) && text(d.text)) {
      const n: Note = { ...look, id: d.id, kind: "text", at: d.at, text: d.text as string };
      if (isNum(d.w) && d.w > 0) n.w = d.w;
      if (isNum(d.size) && d.size > 0) n.size = d.size;
      return [n];
    }
    if (d.kind !== "shape") return [];
    const label = text(d.label);
    if (oneOf(FACES, d.shape)) {
      const box = d.box;
      if (
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every(isNum) ||
        box[2] <= 0 ||
        box[3] <= 0
      )
        return [];
      const f: Face = {
        ...look,
        id: d.id,
        kind: "shape",
        shape: d.shape as FaceShape,
        box: box as Face["box"],
      };
      const fill = d.fill === "none" ? "none" : oneOf(COLORS, d.fill);
      if (fill) f.fill = fill;
      if (label) f.label = label;
      return [f];
    }
    if (d.shape === "line" && Array.isArray(d.ends) && d.ends.length === 2 && d.ends.every(isPt)) {
      const l: Line = { ...look, id: d.id, kind: "shape", shape: "line", ends: d.ends as [Pt, Pt] };
      delete l.rot;
      if (isPt(d.bend)) l.bend = d.bend;
      const heads = d.heads;
      if (Array.isArray(heads) && heads.length === 2 && heads.every((h) => oneOf(HEADS, h)))
        l.heads = heads as [Head, Head];
      if (typeof d.start === "string") l.start = d.start;
      if (typeof d.end === "string") l.end = d.end;
      if (label) l.label = label;
      return [l];
    }
    return [];
  });
  return layered(out);
}

/** Drawings in the order they stack: by layer, then as the file lists them. */
export function layered(ink: readonly Ink[]): Ink[] {
  return ink
    .map((d, i) => [d, d.z ?? i] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([d]) => d);
}

/** The drawing changes that turn `before` into `after`, by id; null takes one out. */
export function inkChanges(before: readonly Ink[], after: readonly Ink[]): Map<string, Ink | null> {
  const out = new Map<string, Ink | null>();
  const next = new Map(after.map((d) => [d.id, d]));
  for (const d of before) if (!next.has(d.id)) out.set(d.id, null);
  for (const d of after) if (!before.includes(d)) out.set(d.id, d);
  return out;
}

/** The drawings with `changes` laid over them by id: changed ones keep their place, new ones go last. */
export function withChanges(all: readonly Ink[], changes: ReadonlyMap<string, Ink | null>): Ink[] {
  if (!changes.size) return [...all];
  const out = all.flatMap((d) => {
    if (!changes.has(d.id)) return [d];
    const next = changes.get(d.id);
    return next ? [next] : [];
  });
  const have = new Set(all.map((d) => d.id));
  for (const [id, d] of changes) if (d && !have.has(id)) out.push(d);
  return out;
}

/** Map coordinates to a tenth of a unit: finer than any screen shows, and the file stays small. */
export const tenth = (n: number) => Math.round(n * 10) / 10;
export const round = ([x, y]: Pt): Pt => [tenth(x), tenth(y)];

let made = 0;
export const newId = (kind: "pen" | "text" | "shape") =>
  `${kind}-${Date.now().toString(36)}${(made++ % 1296).toString(36).padStart(2, "0")}`;

// ---------- size and place ----------

/** A text's size in map units, roughly, when the page has not measured it: wide characters take a full em. */
export function textSize(value: string, size = INK.font, wrap?: number): Pt {
  const lines = value.split("\n");
  const widths = lines.map(
    (l) => [...l].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.58), 0) * size,
  );
  const rows = wrap
    ? widths.reduce((n, w) => n + Math.max(1, Math.ceil(w / wrap)), 0)
    : lines.length;
  return [wrap ?? Math.max(size, ...widths), rows * size * INK.line];
}

/** Measured text sizes by drawing id, where the page has laid them out. */
export type Sizes = ReadonlyMap<string, Pt>;

/** A drawing's box before it is turned. */
export function boxOf(d: Ink, sizes?: Sizes): Box {
  if (d.kind === "text") {
    const [w, h] = sizes?.get(d.id) ?? textSize(d.text, d.size, d.w);
    return { x: d.at[0], y: d.at[1], w: d.w ?? w, h };
  }
  if (isFace(d)) return { x: d.box[0], y: d.box[1], w: d.box[2], h: d.box[3] };
  const pts = isLine(d) ? [...d.ends, ...(d.bend ? [d.bend] : [])] : d.points;
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export const centre = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2];

/** Topic title centres, all surviving Node IDs, and the actual focus (or the project centre). */
export type InkContext = {
  topics: ReadonlyMap<string, Pt>;
  existingIds: ReadonlySet<string>;
  centre: { id: string; at: Pt };
};

/** Beyond this distance a drawing follows the current centre rather than a distant branch. */
export const ATTACH_REACH = 360;

/** Reattach only after creating or deliberately changing a drawing's geometry. */
export function attachInk(d: Ink, context: InkContext, sizes?: Sizes): Ink {
  const at = centre(boxOf(d, sizes));
  let topic = context.centre.id,
    target = context.centre.at,
    distance = ATTACH_REACH;
  for (const [id, point] of context.topics) {
    const next = Math.hypot(point[0] - at[0], point[1] - at[1]);
    if (next < distance) {
      topic = id;
      target = point;
      distance = next;
    }
  }
  return {
    ...d,
    attachment: { topic, offset: [at[0] - target[0], at[1] - target[1]], lastAt: at },
  };
}

/**
 * Follow visible topics, hide drawings on folded/filtered topics, and freeze deleted targets.
 * `all` always retains hidden drawings; save it, and use only `visible` for drawing and gesture diffs.
 * The project centre belongs to its own focus, so switching focus cannot move its drawings elsewhere.
 */
export function projectInk(
  ink: readonly Ink[],
  context: InkContext,
): { all: Ink[]; visible: Ink[] } {
  const hidden = new Set<string>();
  const targetOf = (id: string) =>
    id === context.centre.id ? context.centre.at : context.topics.get(id);
  const isHidden = (id: string) =>
    !targetOf(id) && (id === "@mind-centre" || context.existingIds.has(id));
  const all = ink.map((original) => {
    const d = original.attachment ? original : attachInk(original, context);
    const attachment = d.attachment!;
    if (isHidden(attachment.topic)) hidden.add(d.id);
    const target = targetOf(attachment.topic);
    if (!target) return d;
    const at: Pt = [target[0] + attachment.offset[0], target[1] + attachment.offset[1]];
    const dx = at[0] - attachment.lastAt[0],
      dy = at[1] - attachment.lastAt[1];
    if (Math.abs(dx) < 0.000001 && Math.abs(dy) < 0.000001) return d;
    return { ...moveBy(d, dx, dy), attachment: { ...attachment, lastAt: at } };
  });
  // Endpoints on hidden topics or hidden shapes disappear with them, retaining their last geometry.
  for (const d of all)
    if (isLine(d) && [d.start, d.end].some((id) => id && (isHidden(id) || hidden.has(id))))
      hidden.add(d.id);
  return { all, visible: all.filter((d) => !hidden.has(d.id)) };
}

/** `p` turned by `deg` degrees round `c`. */
export function turn([px, py]: Pt, [cx, cy]: Pt, deg: number): Pt {
  if (!deg) return [px, py];
  const r = (deg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c];
}

/** The box round a drawing as it stands, turned corners included. */
export function aabb(d: Ink, sizes?: Sizes): Box {
  const b = boxOf(d, sizes);
  if (!d.rot || isLine(d)) return b;
  const c = centre(b);
  const pts = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ].map((p) => turn(p as Pt, c, d.rot!));
  return boxAround(pts);
}

export function boxAround(pts: Pt[]): Box {
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export const union = (boxes: Box[]): Box =>
  boxAround(boxes.flatMap((b) => [[b.x, b.y] as Pt, [b.x + b.w, b.y + b.h] as Pt]));

// ---------- lines ----------

/** Where a line's middle is: its bend, or halfway. */
export const midOf = (d: Line): Pt =>
  d.bend ?? [(d.ends[0][0] + d.ends[1][0]) / 2, (d.ends[0][1] + d.ends[1][1]) / 2];
/** The curve's control point, which puts the bend on the curve at its middle. */
export const controlOf = (d: Line): Pt | null =>
  d.bend
    ? [
        2 * d.bend[0] - (d.ends[0][0] + d.ends[1][0]) / 2,
        2 * d.bend[1] - (d.ends[0][1] + d.ends[1][1]) / 2,
      ]
    : null;
export function linePath(d: Line): string {
  const [[x1, y1], [x2, y2]] = d.ends,
    c = controlOf(d);
  return c ? `M${x1},${y1} Q${c[0]},${c[1]} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`;
}
/** Points along the line, enough to find it under the pointer. */
function samples(d: Line): Pt[] {
  const c = controlOf(d);
  if (!c) return d.ends;
  const [a, b] = d.ends;
  return Array.from({ length: 17 }, (_, i) => {
    const t = i / 16,
      u = 1 - t;
    return [
      u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
      u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
    ];
  });
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

// ---------- holding on ----------

/** Something a line end can hold on to: a shape, or a Node card by its box. */
export type Anchor = { id: string; box: Box; shape: FaceShape; rot?: number };

/** Where a line toward `toward` meets the outline of `a`, a little outside it. */
export function edgeOf(a: Anchor, toward: Pt): Pt {
  const c = centre(a.box),
    [vx, vy] = turn(toward, c, -(a.rot ?? 0)),
    dx = vx - c[0],
    dy = vy - c[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return c;
  const rx = a.box.w / 2,
    ry = a.box.h / 2;
  const k =
    a.shape === "ellipse"
      ? 1 / Math.hypot(dx / rx, dy / ry)
      : a.shape === "diamond"
        ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
        : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  return turn([c[0] + dx * k + (dx / len) * 6, c[1] + dy * k + (dy / len) * 6], c, a.rot ?? 0);
}

/** The shapes a line can hold on to, under the cards it can hold on to; the topmost comes last. */
export function anchorsOf(ink: readonly Ink[], cards: readonly Anchor[]): Anchor[] {
  return [
    ...cards,
    ...ink.filter(isFace).map((d) => ({ id: d.id, box: boxOf(d), shape: d.shape, rot: d.rot })),
  ];
}

/** The anchor an end at `p` would hold on to: inside it or within `reach` of it. */
export function anchorAt(
  anchors: readonly Anchor[],
  p: Pt,
  reach: number,
  except?: string,
): Anchor | null {
  for (let i = anchors.length - 1; i >= 0; i--) {
    const a = anchors[i];
    if (a.id === except) continue;
    const [x, y] = turn(p, centre(a.box), -(a.rot ?? 0));
    const b = a.box;
    if (x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach && y <= b.y + b.h + reach)
      return a;
  }
  return null;
}

/**
 * The drawings with each held line end where its anchor now stands. An anchor that is gone, or a card not on
 * the map, leaves the end where it last was.
 */
export function settle(ink: readonly Ink[], anchors: readonly Anchor[]): Ink[] {
  if (!ink.some((d) => isLine(d) && (d.start || d.end))) return [...ink];
  const by = new Map(anchors.map((a) => [a.id, a]));
  return ink.map((d) => {
    if (!isLine(d) || !(d.start || d.end)) return d;
    const s = d.start ? by.get(d.start) : undefined,
      e = d.end ? by.get(d.end) : undefined;
    if (!s && !e) return d;
    let [a, b] = d.ends;
    if (s) a = edgeOf(s, d.bend ?? (e ? centre(e.box) : b));
    if (e) b = edgeOf(e, d.bend ?? a);
    a = round(a);
    b = round(b);
    return a[0] === d.ends[0][0] &&
      a[1] === d.ends[0][1] &&
      b[0] === d.ends[1][0] &&
      b[1] === d.ends[1][1]
      ? d
      : { ...d, ends: [a, b] };
  });
}

// ---------- picking ----------

const toSegment = ([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt) => {
  const dx = bx - ax,
    dy = by - ay;
  const len = dx * dx + dy * dy;
  const k = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + k * dx), py - (ay + k * dy));
};
const nearPath = (p: Pt, pts: Pt[], reach: number) => {
  for (let j = 0; j < pts.length; j++)
    if (toSegment(p, pts[Math.max(0, j - 1)], pts[j]) <= reach) return true;
  return false;
};

/** Whether `p` touches the drawing: on its line, or inside a text or a shape. */
export function touches(d: Ink, p: Pt, reach: number, sizes?: Sizes): boolean {
  if (isLine(d)) {
    if (nearPath(p, samples(d), reach)) return true;
    if (!d.label) return false;
    const [mx, my] = midOf(d);
    return Math.abs(p[0] - mx) <= 40 && Math.abs(p[1] - my) <= 14;
  }
  const b = boxOf(d, sizes);
  const q = d.rot ? turn(p, centre(b), -d.rot) : p;
  if (d.kind === "pen") return nearPath(q, d.points, reach);
  return (
    q[0] >= b.x - reach &&
    q[0] <= b.x + b.w + reach &&
    q[1] >= b.y - reach &&
    q[1] <= b.y + b.h + reach
  );
}

/** The topmost drawing under `p`; null if none. */
export function inkAt(ink: readonly Ink[], p: Pt, reach: number, sizes?: Sizes): Ink | null {
  for (let i = ink.length - 1; i >= 0; i--) if (touches(ink[i], p, reach, sizes)) return ink[i];
  return null;
}

/** The drawings wholly inside `box`. */
export const inkWithin = (ink: readonly Ink[], box: Box, sizes?: Sizes) =>
  ink.filter((d) => {
    const b = aabb(d, sizes);
    return b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h;
  });

// ---------- changing ----------

export function moveBy(d: Ink, dx: number, dy: number): Ink {
  const shift = ([x, y]: Pt): Pt => round([x + dx, y + dy]);
  if (d.kind === "text") return { ...d, at: shift(d.at) };
  if (d.kind === "pen") return { ...d, points: d.points.map(shift) };
  if (isFace(d)) {
    const [x, y] = shift([d.box[0], d.box[1]]);
    return { ...d, box: [x, y, d.box[2], d.box[3]] };
  }
  return {
    ...d,
    ends: [shift(d.ends[0]), shift(d.ends[1])],
    ...(d.bend ? { bend: shift(d.bend) } : {}),
  };
}

/** A drawing put into the box `to` (before turning), from where it stood in `from`. */
export function fitTo(d: Ink, from: Box, to: Box): Ink {
  const fx = from.w ? to.w / from.w : 1,
    fy = from.h ? to.h / from.h : 1;
  const map = ([x, y]: Pt): Pt => round([to.x + (x - from.x) * fx, to.y + (y - from.y) * fy]);
  if (isFace(d)) return { ...d, box: [tenth(to.x), tenth(to.y), tenth(to.w), tenth(to.h)] };
  if (d.kind === "pen") return { ...d, points: d.points.map(map) };
  if (isLine(d))
    return {
      ...d,
      ends: [map(d.ends[0]), map(d.ends[1])],
      ...(d.bend ? { bend: map(d.bend) } : {}),
    };
  const size = Math.max(6, Math.min(160, tenth((d.size ?? INK.font) * fx)));
  return { ...d, at: round([to.x, to.y]), size, ...(d.w ? { w: tenth(d.w * fx) } : {}) };
}

/** Several drawings scaled together by `f` round `anchor`, keeping each one's turn. */
export function scaleAll(list: readonly Ink[], anchor: Pt, f: number, sizes?: Sizes): Ink[] {
  const map = ([x, y]: Pt): Pt =>
    round([anchor[0] + (x - anchor[0]) * f, anchor[1] + (y - anchor[1]) * f]);
  return list.map((d) => {
    if (isLine(d))
      return {
        ...d,
        ends: [map(d.ends[0]), map(d.ends[1])],
        ...(d.bend ? { bend: map(d.bend) } : {}),
      };
    // Each grows round its own middle, so a turned one stays turned where it was.
    const b = boxOf(d, sizes),
      [cx, cy] = map(centre(b)),
      w = b.w * f,
      h = b.h * f;
    return fitTo(d, b, { x: cx - w / 2, y: cy - h / 2, w, h });
  });
}

/** Copies of `list` with new ids, `by` along and down; lines between copied shapes hold on to the copies. */
export function copiesOf(list: readonly Ink[], by: number, id: (d: Ink) => string): Ink[] {
  const ids = new Map(list.map((d) => [d.id, id(d)]));
  return list.map((d) => {
    const c = { ...moveBy(d, by, by), id: ids.get(d.id)! };
    if (isLine(d)) {
      const l = c as Line;
      const start = d.start ? ids.get(d.start) : undefined,
        end = d.end ? ids.get(d.end) : undefined;
      if (start) l.start = start;
      else delete l.start;
      if (end) l.end = end;
      else delete l.end;
    }
    return c;
  });
}

/** The layers once the picked drawings go to the front or back, or one step up or down. */
export function restack(
  ink: readonly Ink[],
  picked: ReadonlySet<string>,
  where: "front" | "back" | "up" | "down",
): Ink[] {
  let order = [...ink];
  if (where === "front")
    order = [...ink.filter((d) => !picked.has(d.id)), ...ink.filter((d) => picked.has(d.id))];
  else if (where === "back")
    order = [...ink.filter((d) => picked.has(d.id)), ...ink.filter((d) => !picked.has(d.id))];
  else {
    const step = where === "up" ? 1 : -1;
    const at = order.flatMap((d, i) => (picked.has(d.id) ? [i] : []));
    for (const i of step > 0 ? at.reverse() : at) {
      const j = i + step;
      if (j < 0 || j >= order.length || picked.has(order[j].id)) continue;
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  // Only drawings whose layer changes are written again.
  return order.map((d, i) => (d.z === i ? d : { ...d, z: i }));
}

/** The next layer up, for a new drawing. */
export const topLayer = (ink: readonly Ink[]) =>
  ink.reduce((z, d, i) => Math.max(z, (d.z ?? i) + 1), 0);

/**
 * The drawings once a text closes with `value`: on a text, an empty one goes; on a shape or line, it is the
 * label, and an empty one takes the label off. Trailing blanks are dropped; null changes nothing.
 */
export function withWords(all: Ink[], id: string, value: string | null): Ink[] {
  if (value === null) return all;
  const clean = value.replace(/\s+$/, "");
  return all.flatMap((d): Ink[] => {
    if (d.id !== id) return [d];
    if (d.kind === "text") return clean ? [{ ...d, text: clean }] : [];
    if (d.kind === "pen") return [d];
    const { label: _, ...rest } = d;
    return [clean ? { ...d, label: clean } : (rest as Ink)];
  });
}

/** One change of look, from the style panel. */
export type InkSet =
  { color: Color } | { fill: Color | "none" } | { dash: Dash } | { head: [0 | 1, Head] };

/** A drawing with one change of look; a change it cannot take leaves it as it was. Defaults are left out. */
export function restyle(d: Ink, change: InkSet): Ink {
  if ("color" in change) {
    const { color: _, ...rest } = d;
    return change.color === "ink" ? (rest as Ink) : { ...d, color: change.color };
  }
  if ("fill" in change) return isFace(d) ? { ...d, fill: change.fill } : d;
  if ("dash" in change) {
    if (d.kind === "text") return d;
    const { dash: _, ...rest } = d;
    return change.dash === "solid" ? (rest as Ink) : { ...d, dash: change.dash };
  }
  if (!isLine(d)) return d;
  const heads: [Head, Head] = [...(d.heads ?? ["none", "none"])] as [Head, Head];
  heads[change.head[0]] = change.head[1];
  return { ...d, heads };
}
