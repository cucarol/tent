// The map's drawing layer. Drawings are for looking at: they sit over the cards without taking the
// pointer. Only while drawing is on does the pad above the map take it, so pens, notes and picking a
// drawing never reach a card, and the wheel still zooms round the pointer.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ViewportPortal, useReactFlow, useStore } from "@xyflow/react";
import { Icon, type IconName } from "../components/Glyph.js";
import { t } from "../i18n.js";
import {
  INK,
  boxOf,
  inkAt,
  moveBy,
  newId,
  round,
  strokePath,
  type Ink,
  type Note,
  type Pt,
} from "./drawings.js";
import type { InkStore } from "./useInk.js";

export type InkTool = "select" | "pen" | "text";
export const INK_TOOLS: { tool: InkTool; icon: IconName; key: string }[] = [
  { tool: "select", icon: "pointer", key: "V" },
  { tool: "pen", icon: "pen", key: "P" },
  { tool: "text", icon: "type", key: "T" },
];

/** A drawing being moved, and how far. */
export type Moving = { id: string; dx: number; dy: number };
/** A note being written: a new one at `at`, or one already on the map. */
export type Writing = { at: Pt; note: Note | null };

/** The drawings, in map coordinates under the cards' own transform. */
export function InkLayer({
  ink,
  picked,
  moving,
  draft,
  writing,
}: {
  ink: Ink[];
  picked: string | null;
  moving: Moving | null;
  draft: Pt[] | null;
  writing: string | null;
}) {
  const shown = ink.flatMap((d) =>
    d.id === writing ? [] : [moving?.id === d.id ? moveBy(d, moving.dx, moving.dy) : d],
  );
  const mark = picked ? shown.find((d) => d.id === picked) : undefined;
  const b = mark && boxOf(mark);
  return (
    <ViewportPortal>
      <svg className="ink-layer" width={1} height={1} aria-hidden="true">
        {shown.map((d) =>
          d.kind === "pen" ? (
            <path key={d.id} className="ink-line" d={strokePath(d.points)} />
          ) : (
            <text
              key={d.id}
              className="ink-note"
              x={d.at[0]}
              y={d.at[1]}
              fontSize={INK.font}
              dominantBaseline="hanging"
            >
              {d.text.split("\n").map((line, i) => (
                <tspan key={i} x={d.at[0]} dy={i ? INK.font * INK.line : 0}>
                  {line || " "}
                </tspan>
              ))}
            </text>
          ),
        )}
        {draft && <path className="ink-line" d={strokePath(draft)} />}
        {b && (
          <rect
            className="ink-pick"
            x={b.x - 5}
            y={b.y - 5}
            width={b.w + 10}
            height={b.h + 10}
            rx={4}
          />
        )}
      </svg>
    </ViewportPortal>
  );
}

/**
 * A note being written. It sits above the drawing pad, where it takes the pointer, so a click in it places
 * the caret or selects text; it follows the map's pan and zoom. Whatever closes it, the text written so
 * far is kept: Esc alone discards it.
 */
export function InkEditor({
  writing,
  onDone,
}: {
  writing: Writing;
  /** The text as written; null when nothing should change. */
  onDone: (text: string | null) => void;
}) {
  const [x, y, zoom] = useStore((s) => s.transform);
  const initial = writing.note?.text ?? "";
  const [text, setText] = useState(initial);
  const latest = useRef({ text, onDone });
  latest.current = { text, onDone };
  const done = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    latest.current.onDone(value === initial ? null : value);
  };
  useEffect(() => {
    const el = box.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    // Replaced or closed by anything else: keep what was written.
    return () => finish(latest.current.text);
  }, []);
  const lines = text.split("\n");
  return (
    <textarea
      ref={box}
      className="ink-editor"
      style={{
        left: x + writing.at[0] * zoom,
        top: y + writing.at[1] * zoom,
        transform: `scale(${zoom})`,
        fontSize: INK.font,
        lineHeight: INK.line,
        width: `${Math.max(6, ...lines.map((l) => [...l].length + 2))}em`,
        height: `${lines.length * INK.line + 0.2}em`,
      }}
      value={text}
      placeholder={t.ink.notePlaceholder}
      aria-label={t.ink.note}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(null);
        else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(text);
        }
      }}
    />
  );
}

type Gesture =
  | { kind: "pen" }
  | { kind: "move"; id: string; from: Pt }
  | { kind: "pan"; from: [number, number] };

/**
 * Takes the pointer while drawing is on. The pen draws a stroke along the drag; a text starts a note
 * where you click, or opens one you click on; select picks a drawing and drags it, or pans the map
 * from empty space.
 */
export function InkPad({
  tool,
  store,
  zoom,
  onPick,
  onMoving,
  onDraft,
  writing,
  onWrite,
}: {
  tool: InkTool;
  store: InkStore;
  /** The map's zoom range: the wheel zooms round the pointer, as it does without drawing on. */
  zoom: { min: number; max: number };
  onPick: (id: string | null) => void;
  onMoving: (m: Moving | null) => void;
  onDraft: (points: Pt[] | null) => void;
  /** Whether a note is open: a click with the text tool then only closes it. */
  writing: boolean;
  onWrite: (w: Writing | null) => void;
}) {
  const flow = useReactFlow();
  const gesture = useRef<Gesture | null>(null);
  const points = useRef<Pt[]>([]);
  const [grabbing, setGrabbing] = useState(false);
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y];
  };
  const hit = (p: Pt) => inkAt(store.ink, p, INK.reach / flow.getZoom());

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !store.ready) return;
    e.stopPropagation();
    const p = at(e);
    if (tool === "text") {
      // Keep the focus from moving to the map, or the note would close as it opens.
      e.preventDefault();
      if (writing) {
        onWrite(null);
        return;
      }
      const d = hit(p);
      onWrite(d?.kind === "text" ? { at: d.at, note: d } : { at: round(p), note: null });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "pen") {
      gesture.current = { kind: "pen" };
      points.current = [round(p)];
      onDraft(points.current);
      return;
    }
    const d = hit(p);
    onPick(d?.id ?? null);
    if (d) gesture.current = { kind: "move", id: d.id, from: p };
    else {
      gesture.current = { kind: "pan", from: [e.clientX, e.clientY] };
      setGrabbing(true);
    }
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pen") {
      const p = round(at(e));
      const last = points.current.at(-1)!;
      // Closer than a pixel and a half on screen adds nothing to the line.
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * flow.getZoom() < 1.5) return;
      points.current = [...points.current, p];
      onDraft(points.current);
    } else if (g.kind === "move") {
      const p = at(e);
      onMoving({ id: g.id, dx: p[0] - g.from[0], dy: p[1] - g.from[1] });
    } else {
      const v = flow.getViewport();
      void flow.setViewport({
        x: v.x + e.clientX - g.from[0],
        y: v.y + e.clientY - g.from[1],
        zoom: v.zoom,
      });
      gesture.current = { kind: "pan", from: [e.clientX, e.clientY] };
    }
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setGrabbing(false);
    if (!g) return;
    if (g.kind === "pen") {
      const stroke = points.current;
      points.current = [];
      onDraft(null);
      store.commit([...store.ink, { id: newId("pen"), kind: "pen", node: null, points: stroke }]);
    } else if (g.kind === "move") {
      onMoving(null);
      const p = at(e);
      const dx = p[0] - g.from[0],
        dy = p[1] - g.from[1];
      // A click without a drag only picks.
      if (Math.hypot(dx, dy) * flow.getZoom() < 3) return;
      store.commit(store.ink.map((d) => (d.id === g.id ? moveBy(d, dx, dy) : d)));
    }
  };

  return (
    <div
      className={`ink-pad nopan nodrag is-${tool}${grabbing ? " is-grabbing" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={(e) => {
        if (tool !== "select") return;
        const d = hit(at(e));
        if (d?.kind === "text") onWrite({ at: d.at, note: d });
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

/** The tools while drawing is on: what the pointer does, undo and redo, and done. */
export function InkTools({
  tool,
  store,
  onTool,
  onDone,
}: {
  tool: InkTool;
  store: InkStore;
  onTool: (tool: InkTool) => void;
  onDone: () => void;
}) {
  return (
    <div className="panel inktools" role="toolbar" aria-label={t.ink.tools}>
      {INK_TOOLS.map(({ tool: k, icon, key }) => (
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
        </button>
      ))}
      <span className="tool-sep" />
      <button
        type="button"
        className="tool sq"
        disabled={!store.canUndo}
        onClick={store.undo}
        aria-label={t.ink.undo}
        data-tip={t.ink.undo}
        data-key="Ctrl Z"
      >
        <Icon name="undo" size={15} />
      </button>
      <button
        type="button"
        className="tool sq"
        disabled={!store.canRedo}
        onClick={store.redo}
        aria-label={t.ink.redo}
        data-tip={t.ink.redo}
        data-key="Ctrl Shift Z"
      >
        <Icon name="redo" size={15} />
      </button>
      <span className="tool-sep" />
      <button type="button" className="tool inktools-done" onClick={onDone}>
        {t.ink.done}
        <kbd>Esc</kbd>
      </button>
    </div>
  );
}
