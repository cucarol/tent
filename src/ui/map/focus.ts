// A topic in focus brings out what it cites and what cites it by marking those topics, not by lines.
import type { Graph } from "../data/store.js";
import type { Pt } from "./arrange.js";
import type { Rect } from "./layout.js";

/** How a topic on the map stands to the one in focus. */
export type Near = "citesIt" | "citedByIt" | "both" | { inside: number };
export type Focus = {
  /** The topics that stay bright: the focus, its parent and children on the map, and every marked topic. */
  lit: Set<string>;
  /** Marked topics: a cited or citing topic itself, or the closed topic on the map that holds some. */
  near: Map<string, Near>;
};

/**
 * What `id` cites through its body and materials, and what cites it, each found on the map: itself when it
 * is shown, otherwise the nearest shown topic above it, which counts how many it holds. Its parent and
 * children are lit but not marked; the tree already shows them. Topics the map leaves out (archived, or
 * of a type switched off) are not counted.
 */
export function focusOf(
  graph: Graph,
  id: string,
  onMap: (id: string) => boolean,
  counted: (id: string) => boolean,
): Focus {
  const n = graph.nodes.get(id);
  const lit = new Set<string>([id]);
  const near = new Map<string, Near>();
  if (!n) return { lit, near };
  const family = new Set([n.parentId, ...n.childIds]);
  for (const f of family) if (f && onMap(f)) lit.add(f);
  const refs = new Map<string, "citesIt" | "citedByIt" | "both">();
  const add = (other: string, how: "citesIt" | "citedByIt") => {
    if (other === id || family.has(other) || !counted(other)) return;
    const had = refs.get(other);
    refs.set(other, had && had !== how ? "both" : how);
  };
  for (const i of n.incoming)
    if (i.from.kind === "node" && i.via !== "card-source") add(i.from.id, "citesIt");
  for (const l of n.links) if (l.ref?.kind === "node") add(l.ref.id, "citedByIt");
  for (const m of n.materials) if (m.kind === "node" && m.id) add(m.id, "citedByIt");
  const inside = new Map<string, number>();
  for (const [other, how] of refs) {
    if (onMap(other)) {
      near.set(other, how);
      continue;
    }
    let up = graph.nodes.get(other)?.parentId;
    while (up && !onMap(up)) up = graph.nodes.get(up)?.parentId;
    if (up && up !== id) inside.set(up, (inside.get(up) ?? 0) + 1);
  }
  for (const [holder, count] of inside) if (!near.has(holder)) near.set(holder, { inside: count });
  for (const k of near.keys()) lit.add(k);
  return { lit, near };
}

const hits = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Points along a tree line's cubic curve. */
function along([p0, p1, p2, p3]: Pt[], steps = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps,
      u = 1 - t;
    const a = u * u * u,
      b = 3 * u * u * t,
      c = 3 * u * t * t,
      d = t * t * t;
    out.push([
      a * p0![0] + b * p1![0] + c * p2![0] + d * p3![0],
      a * p0![1] + b * p1![1] + c * p2![1] + d * p3![1],
    ]);
  }
  return out;
}

export type MarkAsk = {
  id: string;
  /** The topic's top left, which the mark is placed from. */
  at: { x: number; y: number };
  /** The topic's title row, and past it on its far side the room for its count and faces. */
  row: Rect;
  /** 1 when the topic's children grow to the right. */
  side: 1 | -1;
  w: number;
  h: number;
};
/**
 * Where each mark goes, as an offset from its topic's top left: past the far end when that is clear,
 * otherwise before the near end; a mark that would touch another topic or a line is left out, and its
 * topic is still lit.
 */
export function placeMarks(
  asks: readonly MarkAsk[],
  blocks: readonly Rect[],
  lines: readonly { points: Pt[] }[],
  space = 6,
): Map<string, { dx: number; dy: number }> {
  const curves = lines.map((l) => along(l.points));
  const out = new Map<string, { dx: number; dy: number }>();
  const taken: Rect[] = [];
  for (const a of asks) {
    const y = a.row.y + (a.row.h - a.h) / 2;
    const far = a.side > 0 ? a.row.x + a.row.w + space : a.row.x - space - a.w;
    const before = a.side > 0 ? a.row.x - space - a.w : a.row.x + a.row.w + space;
    for (const x of [far, before]) {
      const r = { x, y, w: a.w, h: a.h };
      const pad = { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 };
      if (blocks.some((b) => hits(pad, b)) || taken.some((b) => hits(pad, b))) continue;
      if (
        curves.some((c) =>
          c.some(
            ([px, py]) => px > pad.x && px < pad.x + pad.w && py > pad.y && py < pad.y + pad.h,
          ),
        )
      )
        continue;
      out.set(a.id, { dx: x - a.at.x, dy: y - a.at.y });
      taken.push(r);
      break;
    }
  }
  return out;
}
