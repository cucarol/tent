// The map's drawing layer, as in Excalidraw. Drawings are for looking at: they sit over the cards without
// taking the pointer. Only while the pen is out does the pad above the map take it, so drawing, picking and
// resizing never reach a card, and the wheel still zooms round the pointer. Rules: Tent Node
// "UI-图谱画模块依赖与状态", cuca 2026-10-17.
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ViewportPortal, useReactFlow, useStore } from "@xyflow/react";
import { Icon, type IconName } from "../components/Glyph.js";
import { t } from "../i18n.js";
import {
  COLORS,
  DASHES,
  HEADS,
  INK,
  INNER,
  aabb,
  anchorAt,
  anchorsOf,
  boxAround,
  boxOf,
  centre,
  controlOf,
  fitTo,
  inkAt,
  inkChanges,
  inkWithin,
  isFace,
  isLine,
  linePath,
  midOf,
  moveBy,
  newId,
  round,
  scaleAll,
  settle,
  strokePath,
  tenth,
  topLayer,
  turn,
  union,
  type Anchor,
  type Box,
  type Color,
  type Dash,
  type Face,
  type FaceShape,
  type Head,
  type Ink,
  type Line,
  type Note,
  type Pt,
  type InkSet,
  type Sizes,
} from "./drawings.js";
import type { Picks } from "./useCanvas.js";

export type InkTool = "hand" | "select" | FaceShape | "arrow" | "line" | "pen" | "text" | "eraser";
/** The toolbar, left to right, with the key that picks each tool. */
export const INK_TOOLS: { tool: InkTool; icon: IconName; key: string }[] = [
  { tool: "select", icon: "pointer", key: "1" },
  { tool: "rect", icon: "rect", key: "2" },
  { tool: "diamond", icon: "diamond", key: "3" },
  { tool: "ellipse", icon: "ellipse", key: "4" },
  { tool: "arrow", icon: "arrow", key: "5" },
  { tool: "line", icon: "line", key: "6" },
  { tool: "pen", icon: "pen", key: "7" },
  { tool: "text", icon: "type", key: "8" },
  { tool: "eraser", icon: "eraser", key: "0" },
];
const PASSIVE: InkTool[] = ["hand", "select", "eraser"];
export const draws = (tool: InkTool) => !PASSIVE.includes(tool);

/** How the next drawing looks: what the style panel sets with nothing picked. */
export type InkStyle = { color: Color; fill: Color | "none"; dash: Dash };
export const INK_STYLE: InkStyle = { color: "ink", fill: "none", dash: "solid" };

/** Text being written: a drawing's text or label, or a new text not yet on the map. */
/** Words being written; `before` is what was picked when they opened, given back when they are undone. */
export type Writing = { id: string; fresh?: Note; before?: string[] };

export const inkColor = (c: Color | undefined) =>
  ({
    ink: "var(--text-2)",
    accent: "var(--accent)",
    goal: "var(--goal)",
    blue: "var(--new)",
    amber: "var(--warn)",
  })[c ?? "ink"];
const tint = (c: Color) => `color-mix(in srgb, ${inkColor(c)} 16%, transparent)`;
const DASH: Record<Dash, string | undefined> = { solid: undefined, dashed: "8 6", dotted: "0.5 5" };

// ---------- words ----------

/** Where a drawing's words stand, unturned, and how they lie in that box. */
type WordsAt = { box: Box; how: "note" | "centred" | "line"; size: number; wrap?: number };
export function wordsOf(d: Ink, sizes?: Sizes): WordsAt | null {
  if (d.kind === "pen") return null;
  if (d.kind === "text") {
    const b = boxOf(d, sizes);
    return {
      box: { x: b.x, y: b.y, w: d.w ?? b.w, h: b.h },
      how: "note",
      size: d.size ?? INK.font,
      wrap: d.w,
    };
  }
  if (isLine(d)) {
    const [mx, my] = midOf(d);
    return { box: { x: mx - 100, y: my - 100, w: 200, h: 200 }, how: "line", size: INK.font };
  }
  const iw = Math.max(30, d.box[2] * INNER[d.shape]);
  return {
    box: { x: d.box[0] + (d.box[2] - iw) / 2, y: d.box[1], w: iw, h: d.box[3] },
    how: "centred",
    size: INK.font,
  };
}

/** The words themselves, or the box that edits them: one markup and one style, so both lie the same. */
function Words({
  at,
  color,
  value,
  edit,
  noteRef,
}: {
  at: WordsAt;
  color: string;
  value: string;
  edit?: { onChange: (v: string) => void; onDone: (v: string | null) => void; placeholder: string };
  noteRef?: (el: HTMLDivElement | null) => void;
}) {
  const style = { fontSize: at.size, color } as CSSProperties;
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const words = edit ? (
    // The mirror after the box takes the text's size, so the box grows as the text does.
    <span className="ink-grow" data-value={`${value || edit.placeholder}\u200b`}>
      <textarea
        ref={box}
        className="ink-words"
        rows={1}
        value={value}
        placeholder={edit.placeholder}
        aria-label={t.ink.note}
        onChange={(e) => edit.onChange(e.target.value)}
        onBlur={() => edit.onDone(value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") edit.onDone(null);
          else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            edit.onDone(value);
          }
        }}
      />
    </span>
  ) : (
    <span className="ink-words">{value}</span>
  );
  const cls = `ink-text is-${at.how}${at.wrap ? " is-wrapped" : ""}`;
  if (at.how === "note")
    return (
      <div ref={noteRef} className={cls} style={style}>
        {words}
      </div>
    );
  return (
    <div className={cls} style={style}>
      <div className={at.how === "line" ? "ink-on-line" : "ink-in-shape"}>{words}</div>
    </div>
  );
}

// ---------- frames and handles ----------

export type Handle = { key: string; at: Pt; kind: "dot" | "bar" | "mid" };
type Frame = { box: Box; rot: number; group: boolean; handles: Handle[] };
/** Screen pixels: room round a picked drawing, the turning handle's lift, and a handle's reach. */
const PICK = { pad: 6, lift: 22, grab: 8 };

/** The frame round what is picked and the handles on it, in map units at `zoom`. */
export function frameOf(list: readonly Ink[], sizes: Sizes, zoom: number): Frame | null {
  if (!list.length) return null;
  const k = 1 / zoom;
  if (list.length === 1 && isLine(list[0])) {
    const d = list[0];
    let [mx, my] = midOf(d);
    // With words in the middle, the bend handle steps aside so they stay readable.
    if (d.label) {
      const [[x1, y1], [x2, y2]] = d.ends,
        n = Math.hypot(x2 - x1, y2 - y1) || 1;
      mx += (-(y2 - y1) / n) * 22 * k;
      my += ((x2 - x1) / n) * 22 * k;
    }
    return {
      box: boxOf(d),
      rot: 0,
      group: false,
      handles: [
        { key: "p1", at: d.ends[0], kind: "dot" },
        { key: "p2", at: d.ends[1], kind: "dot" },
        { key: "mid", at: [mx, my], kind: "mid" },
      ],
    };
  }
  if (list.length === 1) {
    const d = list[0],
      b = boxOf(d, sizes),
      p = PICK.pad * k;
    const box = { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p };
    const c = centre(box),
      rot = d.rot ?? 0,
      x1 = box.x + box.w,
      y1 = box.y + box.h;
    const at = (x: number, y: number) => turn([x, y], c, rot);
    const handles: Handle[] = [
      { key: "rot", at: at(c[0], box.y - PICK.lift * k), kind: "dot" },
      { key: "nw", at: at(box.x, box.y), kind: "dot" },
      { key: "ne", at: at(x1, box.y), kind: "dot" },
      { key: "se", at: at(x1, y1), kind: "dot" },
      { key: "sw", at: at(box.x, y1), kind: "dot" },
    ];
    if (d.kind === "text")
      handles.push(
        { key: "w", at: at(box.x, c[1]), kind: "bar" },
        { key: "e", at: at(x1, c[1]), kind: "bar" },
      );
    return { box, rot, group: false, handles };
  }
  const g = union(list.map((d) => aabb(d, sizes))),
    p = 8 * k;
  const box = { x: g.x - p, y: g.y - p, w: g.w + 2 * p, h: g.h + 2 * p };
  const x1 = box.x + box.w,
    y1 = box.y + box.h;
  return {
    box,
    rot: 0,
    group: true,
    handles: [
      { key: "gnw", at: [box.x, box.y], kind: "dot" },
      { key: "gne", at: [x1, box.y], kind: "dot" },
      { key: "gse", at: [x1, y1], kind: "dot" },
      { key: "gsw", at: [box.x, y1], kind: "dot" },
    ],
  };
}

// ---------- the layer ----------

/** What the pad shows while a gesture is on: where a held end would go, a pick box, lines to line up with. */
export type InkHints = { bind: Anchor | null; marquee: Box | null; guides: [Pt, Pt][] };
export const NO_HINTS: InkHints = { bind: null, marquee: null, guides: [] };

/** The drawings, in map coordinates under the cards' own transform. */
export function InkLayer({
  ink,
  picked,
  writing,
  hints,
  framed,
  onSizes,
}: {
  ink: Ink[];
  picked: ReadonlySet<string>;
  /** The drawing whose words are being written: they show in the editor instead. */
  writing: string | null;
  hints: InkHints;
  /** Whether the picked drawings show their frame and handles. */
  framed: boolean;
  /** Texts as laid out, so picking and frames fit them. */
  onSizes: (sizes: Sizes) => void;
}) {
  const zoom = useStore((s) => s.transform[2]);
  const notes = useRef(new Map<string, HTMLElement>());
  const [sizes, setSizes] = useState<Sizes>(() => new Map());
  useLayoutEffect(() => {
    const next = new Map<string, Pt>();
    for (const [id, el] of notes.current) next.set(id, [el.offsetWidth, el.offsetHeight]);
    const same =
      next.size === sizes.size &&
      [...next].every(([id, [w, h]]) => sizes.get(id)?.[0] === w && sizes.get(id)?.[1] === h);
    if (!same) {
      setSizes(next);
      onSizes(next);
    }
  });
  const list = ink.filter((d) => picked.has(d.id));
  const frame = framed && !writing ? frameOf(list, sizes, zoom) : null;
  const k = 1 / zoom;
  return (
    <ViewportPortal>
      <svg className="ink-layer" width={1} height={1} aria-hidden="true">
        {ink.map((d) => (
          <Drawn
            key={d.id}
            d={d}
            sizes={sizes}
            writing={writing === d.id}
            noteRef={(el) => (el ? notes.current.set(d.id, el) : notes.current.delete(d.id))}
          />
        ))}
        {hints.bind && <BindGlow a={hints.bind} />}
        {frame &&
          list.length > 1 &&
          list.map((d) => {
            const b = aabb(d, sizes),
              p = 4 * k;
            return (
              <rect
                key={d.id}
                className="ink-pick is-faint"
                x={b.x - p}
                y={b.y - p}
                width={b.w + 2 * p}
                height={b.h + 2 * p}
                rx={4 * k}
              />
            );
          })}
        {frame && (
          <g
            transform={
              frame.rot ? `rotate(${frame.rot} ${centre(frame.box).join(" ")})` : undefined
            }
          >
            {!(list.length === 1 && isLine(list[0])) && (
              <rect
                className={`ink-pick${frame.group ? " is-group" : ""}`}
                x={frame.box.x}
                y={frame.box.y}
                width={frame.box.w}
                height={frame.box.h}
                rx={6 * k}
              />
            )}
          </g>
        )}
        {frame?.handles.map((h) =>
          h.kind === "bar" ? (
            <rect
              key={h.key}
              className="ink-handle is-bar"
              x={h.at[0] - 2 * k}
              y={h.at[1] - 8 * k}
              width={4 * k}
              height={16 * k}
              rx={2 * k}
              transform={frame.rot ? `rotate(${frame.rot} ${h.at.join(" ")})` : undefined}
            />
          ) : (
            <circle
              key={h.key}
              className={`ink-handle${h.kind === "mid" ? " is-mid" : ""}`}
              cx={h.at[0]}
              cy={h.at[1]}
              r={(h.kind === "mid" ? 4.5 : 5) * k}
            />
          ),
        )}
        {hints.guides.map(([a, b], i) => (
          <line key={i} className="ink-guide" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
        ))}
        {hints.marquee && (
          <rect
            className="ink-marquee"
            x={hints.marquee.x}
            y={hints.marquee.y}
            width={hints.marquee.w}
            height={hints.marquee.h}
          />
        )}
      </svg>
    </ViewportPortal>
  );
}

function head(kind: Head | undefined, from: Pt, tip: Pt, color: string, key: string) {
  if (!kind || kind === "none") return null;
  if (kind === "dot")
    return <circle key={key} cx={tip[0]} cy={tip[1]} r={3.6} style={{ fill: color }} />;
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]),
    L = 12,
    s = 0.45;
  const p = (da: number) => `${tip[0] - L * Math.cos(a + da)},${tip[1] - L * Math.sin(a + da)}`;
  return (
    <path
      key={key}
      className="ink-line"
      d={`M${p(-s)} L${tip.join(",")} L${p(s)}`}
      style={{ stroke: color, strokeDasharray: "none" }}
    />
  );
}

function Drawn({
  d,
  sizes,
  writing,
  noteRef,
}: {
  d: Ink;
  sizes: Sizes;
  writing: boolean;
  noteRef: (el: HTMLElement | null) => void;
}) {
  const color = inkColor(d.color);
  const line = { stroke: color, strokeDasharray: DASH[d.dash ?? "solid"] } as CSSProperties;
  const at = wordsOf(d, sizes);
  const value = d.kind === "text" ? d.text : d.kind === "pen" ? "" : (d.label ?? "");
  const words =
    at && value && !writing ? (
      <foreignObject
        className="ink-fo"
        x={at.box.x}
        y={at.box.y}
        width={at.how === "note" && !at.wrap ? 4000 : at.box.w}
        height={at.how === "note" ? 4000 : at.box.h}
      >
        <Words
          at={at}
          color={color}
          value={value}
          noteRef={d.kind === "text" ? noteRef : undefined}
        />
      </foreignObject>
    ) : null;
  if (isLine(d)) {
    const c = controlOf(d);
    return (
      <g>
        <path className="ink-line" d={linePath(d)} style={line} />
        {head(d.heads?.[1], c ?? d.ends[0], d.ends[1], color, "h1")}
        {head(d.heads?.[0], c ?? d.ends[1], d.ends[0], color, "h0")}
        {words}
      </g>
    );
  }
  const b = boxOf(d, sizes);
  const turned = d.rot ? `rotate(${d.rot} ${centre(b).join(" ")})` : undefined;
  if (d.kind === "pen")
    return <path className="ink-line" d={strokePath(d.points)} style={line} transform={turned} />;
  if (d.kind === "text") return <g transform={turned}>{words}</g>;
  const fill = d.fill && d.fill !== "none" ? tint(d.fill) : "none";
  const face = { ...line, fill } as CSSProperties;
  const [x, y, w, h] = d.box;
  return (
    <g transform={turned}>
      {d.shape === "rect" && (
        <rect
          className="ink-line"
          x={x}
          y={y}
          width={w}
          height={h}
          rx={Math.min(14, w / 4, h / 4)}
          style={face}
        />
      )}
      {d.shape === "ellipse" && (
        <ellipse
          className="ink-line"
          cx={x + w / 2}
          cy={y + h / 2}
          rx={w / 2}
          ry={h / 2}
          style={face}
        />
      )}
      {d.shape === "diamond" && (
        <path
          className="ink-line"
          d={`M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z`}
          style={face}
        />
      )}
      {words}
    </g>
  );
}

function BindGlow({ a }: { a: Anchor }) {
  const b = a.box,
    c = centre(b);
  return (
    <g transform={a.rot ? `rotate(${a.rot} ${c.join(" ")})` : undefined}>
      {a.shape === "ellipse" ? (
        <ellipse className="ink-bind" cx={c[0]} cy={c[1]} rx={b.w / 2 + 4} ry={b.h / 2 + 4} />
      ) : a.shape === "diamond" ? (
        <path
          className="ink-bind"
          d={`M${c[0]},${b.y - 5} L${b.x + b.w + 6},${c[1]} L${c[0]},${b.y + b.h + 5} L${b.x - 6},${c[1]} Z`}
        />
      ) : (
        <rect
          className="ink-bind"
          x={b.x - 4}
          y={b.y - 4}
          width={b.w + 8}
          height={b.h + 8}
          rx={14}
        />
      )}
    </g>
  );
}

// ---------- writing ----------

/**
 * The words being written, over the pad where they take the pointer, laid exactly where the written words
 * stand: the same box, size and turn, scaled with the map. Esc leaves them as they were.
 */
export function InkEditor({
  d,
  sizes,
  onDone,
}: {
  d: Ink | null;
  sizes: Sizes;
  /** The words as written; null when nothing should change. */
  onDone: (value: string | null) => void;
}) {
  const [x, y, zoom] = useStore((s) => s.transform);
  const initial = !d || d.kind === "pen" ? "" : d.kind === "text" ? d.text : (d.label ?? "");
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const latest = useRef({ value, onDone });
  latest.current = { value, onDone };
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    latest.current.onDone(v === initial ? null : v);
  };
  // Replaced or closed by anything else: keep what was written.
  useLayoutEffect(() => () => finish(latest.current.value), []);
  const at = d && wordsOf(d, sizes);
  if (!d || !at) return null;
  const rot = isLine(d) ? 0 : (d.rot ?? 0);
  // A text turns round its own middle, which for a text not yet written is where it starts.
  const pivot = d.kind === "text" ? centre(boxOf(d, sizes)) : centre(at.box);
  const local: Pt = [pivot[0] - at.box.x, pivot[1] - at.box.y];
  return (
    <div
      className="ink-editor"
      style={{
        left: x + at.box.x * zoom,
        top: y + at.box.y * zoom,
        width: at.how === "note" && !at.wrap ? undefined : at.box.w,
        height: at.how === "note" ? undefined : at.box.h,
        transform: `scale(${zoom})${rot ? ` translate(${local[0]}px, ${local[1]}px) rotate(${rot}deg) translate(${-local[0]}px, ${-local[1]}px)` : ""}`,
      }}
    >
      <Words
        at={at}
        color={inkColor(d.color)}
        value={value}
        edit={{
          onChange: setValue,
          onDone: finish,
          placeholder: d.kind === "text" ? t.ink.notePlaceholder : t.ink.labelPlaceholder,
        }}
      />
    </div>
  );
}

// ---------- the pad ----------

type Gesture =
  | { kind: "pan"; from: [number, number] }
  | { kind: "marquee"; from: Pt; base: ReadonlySet<string> }
  | { kind: "move"; from: Pt; box: Box; moved: boolean; start: Ink[]; ids: ReadonlySet<string> }
  | { kind: "draw"; from: Pt; id: string; points: Pt[] }
  | { kind: "erase"; gone: Set<string> }
  | { kind: "handle"; key: string; from: Pt; start: Ink[]; picked: Ink[]; frame: Frame };

const CURSOR: Record<string, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  e: "ew-resize",
  w: "ew-resize",
  rot: "grab",
  p1: "crosshair",
  p2: "crosshair",
  mid: "grab",
};

/** Map units within which a moved box lines up with another's edge or middle, in screen pixels. */
const SNAP = 6;

/**
 * Takes the pointer while the pen is out. Drawing tools draw along the drag; select picks, moves, resizes
 * and turns, or boxes several from empty space; the hand pans; the eraser takes away what it passes over.
 */
export function InkPad({
  tool,
  ink,
  anchors,
  sizes,
  picked,
  style,
  zoom,
  onPick,
  onPreview,
  onHints,
  onCommit,
  onWrite,
  onDrawn,
}: {
  tool: InkTool;
  /** The drawings with held ends settled. */
  ink: Ink[];
  /** Node cards a line end can hold on to. */
  anchors: Anchor[];
  sizes: Sizes;
  picked: ReadonlySet<string>;
  style: InkStyle;
  /** The map's zoom range: the wheel zooms round the pointer, as it does with the pen away. */
  zoom: { min: number; max: number };
  onPick: (ids: ReadonlySet<string>) => void;
  /** The drawings as the gesture would leave them; null when it ends. */
  onPreview: (ink: Ink[] | null) => void;
  onHints: (hints: InkHints) => void;
  /** What a gesture changed, by id, and what was picked before and after it. */
  onCommit: (changes: Map<string, Ink | null>, picks: Picks) => void;
  onWrite: (w: Writing) => void;
  /** A drawing tool finished a drawing. */
  onDrawn: (d: Ink) => void;
}) {
  const flow = useReactFlow();
  const gesture = useRef<Gesture | null>(null);
  // The drawings and the pick when the gesture began: it hands on only what it changed from these, so
  // whatever arrives from elsewhere meanwhile is kept.
  const begun = useRef<{ base: Ink[]; before: string[] }>({ base: [], before: [] });
  const shown = useRef<Ink[] | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  // What the pointer would take hold of, shown by its cursor.
  const [over, setOver] = useState<string | null>(null);
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y];
  };
  const k = () => 1 / flow.getZoom();
  const hit = (p: Pt) => inkAt(ink, p, INK.reach * k(), sizes);
  const allAnchors = () => anchorsOf(ink, anchors);
  const preview = (next: Ink[] | null) => {
    shown.current = next && settle(next, anchorsOf(next, anchors));
    onPreview(shown.current);
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    begun.current = { base: ink, before: [...picked] };
    const p = at(e);
    if (tool === "text") {
      // Keep the focus from moving to the map, or the text would close as it opens.
      e.preventDefault();
      const d = hit(p);
      if (d && d.kind !== "pen") return onWrite({ id: d.id });
      const fresh: Note = {
        id: newId("text"),
        kind: "text",
        at: round([p[0], p[1] - INK.font * 0.7]),
        text: "",
        z: topLayer(ink),
      };
      if (style.color !== "ink") fresh.color = style.color;
      return onWrite({ id: fresh.id, fresh });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "hand") {
      gesture.current = { kind: "pan", from: [e.clientX, e.clientY] };
      setGrabbing(true);
      return;
    }
    if (tool === "eraser") {
      gesture.current = { kind: "erase", gone: new Set() };
      erase(p);
      return;
    }
    if (tool === "select") {
      const list = ink.filter((d) => picked.has(d.id));
      const frame = frameOf(list, sizes, flow.getZoom());
      const h = handleUnder(p);
      if (h && frame) {
        gesture.current = { kind: "handle", key: h.key, from: p, start: ink, picked: list, frame };
        return;
      }
      const d = hit(p);
      if (!d) {
        const base = e.shiftKey ? picked : new Set<string>();
        if (!e.shiftKey) onPick(base);
        gesture.current = { kind: "marquee", from: p, base };
        return;
      }
      if (e.shiftKey) {
        const next = new Set(picked);
        if (next.has(d.id)) next.delete(d.id);
        else next.add(d.id);
        onPick(next);
        return;
      }
      let ids = picked.has(d.id) ? picked : new Set([d.id]);
      let start = ink;
      // Alt drags out a copy and leaves the original where it was.
      if (e.altKey) {
        const z = topLayer(ink);
        const copies = ink
          .filter((x) => ids.has(x.id))
          .map((x, i) => ({ ...x, id: newId(x.kind), z: z + i }));
        start = [...ink, ...copies];
        ids = new Set(copies.map((x) => x.id));
      }
      onPick(ids);
      const moving = start.filter((x) => ids.has(x.id));
      gesture.current = {
        kind: "move",
        from: p,
        box: union(moving.map((x) => aabb(x, sizes))),
        moved: e.altKey,
        start,
        ids,
      };
      if (e.altKey) preview(start);
      return;
    }
    // A drawing tool: the new drawing grows from here.
    const id = newId(tool === "pen" ? "pen" : "shape");
    gesture.current = { kind: "draw", from: p, id, points: [round(p)] };
    onPick(new Set());
  };

  const erase = (p: Pt) => {
    const g = gesture.current;
    if (g?.kind !== "erase") return;
    const d = inkAt(
      (shown.current ?? ink).filter((x) => !g.gone.has(x.id)),
      p,
      INK.reach * k(),
      sizes,
    );
    if (!d) return;
    g.gone.add(d.id);
    preview(ink.filter((x) => !g.gone.has(x.id)));
  };

  const handleUnder = (p: Pt) => {
    const frame = frameOf(
      ink.filter((d) => picked.has(d.id)),
      sizes,
      flow.getZoom(),
    );
    return (
      frame?.handles.find((h) => Math.hypot(h.at[0] - p[0], h.at[1] - p[1]) <= PICK.grab * k()) ??
      null
    );
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) {
      if (tool !== "select") return;
      const p = at(e);
      const h = handleUnder(p);
      setOver(h ? (CURSOR[h.key.replace(/^g/, "")] ?? "move") : hit(p) ? "move" : null);
      return;
    }
    if (g.kind === "pan") {
      const v = flow.getViewport();
      void flow.setViewport({
        x: v.x + e.clientX - g.from[0],
        y: v.y + e.clientY - g.from[1],
        zoom: v.zoom,
      });
      gesture.current = { kind: "pan", from: [e.clientX, e.clientY] };
      return;
    }
    const p = at(e);
    if (g.kind === "erase") return erase(p);
    if (g.kind === "marquee") {
      const box = boxAround([g.from, p]);
      onHints({ ...NO_HINTS, marquee: box });
      onPick(new Set([...g.base, ...inkWithin(ink, box, sizes).map((d) => d.id)]));
      return;
    }
    const dx = p[0] - g.from[0],
      dy = p[1] - g.from[1];
    if (g.kind === "draw") return drawTo(g, p, e.shiftKey);
    if (g.kind === "move") {
      // A press that wanders a pixel or two is still a click.
      if (!g.moved && Math.hypot(dx, dy) / k() < 3) return;
      g.moved = true;
      const [sx, sy, guides] = snapped(g.box, dx, dy, g.start, g.ids);
      onHints({ ...NO_HINTS, guides });
      preview(g.start.map((d) => (g.ids.has(d.id) ? loosen(moveBy(d, sx, sy), g.ids) : d)));
      return;
    }
    if (g.kind === "handle") return handleTo(g, p, e.shiftKey);
  };

  /** Snapping the moved box's edges and middles to other drawings' and the cards'. */
  const snapped = (
    box: Box,
    dx: number,
    dy: number,
    start: Ink[],
    ids: ReadonlySet<string>,
  ): [number, number, [Pt, Pt][]] => {
    const others = [
      ...start.filter((d) => !ids.has(d.id) && !isLine(d)).map((d) => aabb(d, sizes)),
      ...anchors.map((a) => a.box),
    ];
    const lim = SNAP * k();
    let bx: { s: number; v: number; b: Box } | null = null,
      by: { s: number; v: number; b: Box } | null = null;
    for (const b of others) {
      for (const v of [b.x, b.x + b.w / 2, b.x + b.w])
        for (const m of [box.x, box.x + box.w / 2, box.x + box.w]) {
          const s = v - (m + dx);
          if (Math.abs(s) < lim && (!bx || Math.abs(s) < Math.abs(bx.s))) bx = { s, v, b };
        }
      for (const v of [b.y, b.y + b.h / 2, b.y + b.h])
        for (const m of [box.y, box.y + box.h / 2, box.y + box.h]) {
          const s = v - (m + dy);
          if (Math.abs(s) < lim && (!by || Math.abs(s) < Math.abs(by.s))) by = { s, v, b };
        }
    }
    if (bx) dx += bx.s;
    if (by) dy += by.s;
    const guides: [Pt, Pt][] = [];
    const pad = 10 * k();
    if (bx)
      guides.push([
        [bx.v, Math.min(bx.b.y, box.y + dy) - pad],
        [bx.v, Math.max(bx.b.y + bx.b.h, box.y + box.h + dy) + pad],
      ]);
    if (by)
      guides.push([
        [Math.min(by.b.x, box.x + dx) - pad, by.v],
        [Math.max(by.b.x + by.b.w, box.x + box.w + dx) + pad, by.v],
      ]);
    return [dx, dy, guides];
  };

  const drawTo = (g: Extract<Gesture, { kind: "draw" }>, p: Pt, shift: boolean) => {
    const z = topLayer(ink);
    const look = {
      ...(style.color !== "ink" ? { color: style.color } : {}),
      ...(style.dash !== "solid" ? { dash: style.dash } : {}),
      z,
    };
    let d: Ink;
    if (tool === "pen") {
      const last = g.points.at(-1)!;
      // Closer than a pixel and a half on screen adds nothing to the line.
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) / k() >= 1.5)
        g.points = [...g.points, round(p)];
      d = { ...look, id: g.id, kind: "pen", points: g.points };
    } else if (tool === "arrow" || tool === "line") {
      const q = shift ? snap45(g.from, p) : p;
      const from = anchorAt(allAnchors(), g.from, 8 * k());
      const to = anchorAt(allAnchors(), q, 8 * k(), from?.id);
      onHints({ ...NO_HINTS, bind: to });
      const l: Line = {
        ...look,
        id: g.id,
        kind: "shape",
        shape: "line",
        ends: [round(g.from), round(q)],
      };
      if (tool === "arrow") l.heads = ["none", "arrow"];
      if (from) l.start = from.id;
      if (to) l.end = to.id;
      d = l;
    } else {
      let w = p[0] - g.from[0],
        h = p[1] - g.from[1];
      if (shift) {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      const f: Face = {
        ...look,
        id: g.id,
        kind: "shape",
        shape: tool as FaceShape,
        box: [
          tenth(Math.min(g.from[0], g.from[0] + w)),
          tenth(Math.min(g.from[1], g.from[1] + h)),
          tenth(Math.abs(w)),
          tenth(Math.abs(h)),
        ],
      };
      if (style.fill !== "none") f.fill = style.fill;
      d = f;
    }
    preview([...ink, d]);
  };

  const handleTo = (g: Extract<Gesture, { kind: "handle" }>, p: Pt, shift: boolean) => {
    const dx = p[0] - g.from[0],
      dy = p[1] - g.from[1];
    const d = g.picked[0];
    const put = (next: Ink[]) => preview(g.start.map((x) => next.find((n) => n.id === x.id) ?? x));
    if (g.key === "rot") {
      const [cx, cy] = centre(boxOf(d, sizes));
      let deg =
        (d.rot ?? 0) +
        ((Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(g.from[1] - cy, g.from[0] - cx)) * 180) /
          Math.PI;
      if (shift) deg = Math.round(deg / 15) * 15;
      deg = tenth(((deg % 360) + 360) % 360);
      return put([{ ...d, rot: deg } as Ink]);
    }
    if (g.key.startsWith("g")) {
      // A group keeps its proportions, so the words in it grow with the rest.
      const b = g.frame.box,
        key = g.key.slice(1);
      const ax = key.includes("w") ? b.x + b.w : b.x,
        ay = key.includes("n") ? b.y + b.h : b.y;
      const f = Math.max(
        0.1,
        (key.includes("w") ? b.w - dx : b.w + dx) / b.w,
        (key.includes("n") ? b.h - dy : b.h + dy) / b.h,
      );
      return put(scaleAll(g.picked, [ax, ay], f, sizes));
    }
    if (isLine(d)) {
      if (g.key === "mid") {
        const [mx, my] = midOf(d),
          [[x1, y1], [x2, y2]] = d.ends;
        const bend: Pt = round([mx + dx, my + dy]);
        const { bend: _, ...straight } = d;
        // Back near the straight middle, the line is straight again.
        return put([
          Math.hypot(bend[0] - (x1 + x2) / 2, bend[1] - (y1 + y2) / 2) / k() < 6
            ? (straight as Line)
            : { ...d, bend },
        ]);
      }
      const one = g.key === "p1",
        fixed = d.ends[one ? 1 : 0],
        moved = d.ends[one ? 0 : 1];
      let q: Pt = [moved[0] + dx, moved[1] + dy];
      if (shift) q = snap45(fixed, q);
      const a = anchorAt(allAnchors(), q, 8 * k(), one ? d.end : d.start);
      onHints({ ...NO_HINTS, bind: a });
      const l: Line = { ...d, ends: one ? [round(q), fixed] : [fixed, round(q)] };
      if (one) {
        if (a) l.start = a.id;
        else delete l.start;
      } else if (a) l.end = a.id;
      else delete l.end;
      return put([l]);
    }
    // A corner or side: read the drag in the drawing's own frame, then keep the far corner where it was.
    const b = boxOf(d, sizes),
      rot = d.rot ?? 0,
      key = g.key;
    const [lx, ly] = turn([dx, dy], [0, 0], -rot);
    let x0 = b.x,
      y0 = b.y,
      x1 = b.x + b.w,
      y1 = b.y + b.h;
    if (key.includes("w")) x0 += lx;
    if (key.includes("e")) x1 += lx;
    if (key.includes("n")) y0 += ly;
    if (key.includes("s")) y1 += ly;
    let w = Math.max(8, x1 - x0),
      h = Math.max(8, y1 - y0);
    if (d.kind === "text") {
      if (key === "e" || key === "w") {
        // A side sets how wide the text wraps.
        const nw = Math.max(40, w);
        const n: Note = {
          ...d,
          w: tenth(nw),
          at: round([key === "w" ? b.x + b.w - nw : b.x, b.y]),
        };
        return put([keep(n, b, { x: n.at[0], y: b.y, w: nw, h: b.h }, key, rot)]);
      }
      // A corner scales the text, size and all.
      const f = Math.max(0.3, w / b.w);
      w = b.w * f;
      h = b.h * f;
    } else if (shift) {
      const f = Math.max(w / b.w, h / b.h);
      w = b.w * f;
      h = b.h * f;
    }
    const to = {
      x: key.includes("w") ? b.x + b.w - w : b.x,
      y: key.includes("n") ? b.y + b.h - h : b.y,
      w,
      h,
    };
    return put([keep(fitTo(d, b, to), b, to, key, rot)]);
  };

  const up = () => {
    const g = gesture.current;
    gesture.current = null;
    setGrabbing(false);
    onHints(NO_HINTS);
    if (!g) return;
    const next = shown.current;
    shown.current = null;
    onPreview(null);
    if (g.kind === "pan" || g.kind === "marquee" || !next) return;
    const { base, before } = begun.current;
    if (g.kind === "draw") {
      const d = next.find((x) => x.id === g.id);
      const b = d && boxOf(d);
      // Smaller than a few pixels on screen is a slip, not a drawing.
      if (!d || !b || Math.max(b.w, b.h) / k() < 4) return;
      onCommit(inkChanges(base, next), { before, after: d.kind === "pen" ? [] : [d.id] });
      onDrawn(d);
      return;
    }
    if (g.kind === "move" && !g.moved) return;
    const after =
      g.kind === "move"
        ? [...g.ids]
        : g.kind === "handle"
          ? g.picked.map((d) => d.id)
          : before.filter((id) => !g.gone.has(id));
    onCommit(inkChanges(base, next), { before, after });
  };

  return (
    <div
      className={`ink-pad nopan nodrag is-${tool}${grabbing ? " is-grabbing" : ""}`}
      style={over && tool === "select" ? { cursor: over } : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={(e) => {
        if (tool !== "select") return;
        const p = at(e);
        const d = hit(p);
        if (d && d.kind !== "pen") return onWrite({ id: d.id });
        if (d) return;
        const fresh: Note = {
          id: newId("text"),
          kind: "text",
          at: round([p[0], p[1] - INK.font * 0.7]),
          text: "",
          z: topLayer(ink),
        };
        if (style.color !== "ink") fresh.color = style.color;
        onWrite({ id: fresh.id, fresh });
      }}
      onWheel={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const v = flow.getViewport();
        const step = e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
        const z = Math.min(zoom.max, Math.max(zoom.min, v.zoom * 2 ** -step));
        const px = e.clientX - box.left,
          py = e.clientY - box.top;
        void flow.setViewport({
          x: px - ((px - v.x) * z) / v.zoom,
          y: py - ((py - v.y) * z) / v.zoom,
          zoom: z,
        });
      }}
      aria-label={t.ink.pad}
    />
  );
}

const snap45 = (a: Pt, p: Pt): Pt => {
  const ang = Math.round(Math.atan2(p[1] - a[1], p[0] - a[0]) / (Math.PI / 4)) * (Math.PI / 4),
    r = Math.hypot(p[0] - a[0], p[1] - a[1]);
  return [a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)];
};

/** A line moved without the shape or card it held on to lets go of it. */
export function loosen(d: Ink, moving: ReadonlySet<string>): Ink {
  if (!isLine(d) || !(d.start || d.end)) return d;
  const l = { ...d };
  if (l.start && !moving.has(l.start)) delete l.start;
  if (l.end && !moving.has(l.end)) delete l.end;
  return l;
}

/** A turned drawing resized from `key` keeps the opposite corner or side where it stood. */
function keep(d: Ink, before: Box, after: Box, key: string, rot: number): Ink {
  if (!rot) return d;
  const far = (b: Box): Pt => [
    key.includes("w") ? b.x + b.w : key.includes("e") ? b.x : b.x + b.w / 2,
    key.includes("n") ? b.y + b.h : key.includes("s") ? b.y : b.y + b.h / 2,
  ];
  const was = turn(far(before), centre(before), rot),
    now = turn(far(after), centre(after), rot);
  return moveBy(d, was[0] - now[0], was[1] - now[1]);
}

// ---------- toolbar and style ----------

/** The tools while the pen is out: lock, hand, what the pointer draws, the eraser, and done. */
export function InkTools({
  tool,
  locked,
  onTool,
  onLock,
  onDone,
}: {
  tool: InkTool;
  locked: boolean;
  onTool: (tool: InkTool) => void;
  onLock: () => void;
  onDone: () => void;
}) {
  const button = (k: InkTool, icon: IconName, key: string) => (
    <button
      key={k}
      type="button"
      className="tool sq"
      aria-pressed={tool === k}
      onClick={() => onTool(k)}
      aria-label={t.ink.tool[k]}
      data-tip={t.ink.tool[k]}
      data-key={key}
    >
      <Icon name={icon} size={15} />
      {key.length === 1 && /\d/.test(key) && <span className="tool-key">{key}</span>}
    </button>
  );
  return (
    <div className="panel inktools" role="toolbar" aria-label={t.ink.tools}>
      <button
        type="button"
        className="tool sq"
        aria-pressed={locked}
        onClick={onLock}
        aria-label={t.ink.lock}
        data-tip={t.ink.lockTitle}
        data-key="Q"
      >
        <Icon name={locked ? "lock" : "unlock"} size={15} />
      </button>
      <span className="tool-sep" />
      {button("hand", "hand", "H")}
      <span className="tool-sep" />
      {INK_TOOLS.slice(0, -1).map(({ tool: k, icon, key }) => button(k, icon, key))}
      <span className="tool-sep" />
      {button("eraser", "eraser", "0")}
      <span className="tool-sep" />
      <button type="button" className="tool inktools-done" onClick={onDone}>
        {t.ink.done}
        <kbd>Esc</kbd>
      </button>
    </div>
  );
}

export type InkAct = "front" | "up" | "down" | "back" | "copy" | "delete";
/**
 * How the picked drawings look, and their layers; with nothing picked and a drawing tool in hand, how the
 * next drawing will look.
 */
export function InkStylePanel({
  list,
  tool,
  style,
  left,
  onSet,
  onAct,
}: {
  list: Ink[];
  tool: InkTool;
  style: InkStyle;
  /** Where the panel starts, clear of whatever stands at the map's top left. */
  left: number;
  onSet: (change: InkSet) => void;
  onAct: (act: InkAct) => void;
}) {
  const drawing = !list.length && draws(tool);
  if (!list.length && !drawing) return null;
  const one = <T,>(f: (d: Ink) => T | undefined): T | null => {
    const v = new Set(list.map(f).filter((x) => x !== undefined));
    return v.size === 1 ? ([...v][0] as T) : null;
  };
  const color = drawing ? style.color : one((d) => d.color ?? "ink");
  const fill = drawing ? style.fill : one((d) => (isFace(d) ? (d.fill ?? "none") : undefined));
  const dash = drawing
    ? style.dash
    : one((d) => (d.kind === "text" ? undefined : (d.dash ?? "solid")));
  const faces = drawing ? ["rect", "diamond", "ellipse"].includes(tool) : list.some(isFace);
  const stroked = drawing ? tool !== "text" : list.some((d) => d.kind !== "text");
  const lines = !drawing && list.some(isLine);
  const row = (label: string, body: ReactNode) => (
    <div className="ink-style-row">
      <span className="ink-style-label">{label}</span>
      <div className="ink-style-opts">{body}</div>
    </div>
  );
  const swatch = (set: InkSet, on: boolean, bg: string, name: string, cls = "") => (
    <button
      key={name}
      type="button"
      className={`ink-swatch${cls}`}
      style={{ background: bg }}
      aria-pressed={on}
      aria-label={name}
      data-tip={name}
      onClick={() => onSet(set)}
    />
  );
  const act = (a: InkAct, icon: IconName, key?: string) => (
    <button
      key={a}
      type="button"
      className="tool sq"
      onClick={() => onAct(a)}
      aria-label={t.ink.act[a]}
      data-tip={t.ink.act[a]}
      data-key={key}
    >
      <Icon name={icon} size={14} />
    </button>
  );
  return (
    <div className="panel ink-style" style={{ left }} role="group" aria-label={t.ink.style}>
      {row(
        t.ink.color,
        COLORS.map((c) => swatch({ color: c }, color === c, inkColor(c), t.ink.colors[c])),
      )}
      {faces &&
        row(t.ink.fill, [
          swatch({ fill: "none" }, fill === "none", "", t.ink.noFill, " is-none"),
          ...COLORS.map((c) => swatch({ fill: c }, fill === c, tint(c), t.ink.colors[c])),
        ])}
      {stroked &&
        row(
          t.ink.dash,
          DASHES.map((k) => (
            <button
              key={k}
              type="button"
              className="ink-chip"
              aria-pressed={dash === k}
              aria-label={t.ink.dashes[k]}
              data-tip={t.ink.dashes[k]}
              onClick={() => onSet({ dash: k })}
            >
              <svg viewBox="0 0 22 14" aria-hidden="true">
                <path
                  d="M2 7h18"
                  strokeDasharray={k === "solid" ? undefined : k === "dotted" ? "0.5 4" : "5 3.5"}
                />
              </svg>
            </button>
          )),
        )}
      {lines &&
        ([0, 1] as const).map((i) => {
          const now = one((d) => (isLine(d) ? (d.heads?.[i] ?? "none") : undefined));
          return (
            <div key={i}>
              {row(
                i ? t.ink.endHead : t.ink.startHead,
                HEADS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="ink-chip"
                    aria-pressed={now === h}
                    aria-label={t.ink.heads[h]}
                    data-tip={t.ink.heads[h]}
                    onClick={() => onSet({ head: [i, h] })}
                  >
                    <HeadIcon kind={h} end={i === 1} />
                  </button>
                )),
              )}
            </div>
          );
        })}
      {!drawing &&
        row(t.ink.layer, [
          act("back", "toBack", "Ctrl Shift ["),
          act("down", "backward", "Ctrl ["),
          act("up", "forward", "Ctrl ]"),
          act("front", "toFront", "Ctrl Shift ]"),
        ])}
      {!drawing &&
        row(t.ink.actions, [act("copy", "copy", "Ctrl D"), act("delete", "trash", "Delete")])}
    </div>
  );
}

function HeadIcon({ kind, end }: { kind: Head; end: boolean }) {
  const tip = end ? 19 : 3,
    dir = end ? -1 : 1;
  return (
    <svg viewBox="0 0 22 14" aria-hidden="true">
      <path d={`M${end ? 3 : 19} 7H${tip}`} />
      {kind === "arrow" && <path d={`M${tip + dir * 5} 3 ${tip} 7 ${tip + dir * 5} 11`} />}
      {kind === "dot" && <circle cx={tip} cy={7} r={2.6} fill="currentColor" stroke="none" />}
    </svg>
  );
}
