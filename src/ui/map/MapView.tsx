import { keepUnchanged, useSteady } from "./stable.js";
import { DetailsContext, useWantDetails } from "../data/details.js";
import {
  Fragment,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  BaseEdge,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { primaryOf, type Graph, type Hand, type Primary } from "../data/store.js";
import type { SnapshotCommit, SnapshotRef } from "../data/types.js";
import { isDraft } from "../data/drafts.js";
import { FileGlyph, Icon, TypeGlyph, type IconName } from "../components/Glyph.js";
import { fileOf, infoOf, previewOf, useFiles } from "../data/files.js";
import type { LocalFile } from "../panel/FileView.js";
import { CardPreview, previewHeight } from "./CardPreview.js";
import {
  CARD,
  GAP,
  rectOf,
  isResult,
  shownTree,
  type Layout,
  type Placed,
  type Rect,
  type Shown,
} from "./layout.js";
import { PUBLIC } from "../shell/work.js";
import { handlingOnTopics, handsOf, useHandling, type Handling } from "../data/handling.js";
import { Hands, HandlingRows } from "../components/Handling.js";
import { beginDrag } from "../shell/drag.js";
import { useFloatingPanels } from "./floats.js";
import { stagedTopics, TOPIC_PHASE_MS, type TopicPhase } from "./motion.js";
import { nearest, selectionPath } from "./geometry.js";
import { clearRect, fitViewport, fitZoom, wheelViewport, uncoverViewport } from "./pointer.js";
import { Timeline } from "./Timeline.js";
import {
  INK_STYLE,
  INK_TOOLS,
  InkEditor,
  InkLayer,
  InkPad,
  InkStylePanel,
  InkTools,
  NO_HINTS,
  loosen,
  type InkAct,
  type InkHints,
  type InkStyle,
  type InkTool,
  type Writing,
} from "./Ink.js";
import {
  anchorsOf,
  attachInk,
  projectInk,
  type InkContext,
  copiesOf,
  inkChanges,
  moveBy,
  newId,
  restack,
  restyle,
  settle,
  topLayer,
  withChanges,
  withWords,
  type Anchor,
  type Ink,
  type InkSet,
  type Sizes,
  aabb,
} from "./drawings.js";
import { useCanvas, type Picks } from "./useCanvas.js";
import { emptyCanvas, withPending, type Fold } from "./canvas.js";
import { arrange as arrangeMap, CENTRE, listed, taper, TOPIC, type Topic } from "./arrange.js";
import { selectionLines, type CodeEdge, type SelectionLineKind } from "./relations.js";
import { focusOf, placeMarks } from "./focus.js";
import {
  beginLens,
  foldInLens,
  lensFacts,
  lensLines,
  revealInLens,
  selectionAfterLens,
  type LensSession,
} from "./lens.js";
import { pictureName, pictureOf, saveFile, type Crop } from "./picture.js";
import {
  comparisonsFor,
  outputsToCompare,
  noTimes,
  reactionsIn,
  timesFor,
  type Answer,
  type Reaction,
  type TimesAnswer,
} from "./reactions.js";
import { SelectionReaction } from "./Reaction.js";
import { api, describe } from "../data/api.js";
import { HistoryTrees, historyViewGraph, type HistoricalSelection } from "../data/history-tree.js";
import { historyLayout } from "./history-layout.js";
import type { HistoryTree } from "../../core/read/history-query.js";

import { ago, readStored, when, writeStored } from "../util.js";
import { t } from "../i18n.js";
const NO_CODE: readonly CodeEdge[] = [];
/** Keys the sidebar tree answers itself while one of its rows has focus. */
const TREE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  "*",
  " ",
]);
// Broad zoom bounds; the first level stays readable and distant deeper labels are hidden.
const ZOOM = { min: 0.04, max: 4 };
// Views the map picks by itself go no further out than this, however much they hold.
const FIT_MIN = 0.4;
// Below this, card names get too small to read at a glance; views the map picks by itself stay above it.
const READABLE = 0.9;
// A selected card this close to an edge, or under a floating panel, is brought further in.
const COMFORT = 56;
// Room kept clear around fitted cards; the bottom leaves space for the toolbar.
const PAD = { top: 48, right: 48, bottom: 84, left: 48 };
// Title type by level: the centre, the first level, the second, then everything further out.
const TITLE = [
  { px: 22, weight: 700, icon: 20 },
  { px: 15, weight: 700, icon: 14 },
  { px: 13, weight: 400, icon: 13 },
  { px: 12.5, weight: 400, icon: 13 },
] as const;
const titleAt = (depth: number) => TITLE[Math.min(depth, TITLE.length - 1)]!;
// Zoomed out, the centre and the first level grow to stay 12px on screen.
const scaleAt = (zoom: number) => Math.max(1, 12 / (TITLE[1].px * zoom));

type CardData = {
  graph: Graph;
  topic: Topic;
  head: number;
  id: string;
  h: number;
  w: number;
  /** Its file, when the card can open a preview of it, and whether that preview is open. */
  preview: { file: LocalFile; open: boolean } | null;
  /** In the tree, this card's result outputs: folded into a count, or opened as children. */
  fold: { ids: string[]; open: boolean } | null;
  /** How it stands to the topic in focus, and where that is written beside it. */
  mark: { text: string; dx: number; dy: number } | null;
  dim: boolean;
  selected: boolean;
  /** Picked with the box or with Shift / Ctrl, to move together. */
  picked: boolean;
  top: boolean;
  folded: number;
  /** Room past the title row for its count while it is closed. */
  count: number;
  /** All the room past the title row: the count, then the faces; its lines leave after it. */
  room: number;
  /** Shown cards hanging from it. */
  kids: number;
  touched: boolean;
  /** Its place among the sources of the draft being written, from 1; 0 when it is not there. */
  pin: number;
  /** Its place among the sources of the Card opened beside the map, and whether it changed since. */
  src: { n: number; changed: boolean } | null;
  /** The lanes doing or awaited by Cards for it, or for what is folded under it. */
  hands: { doing: string[]; waiting: string[] } | null;
};
type LinkData = {
  kind: "tree";
  dim: boolean;
  color?: string;
  weight?: number;
  /** A first-level branch is filled, narrowing from the first width to the second. */
  taper?: readonly [number, number];
  from: Rect;
  to: Rect;
  /** Four control points for the layout's cubic tree curve. */
  points?: readonly (readonly [number, number])[];
};
type SelectionLineData = {
  kind: SelectionLineKind;
  from: Rect;
  to: Rect;
  tip: string;
  route: ReturnType<typeof selectionPath>;
};
type Peek = { id: string; left: number; top: number; above: boolean };
/** The Cards listed under a topic's faces while the pointer is on them. */
type HandsPop = { id: string; left: number; top: number };
const HANDS_W = 340;
// Zoom buttons and keys answer at once; an eased step reads as lag.
const ZOOM_NOW = { duration: 0 };
// Held while dragging blank space, these draw the box instead of moving the map.
/** Card controls that act without selecting the card. */
type Actions = {
  onFold: (id: string) => void;
  onMore: (id: string) => void;
  /** Opens a card's folded result outputs as children, or folds them again. */
  onOutputs: (id: string) => void;
  /** Opens a preview of the card's file under it, or closes it. */
  onPreview: (id: string) => void;
  /** Lists the Cards behind a card's faces under them, or lets the list go. */
  onHands: (id: string | null, faces?: HTMLElement) => void;
};
const MapActions = createContext<Actions>({
  onFold: () => {},
  onMore: () => {},
  onOutputs: () => {},
  onPreview: () => {},
  onHands: () => {},
});

const descendants = (kidsOf: Shown["kidsOf"], id: string): number =>
  kidsOf(id).reduce((sum, c) => sum + 1 + descendants(kidsOf, c.id), 0);
const underIds = (kidsOf: Shown["kidsOf"], id: string): string[] =>
  kidsOf(id).flatMap((c) => [c.id, ...underIds(kidsOf, c.id)]);
/** Cards with children hidden: past the top level unless opened, and any closed by hand. */
function closedOf(
  kidsOf: Shown["kidsOf"],
  open: readonly string[],
  shut: readonly string[],
  focus: string | null = null,
  defaultDepth = 2,
) {
  const opened = new Set(open),
    shutting = new Set(shut);
  const out = new Set<string>();
  const walk = (id: string | null, depth: number) => {
    for (const c of kidsOf(id)) {
      if (!kidsOf(c.id).length) continue;
      if (shutting.has(c.id) || (depth >= defaultDepth && !opened.has(c.id))) out.add(c.id);
      else walk(c.id, depth + 1);
    }
  };
  if (focus && shutting.has(focus)) out.add(focus);
  walk(focus, 1);
  return out;
}
const changedAt = (graph: Graph, id: string) => {
  const head = graph.nodes.get(id)?.history[0];
  return head ? graph.commits.get(head)?.date : undefined;
};

function Handles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="edge-handle"
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="edge-handle"
        isConnectable={false}
      />
    </>
  );
}

// Pencil lines, lighter and finer with each level; the type icons carry the colour. First-level
// branches narrow from the centre's base line to their 2px underline. Summaries take the faintest line.
const lineTo = (depth: number, summary: boolean): Pick<LinkData, "color" | "weight" | "taper"> =>
  summary
    ? { color: "var(--map-faint)", weight: 1 }
    : depth <= 1
      ? { color: "var(--map-first)", taper: [4, 2] }
      : depth === 2
        ? { color: "var(--map-second)", weight: 1.2 }
        : { color: "var(--map-far)", weight: 1 };
const NodeCard = memo(function NodeCard({ data }: NodeProps<Node<CardData>>) {
  const { onFold, onOutputs, onPreview, onHands } = useContext(MapActions);
  const files = useFiles();
  const n = data.graph.nodes.get(data.id)!;
  const state = data.graph.states.get(data.id)!;
  const file = fileOf(n);
  const local = file?.kind === "file" ? file : null;
  const missing = !!local && infoOf(files, local.path) === null;
  const depth = data.topic.depth;
  const open = !!data.preview?.open;
  return (
    <div
      className={
        "mind-topic" +
        (depth === 0
          ? " is-centre"
          : depth === 1
            ? " is-first"
            : depth === 2
              ? " is-deeper"
              : " is-deeper is-far") +
        (data.folded ? " is-folded" : "") +
        (data.dim ? " is-dim" : "") +
        (data.selected ? " is-selected" : "") +
        (data.picked ? " is-picked" : "") +
        (state.deprecated ? " is-deprecated" : "") +
        (data.touched ? " is-touched" : "")
      }
      data-depth={depth}
      data-side={data.topic.side}
      style={
        {
          width: data.w,
          height: data.h,
          "--head": data.head + "px",
          "--count": data.count + "px",
          "--fork": (data.topic.side > 0 ? data.room : 0) + "px",
          "--fork-left": (data.topic.side < 0 ? data.room : 0) + "px",
        } as CSSProperties
      }
    >
      <Handles />
      <div className="mind-title" style={{ height: data.head }} title={n.name}>
        <span className="mind-label">
          {data.pin > 0 && (
            <span className="mind-pin" title={t.side.draftSource(data.pin)}>
              {data.pin}
            </span>
          )}
          <TypeGlyph type={n.type} size={titleAt(depth).icon} />
          <span className="mind-name">{n.name}</span>
        </span>
        {local && (
          <button
            type="button"
            className="mind-file nopan nodrag"
            disabled={!data.preview}
            aria-label={open ? t.map.closePreview : t.map.openPreview}
            onClick={(e) => {
              e.stopPropagation();
              onPreview(data.id);
            }}
          >
            <FileGlyph show={local.show} missing={missing} size={14} kind={primaryOf(n.type)} />
          </button>
        )}
        {state.deprecated && <span className="mind-mark">{t.map.status.archived}</span>}
        {(n.invalid || missing) && (
          <span
            className="mind-error"
            title={n.invalid ? (n.invalidReason ?? t.map.status.invalid) : t.map.status.missing}
          >
            {n.invalid ? t.map.status.invalid : t.map.status.missing}
          </span>
        )}
        {data.src && (
          <span className="num ref" title={t.side.cardSource(data.src.n)}>
            {data.src.n}
            {data.src.changed ? "*" : ""}
          </span>
        )}
        {data.fold?.open && (
          <button
            type="button"
            className="mind-control nopan nodrag"
            aria-label={t.map.foldOutputs}
            onClick={(e) => {
              e.stopPropagation();
              onOutputs(data.id);
            }}
          >
            <TypeGlyph type="output" size={11} />
            {data.fold.ids.length}
          </button>
        )}
      </div>
      {data.kids > 0 && (
        // On the fork, where the line leaves for the children: a dot while they are shown, a count when closed.
        <button
          type="button"
          className={"mind-fork nopan nodrag" + (data.folded ? " is-folded" : "")}
          aria-label={
            data.folded ? t.map.expandChildren(n.name, data.folded) : t.map.collapseChildren(n.name)
          }
          onClick={(e) => {
            e.stopPropagation();
            onFold(data.id);
          }}
        >
          {data.folded ? t.map.foldedTopics(data.folded) : null}
        </button>
      )}
      {data.hands && (
        // Outside the box: faces arriving with the Cards never move a topic.
        <span
          className="mind-hands nopan nodrag"
          role="button"
          tabIndex={-1}
          aria-label={t.map.handling.label}
          onPointerEnter={(e) => onHands(data.id, e.currentTarget)}
          onPointerLeave={() => onHands(null)}
          onClick={(e) => {
            e.stopPropagation();
            onHands(data.id, e.currentTarget);
          }}
        >
          <Hands doing={data.hands.doing} waiting={data.hands.waiting} />
        </span>
      )}
      {data.mark && (
        // Where the layout left room for it, beside the title row; it never moves the topic.
        <span className="mind-near" style={{ left: data.mark.dx, top: data.mark.dy }}>
          {data.mark.text}
        </span>
      )}
      {open && data.preview && <CardPreview file={data.preview.file} graph={data.graph} />}
    </div>
  );
});
type SummaryData = {
  kind: "more" | "outputs";
  parent: string;
  count: number;
  w: number;
};
function SummaryTopic({ data }: NodeProps<Node<SummaryData>>) {
  const { onOutputs, onMore } = useContext(MapActions);
  return (
    <div className="mind-summary" style={{ width: data.w }}>
      <Handles />
      <button
        className="nopan nodrag"
        type="button"
        onClick={() => (data.kind === "outputs" ? onOutputs(data.parent) : onMore(data.parent))}
      >
        {data.kind === "outputs" && <TypeGlyph type="output" size={12} />}
        {data.kind === "outputs" ? t.map.resultTopics(data.count) : t.map.moreTopics(data.count)}
      </button>
    </div>
  );
}
/** The project's name standing on the base line the first-level branches grow from. */
function CentreTopic({ data }: NodeProps<Node<{ name: string; w: number; h: number }>>) {
  return (
    <div className="mind-topic is-centre" style={{ width: data.w, height: data.h }}>
      <Handles />
      <div className="mind-title" style={{ height: data.h }} title={data.name}>
        <span className="mind-label">
          <span className="mind-name">{data.name}</span>
        </span>
      </div>
    </div>
  );
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<LinkData>>) {
  const state = data?.dim ? " is-dim" : "";
  if (data?.points && data.taper)
    return (
      <BaseEdge
        id={id}
        path={taper(data.points, ...data.taper)}
        style={{ fill: data.color, stroke: "none" }}
        className={`link link-tree${state}`}
      />
    );
  if (data?.points)
    return (
      <BaseEdge
        id={id}
        path={
          data.points.length === 4
            ? "M" +
              data.points[0]!.join(",") +
              " C" +
              data.points
                .slice(1)
                .map((p) => p.join(","))
                .join(" ")
            : rounded(data.points)
        }
        style={{ stroke: data.color, strokeWidth: data.weight }}
        className={`link link-tree${state}`}
      />
    );
  // Rounded elbow: siblings share one trunk, like an outline.
  const mid = sourceX + GAP / 2,
    r = Math.min(6, Math.abs(targetY - sourceY) / 2),
    dir = Math.sign(targetY - sourceY);
  const path =
    r < 1
      ? `M${sourceX},${sourceY} H${targetX}`
      : `M${sourceX},${sourceY} H${mid - r} Q${mid},${sourceY} ${mid},${sourceY + dir * r} V${targetY - dir * r} Q${mid},${targetY} ${mid + r},${targetY} H${targetX}`;
  return <BaseEdge id={id} path={path} className={`link link-tree${state}`} />;
}

/** A line through right-angled turns, each turn rounded. */
function rounded(points: readonly (readonly [number, number])[], r = 6) {
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!,
      [x, y] = points[i]!,
      [nx, ny] = points[i + 1]!;
    const k = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const ax = x - Math.sign(x - px) * k,
      ay = y - Math.sign(y - py) * k,
      bx = x + Math.sign(nx - x) * k,
      by = y + Math.sign(ny - y) * k;
    d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
  }
  const [ex, ey] = points.at(-1)!;
  return `${d} L${ex},${ey}`;
}

/** A line between two selected topics; its meaning shows on hover, beside it. */
function SelectionEdge({ id, data }: EdgeProps<Edge<SelectionLineData>>) {
  if (!data) return null;
  const { path, arrow, label } = data.route;
  const arrowed = data.kind === "link" || data.kind === "code" || data.kind === "card";
  return (
    <g className={`rline rline-${data.kind}`} data-line={id}>
      <path d={path} className="rline-hit" />
      <path d={path} className="rline-path" />
      {data.kind === "card" && <path d={path} className="rline-inner" />}
      {arrowed && <path d={arrow} className="rline-arrow" />}
      {label && (
        <text
          x={label.x}
          y={label.y}
          className="rline-label"
          textAnchor={label.anchor}
          dominantBaseline="middle"
        >
          {data.tip}
        </text>
      )}
      <title>{data.tip}</title>
    </g>
  );
}

/** A hover reads a Node's own file only when it is text or an image this small, so passing over cards stays light. */
const PEEK_BYTES = 1024 * 1024;

function PeekCard({ graph, peek }: { graph: Graph; peek: Peek }) {
  const files = useFiles();
  const n = graph.nodes.get(peek.id);
  if (!n) return null;
  const own = previewOf(n, files);
  const file =
    own &&
    (own.show === "text" || own.show === "image") &&
    (infoOf(files, own.path)?.size ?? Infinity) <= PEEK_BYTES
      ? own
      : null;
  const cites =
    n.links.filter((l) => l.ref?.kind === "node").length +
    n.materials.filter((m) => m.kind === "node").length;
  const citedBy = n.incoming.filter((i) => i.from.kind === "node").length;
  const changed = changedAt(graph, n.id);
  // What the card leaves out: its type and tags, and the lanes it went to in Cards.
  const lanes = graph
    .handedTo(n.id)
    .map((h: Hand) =>
      h.lane === PUBLIC
        ? t.work.public
        : (graph.roles.get(h.lane)?.title ?? t.work.goneRole(h.lane)),
    );
  const facts = [
    [n.type, ...n.tags].filter(Boolean).join(" · "),
    lanes.length > 0 && t.map.handedTo(lanes),
    changed && t.map.changedAgo(ago(changed)),
    n.childIds.length > 0 && t.map.children(n.childIds.length),
    cites > 0 && t.map.cites(cites),
    citedBy > 0 && t.map.citedBy(citedBy),
  ].filter(Boolean);
  // Until the snapshot is in, the map knows no summary; a peek with nothing else to say stays closed.
  if (!graph.detailed && !n.invalid && !file && facts.length === 0) return null;
  return (
    <div
      className={`panel map-peek${peek.above ? " is-above" : ""}`}
      style={{ left: peek.left, top: peek.top }}
      role="tooltip"
    >
      {n.invalid && (
        <div className="map-peek-flag is-invalid">
          <b>{t.map.invalidWhy(n.invalidReason)}</b>
          <span>{t.map.invalidNext}</span>
        </div>
      )}
      {n.description && <p>{n.description}</p>}
      {file && (
        <div className="map-peek-file">
          <CardPreview file={file} graph={graph} />
        </div>
      )}
      {facts.length > 0 && <div className="map-peek-meta">{facts.join(" · ")}</div>}
    </div>
  );
}

/**
 * Lines from the robot lit in the bar to the cards on screen that the Cards on its desk carry, drawn over
 * the map in screen space and redrawn as the map moves. From its row when the list is open, falling in
 * from the left of the row; from the stack of faces when it is closed, falling from the top of the map.
 */
function DeskWires({
  lane,
  ids,
  box,
}: {
  lane: string;
  ids: ReadonlySet<string>;
  box: RefObject<HTMLDivElement | null>;
}) {
  const transform = useStore((s) => s.transform);
  const [paths, setPaths] = useState<string[]>([]);
  // The list opening, a row opening or the window resizing moves where the lines start.
  const [moved, setMoved] = useState(0);
  useEffect(() => {
    const roles = document.querySelector(".roles");
    if (!roles) return;
    const watch = new ResizeObserver(() => setMoved((n) => n + 1));
    watch.observe(roles);
    const list = new MutationObserver(() => setMoved((n) => n + 1));
    list.observe(roles, { childList: true });
    return () => (watch.disconnect(), list.disconnect());
  }, [box]);
  useLayoutEffect(() => {
    const host = box.current;
    const row = document.querySelector(`.roles .dock [data-lane="${CSS.escape(lane)}"]`);
    const from = row?.querySelector(".lane-head") ?? row;
    const stack = document.querySelector(".roles .role-stack");
    if (!host || !(from || stack)) return setPaths([]);
    const o = host.getBoundingClientRect();
    const list = from?.closest(".dock")?.getBoundingClientRect();
    const next: string[] = [];
    for (const id of ids) {
      const card = host.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .mind-title`);
      if (!card) continue;
      const b = card.getBoundingClientRect();
      // Off screen, or under the open list.
      if (b.right < o.left || b.left > o.right || b.bottom < o.top || b.top > o.bottom) continue;
      if (list && b.right > list.left && b.left < list.right && b.top < list.bottom) continue;
      if (from) {
        const a = from.getBoundingClientRect();
        const x1 = a.left - o.left,
          y1 = a.top + a.height / 2 - o.top;
        const x2 = b.right - o.left,
          y2 = b.top + Math.min(b.height, 48) / 2 - o.top;
        if (x2 > x1 - 12) continue;
        const mx = x2 + (x1 - x2) / 2;
        next.push(`M${x1} ${y1}C${mx} ${y1},${mx} ${y2},${x2} ${y2}`);
      } else {
        const a = stack!.getBoundingClientRect();
        const x1 = a.left + a.width / 2 - o.left,
          y1 = Math.max(0, a.bottom - o.top);
        const x2 = b.left + b.width / 2 - o.left,
          y2 = b.top - o.top;
        if (y2 < y1 + 12) continue;
        const my = y1 + (y2 - y1) / 2;
        next.push(`M${x1} ${y1}C${x1} ${my},${x2} ${my},${x2} ${y2}`);
      }
    }
    setPaths((was) => (was.join() === next.join() ? was : next));
  }, [lane, ids, transform, box, moved]);
  if (!paths.length) return null;
  return (
    <svg className="desk-wires" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const nodeTypes = { node: NodeCard, centre: CentreTopic, summary: SummaryTopic };
const edgeTypes = { link: LinkEdge, selection: SelectionEdge };
const NOTHING: ReadonlySet<string> = new Set();
const NO_NODES: Node[] = [];
const NO_EDGES: Edge[] = [];
const KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Filters = { types: Record<Primary, boolean> };

type MapProps = {
  graph: Graph;
  /** Successful fresh Core map observations, independent of document/topology revision. */
  factsEpoch: number;
  onFirstLayout: () => void;
  initialCanvas: import("./canvas.js").CanvasInitial;
  selected: SnapshotRef | null;
  /** The draft being written: its sources in order (null for an address outside Tent). */
  draft: (string | null)[];
  /** The robot lit in the dock, and the Nodes the Cards on a robot's desk carry. */
  hotLane: string | null;
  carriedBy: (lane: string) => ReadonlySet<string>;
  /** Whether arrow keys, Enter and Space drive the map right now. */
  keys: boolean;
  onSelect: (ref: SnapshotRef | null, historical?: HistoricalSelection) => void;

  onExpand: () => void;
  /** A short message for the page to show, such as a save that lost to one made elsewhere. */
  onNotice: (message: string) => void;
};

export function MapView(props: MapProps) {
  return (
    <ReactFlowProvider key={props.graph.snapshot.workspace.id}>
      <MapContent {...props} />
    </ReactFlowProvider>
  );
}

function MapContent({
  graph: currentGraph,
  factsEpoch,
  onFirstLayout,
  initialCanvas,

  selected,
  draft,
  hotLane,
  carriedBy,
  keys,
  onSelect: select,

  onExpand,
  onNotice,
}: MapProps) {
  // null means now; otherwise an index into the retained commits, oldest first.
  const [time, setTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Historical browsing never borrows or changes the saved current canvas projection.
  const [pastFolds, setPastFolds] = useState(emptyCanvas);
  const [pastFocus, setPastFocus] = useState<string | null>(null);
  const [pastOutputs, setPastOutputs] = useState<ReadonlySet<string>>(() => new Set());
  const history = useMemo(
    () => ({ commits: [...currentGraph.snapshot.commits].reverse() }),
    [currentGraph.snapshot.commits],
  );
  const moment = time === null ? null : (history.commits[time] ?? null);
  const previousMoment = useRef<string | null>(null);
  useEffect(() => {
    const commit = moment?.hash ?? null;
    if (previousMoment.current !== commit) select(null);
    previousMoment.current = commit;
  }, [moment?.hash, select]);
  const reads = useMemo(
    () => new HistoryTrees(api.historyTree),
    [currentGraph.snapshot.workspace.id],
  );
  const [past, setPast] = useState<{
    commit: string | null;
    tree: HistoryTree | null;
    error?: unknown;
  }>({ commit: null, tree: null });
  useEffect(
    () =>
      reads.select(moment?.hash ?? null, (tree, error) =>
        setPast({ commit: moment?.hash ?? null, tree, error }),
      ),
    [reads, moment?.hash],
  );
  const pastTree = past.commit === moment?.hash ? past.tree : null;
  const graph = useMemo(
    () => historyViewGraph(currentGraph, time === null ? null : (moment?.hash ?? ""), pastTree),
    [time === null, moment?.hash, currentGraph, pastTree],
  );
  const onSelect = useCallback(
    (ref: SnapshotRef | null) => {
      if (time === null || !ref) return select(ref);
      const node = ref.kind === "node" ? graph.nodes.get(ref.id) : undefined;
      if (node && moment && pastTree)
        select(ref, { node, version: { commit: moment.hash, path: node.notePath } });
    },
    [time === null, select, graph, moment, pastTree],
  );
  const exists = useCallback((id: string) => graph.nodes.has(id), [graph]);
  const [filters, setFilters] = useState<Filters>(() => {
    const stored = readStored<Partial<Filters>>("tent-map-filters-v2", {});
    return {
      types: { goal: true, prompt: true, output: true, ...stored.types },
    };
  });
  const [hover, setHover] = useState<string | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const handling = useHandling();
  const [handsPop, setHandsPop] = useState<HandsPop | null>(null);
  const handsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(handsTimer.current), []);
  const [keyOpen, setKeyOpen] = useState(false);
  // Space held: the hand. Whether the map moved while it was held, so letting go does not also fold.
  const [hand, setHand] = useState(false);
  const handHeld = useRef(false);
  const handUsed = useRef(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [lens, setLensSession] = useState<LensSession | null>(null);
  const lensReturn = useRef<Viewport | null>(null);
  const revealTarget = useRef<string | null>(null);
  const setLens = useSteady((change: boolean | ((on: boolean) => boolean)) => {
    const on = typeof change === "function" ? change(!!lens) : change;
    if (on === !!lens) return;
    setMotion(null);
    initialView.current = false;
    fittingAll.current = false;
    if (on) {
      if (selected?.kind !== "node" || !visible(selected.id)) return;
      setPicked(new Set());
      setLensOutside(new Set());
      setLensSession(
        beginLens({
          selectedId: selected.id,
          viewport: flow.getViewport(),
          open: canvas.open,
          shut: canvas.shut,
          focus: storedTreeFocus,
          outputs: storedOutputs,
          previews: storedPreviews,
          anchor: foldAnchor.current,
        }),
      );
    } else {
      focusMove.current = null;
      foldAnchor.current = lens!.anchor;
      lensReturn.current = lens!.viewport;
      revealTarget.current = null;
      const nextSelection = selectionAfterLens(lens!, selected, visible);
      if (nextSelection !== selected) onSelect(nextSelection);
      setLensSession(null);
    }
  });
  const [outside, setOutside] = useState(0);
  const [lensOutside, setLensOutside] = useState<ReadonlySet<string>>(() => new Set());
  const [ready, setReady] = useState(false);
  const [treeReady, setTreeReady] = useState(false);
  useEffect(() => {
    if (treeReady) onFirstLayout();
  }, [treeReady, onFirstLayout]);
  const initialView = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const flow = useReactFlow();
  useEffect(() => writeStored("tent-map-filters-v2", filters), [filters]);
  // Archived Nodes and everything under them stay off the map and out of its numbers; the sidebar
  // still lists them.
  const archived = useMemo(() => {
    const out = new Set<string>();
    const walk = (id: string) => {
      out.add(id);
      graph.nodes.get(id)?.childIds.forEach(walk);
    };
    for (const [id, state] of graph.states) if (state.deprecated && !out.has(id)) walk(id);
    return out;
  }, [graph]);
  const typeCounts = useMemo(() => {
    const out: Record<Primary, number> = { goal: 0, prompt: 0, output: 0 };
    for (const n of graph.snapshot.nodes) if (!archived.has(n.id)) out[primaryOf(n.type)]++;
    return out;
  }, [graph, archived]);
  const visible = useCallback(
    (id: string) => {
      const n = graph.nodes.get(id);
      return !!n && !archived.has(id) && filters.types[primaryOf(n.type)];
    },
    [graph, archived, filters.types],
  );
  // The tree with switched-off types taken out: everything below lays out, folds and counts on this.
  const shown = useMemo(() => shownTree(graph, visible), [graph, visible]);

  const touched = useMemo(
    () => new Set(moment?.files.flatMap((f) => (f.ref?.kind === "node" ? [f.ref.id] : [])) ?? []),
    [moment],
  );
  const last = history.commits.length - 1;
  useEffect(() => {
    if (!playing) return;
    if (time === null || time >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setTime((i) => (i ?? 0) + 1), 900);
    return () => clearTimeout(t);
  }, [playing, time, last]);
  // The timeline steps through the history the snapshot brings: asked for first, opened once it is in.
  const want = useContext(DetailsContext);
  const [timeAsked, setTimeAsked] = useState(false);
  const openTime = () => {
    setLens(false);
    setInkTool(null);
    currentAnchor.current = foldAnchor.current;
    foldAnchor.current = undefined;
    fittingAll.current = false;
    setPicked(new Set());
    setMotion(null);
    setHandsPop(null);
    setPastFolds(emptyCanvas());
    setPastFocus(null);
    setPastOutputs(new Set());
    if (!currentGraph.detailed) {
      want();
      setTimeAsked(true);
      return;
    }
    setTime(last);
  };
  useEffect(() => {
    if (!timeAsked || !currentGraph.detailed) return;
    setTimeAsked(false);
    setTime(last);
  }, [timeAsked, currentGraph.detailed, last]);
  const closeTime = () => {
    foldAnchor.current = currentAnchor.current;
    focusMove.current = null;
    fittingAll.current = false;
    setMotion(null);
    setPlaying(false);
    setTime(null);
  };
  const play = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (time === null || time >= last) setTime(0);
    setPlaying(true);
  };
  const timeOpen = time !== null;
  useEffect(() => {
    if (timeOpen) range.current?.focus();
  }, [timeOpen]);

  const card = selected?.kind === "card" ? graph.cards.get(selected.id) : undefined;
  const sources = useMemo(() => {
    if (!card) return null;
    // The draft being written numbers its sources itself (the orange pins); a published Card gets its order.
    if (isDraft(card))
      return { ids: new Set(draft.filter((id): id is string => !!id)), order: null };
    const order = new Map<string, { n: number; changed: boolean }>();
    card.sources.forEach((s, i) => {
      if (s.id && !order.has(s.id)) order.set(s.id, { n: i + 1, changed: s.changedSince });
    });
    return { ids: new Set(order.keys()), order };
  }, [card, draft]);
  const pins = useMemo(
    () => new Map((time === null ? draft : []).map((id, i) => [id, i + 1] as const)),
    [draft, time === null],
  );
  const lensId =
    time === null && lens && selected?.kind === "node" && visible(selected.id) ? selected.id : null;
  // Details fill in references, declared materials and Cards after the map topology.

  useWantDetails(!!lensId && !graph.detailed);

  // ---------- drawing ----------
  // Drawings stay out of relationship reading and past moments. null: drawing is off.
  const canvas = useCanvas(
    graph.snapshot.workspace.id,
    graph.snapshot.workspace.revision,
    onNotice,
    initialCanvas,
  );
  const ink = canvas;
  const [inkTool, setInkTool] = useState<InkTool | null>(null);
  const [inkLocked, setInkLocked] = useState(false);
  const [inkPicked, setInkPicked] = useState<ReadonlySet<string>>(() => new Set());
  // The drawings as a gesture would leave them, while it is on.
  const [inkPreview, setInkPreview] = useState<Ink[] | null>(null);
  const [inkHints, setInkHints] = useState<InkHints>(NO_HINTS);
  const [inkWriting, setInkWriting] = useState<Writing | null>(null);
  const [inkStyle, setInkStyle] = useState<InkStyle>(INK_STYLE);
  const [inkSizes, setInkSizes] = useState<Sizes>(() => new Map());
  const inkClip = useRef<Ink[]>([]);
  const inkShown = !lensId && time === null;
  const inking = inkTool !== null && inkShown;
  useEffect(() => {
    if (inkTool) setPeek(null);
    else {
      // Leaving mid-gesture drops it: nothing half drawn stays on the map.
      setInkPicked(new Set());
      setInkWriting(null);
      setInkPreview(null);
      setInkHints(NO_HINTS);
    }
  }, [inkTool]);
  // Picking belongs to select: the other tools start with nothing picked.
  useEffect(() => {
    if (inkTool && inkTool !== "select") setInkPicked(new Set());
  }, [inkTool]);
  // Drawings undone away are no longer picked.
  useEffect(() => {
    const ids = new Set(ink.ink.map((d) => d.id));
    setInkPicked((p) =>
      [...p].every((id) => ids.has(id)) ? p : new Set([...p].filter((id) => ids.has(id))),
    );
  }, [ink.ink]);
  useEffect(() => {
    if (lens && (selected?.kind !== "node" || !visible(selected.id))) setLens(false);
  }, [lens, selected?.kind, selected?.id, visible, setLens]);

  const [storedOutputs, setStoredOutputs] = useState<ReadonlySet<string>>(() => new Set());
  const openOutputs = time !== null ? pastOutputs : lens ? lens.outputs : storedOutputs;
  const setOpenOutputs = useSteady((change: (open: ReadonlySet<string>) => ReadonlySet<string>) => {
    if (time !== null) setPastOutputs(change);
    else if (lens) setLensSession({ ...lens, outputs: change(lens.outputs) });
    else setStoredOutputs(change);
  });
  // Cards showing a preview of their file: kept in this browser only, like what is folded.
  const files = useFiles();
  const previewKey = `tent-map-previews:${graph.snapshot.workspace.id}`;
  const [storedPreviews, setStoredPreviews] = useState<ReadonlySet<string>>(
    () => new Set(readStored<string[]>(previewKey, [])),
  );
  const previews = lens ? lens.previews : storedPreviews;
  const setPreviews = useSteady((change: (open: ReadonlySet<string>) => ReadonlySet<string>) => {
    if (lens) setLensSession({ ...lens, previews: change(lens.previews) });
    else setStoredPreviews(change);
  });
  const previewFile = useCallback(
    (id: string) => {
      const n = graph.nodes.get(id);
      return time === null && n ? previewOf(n, files) : null;
    },
    [graph, files, time === null],
  );
  const grown = useCallback(
    (id: string) => {
      const file = previews.has(id) ? previewFile(id) : null;
      return file ? previewHeight(file) : 0;
    },
    [previews, previewFile],
  );
  // Cards picked with the box or with Shift / Ctrl.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [storedTreeFocus, setTreeFocus] = useState<string | null>(null);
  const treeFocus = time !== null ? pastFocus : lens ? lens.focus : storedTreeFocus;
  const focusViews = useRef(new Map<string, Viewport>());
  const focusMove = useRef<Viewport | "fit" | null>(null);
  const [focusMenu, setFocusMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const enterFocus = useSteady((id: string | null) => {
    initialView.current = false;
    if (id === treeFocus) {
      setFocusMenu(null);
      return;
    }
    if (!lens && time === null) focusViews.current.set(treeFocus ?? CENTRE, flow.getViewport());
    focusMove.current =
      lens || time !== null ? "fit" : (focusViews.current.get(id ?? CENTRE) ?? "fit");
    foldAnchor.current = undefined;
    setMotion(null);
    setFocusMenu(null);
    setPeek(null);
    setPicked(new Set());
    if (time !== null) setPastFocus(id);
    else if (lens) setLensSession({ ...lens, focus: id });
    else setTreeFocus(id);
  });
  /** One level up from the topic entered: its nearest shown parent, or the whole map. */
  const focusUp = treeFocus
    ? ([...graph.ancestors(treeFocus)].reverse().find((n) => visible(n.id))?.id ?? null)
    : null;
  useEffect(() => {
    if (
      (time === null || pastTree) &&
      treeFocus &&
      (!graph.nodes.has(treeFocus) || !visible(treeFocus))
    ) {
      const id = [...graph.ancestors(treeFocus)].reverse().find((n) => visible(n.id))?.id ?? null;
      if (lens) setLensSession({ ...lens, focus: id });
      else enterFocus(id);
    }
  }, [treeFocus, graph, visible, enterFocus, lens, time === null, pastTree]);
  const foldAnchor = useRef<{ id: string; at: [number, number] } | undefined>(undefined);
  const currentAnchor = useRef<typeof foldAnchor.current>(undefined);
  const arrange = useSteady((change: { folds?: Record<string, Fold | null> }) => {
    if (time !== null) {
      setPastFolds((file) =>
        withPending(file, {
          folds: new Map(Object.entries(change.folds ?? {})),
          drawings: new Map(),
        }),
      );
      return;
    }
    if (lens) setLensSession(foldInLens(lens, change.folds ?? {}));
    else canvas.arrange(change);
  });
  const opened = time !== null ? pastFolds.open : lens ? lens.open : canvas.open;
  const shut = time !== null ? pastFolds.shut : lens ? lens.shut : canvas.shut;
  const [defaultDepth, setDefaultDepth] = useState(2);
  const topicScale = useStore((s) => scaleAt(s.transform[2]));
  // Second-level names under 10px on screen give way to their lines.
  const distant = useStore((s) => TITLE[2].px * s.transform[2] < 10);
  const fittingAll = useRef(false);
  // Two levels show by default; cards opened past them or closed within them are kept in the canvas file.
  // Only a change in what is closed makes a new layout.
  const closedNow = useMemo(
    () => closedOf(shown.kidsOf, opened, shut, treeFocus, defaultDepth),
    [shown, opened, shut, treeFocus, defaultDepth],
  );
  const foldKey = [...closedNow].sort().join();
  const folded = useMemo(() => closedNow, [foldKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Quantize the view aspect so small resizes do not repeatedly lay out the tree.
  const [aspect, setAspect] = useState(1.6);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const take = () =>
      el.clientHeight > 0 &&
      setAspect(Math.round((clearWidth() / el.clientHeight) * 10) / 10 || 1.6);
    take();
    const watch = new ResizeObserver(take);
    watch.observe(el);
    return () => watch.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const textWidth = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const family = getComputedStyle(document.body).fontFamily;
    return (text: string, size: number, weight = 400) => {
      ctx.font = `${weight} ${size}px ${family}`;
      return ctx.measureText(text).width;
    };
  }, []);
  const measureTopic = useCallback(
    (id: string, depth: number) => {
      const n = graph.nodes.get(id);
      const name = n?.name ?? graph.snapshot.workspace.name;
      const type = titleAt(depth),
        scale = depth < 2 ? topicScale : 1;
      const font = type.px * scale;
      const letters = textWidth(name, font, type.weight);
      // The title row as drawn: the underlined icon and name, then only the marks this topic has.
      // Nothing is kept for a mark it lacks; the fold switch sits outside, on the fork.
      const parts = [letters];
      if (n) parts.push(type.icon * scale);
      const local = n && fileOf(n);
      const file = local?.kind === "file" ? local : null;
      if (file) parts.push(18);
      if (n && graph.states.get(id)?.deprecated) parts.push(textWidth(t.map.status.archived, 11));
      if (n?.invalid) parts.push(textWidth(t.map.status.invalid, 10.5));
      else if (file && infoOf(files, file.path) === null)
        parts.push(textWidth(t.map.status.missing, 10.5));
      const source = sources?.order?.get(id);
      if (source)
        parts.push(
          Math.max(17, 8 + textWidth(`${source.n}${source.changed ? "*" : ""}`, 10.5, 700)),
        );
      if (openOutputs.has(id)) {
        const results = shown.kidsOf(id).filter((child) => isResult(graph, child.id)).length;
        if (results) parts.push(17 + textWidth(String(results), font, type.weight));
      }
      // The underline reaches 5px past the icon and name, the centre's base line 6px.
      return {
        w: Math.ceil(
          parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * 5 + (depth === 0 ? 13 : 11),
        ),
        h: Math.max(
          depth === 0 ? TOPIC.centre : depth === 1 ? TOPIC.first : TOPIC.deeper,
          Math.ceil(font + (depth === 0 ? 14 : 8)),
        ),
      };
    },
    [graph, shown, textWidth, openOutputs, sources, topicScale, files],
  );
  // A "n more" or "n outputs" item: its words, the output icon, and the button padding.
  const measureSummary = useCallback(
    (kind: "more" | "outputs", count: number) =>
      Math.ceil(
        14 +
          (kind === "outputs" ? 16 : 0) +
          textWidth(kind === "outputs" ? t.map.resultTopics(count) : t.map.moreTopics(count), 12.5),
      ),
    [textWidth],
  );
  // The count a closed topic shows on its fork: plain small words, with the underline running on below.
  const measureFold = useCallback(
    (id: string) => Math.ceil(4 + textWidth(t.map.foldedTopics(descendants(shown.kidsOf, id)), 11)),
    [shown, textWidth],
  );
  // What the map lists, known before anything is measured, so the faces can be measured into the layout.
  const listing = useMemo(
    () =>
      listed({
        kidsOf: shown.kidsOf,
        closed: folded,
        results: (_id, kids) => kids.filter((c) => isResult(graph, c.id)).map((c) => c.id),
        openOutputs,
        open: new Set(opened),
        focus: treeFocus,
      }),
    [graph, shown, folded, openOutputs, opened, treeFocus],
  );
  // Each Card on the cards that show its Nodes: a folded, summed up or switched-off Node passes its Cards
  // to the nearest card shown above it, so work under a fold stays in sight.
  const handsAt = useMemo(
    () =>
      time !== null
        ? new Map<string, Handling[]>()
        : handlingOnTopics(
            handling,
            shown.upOf,
            (id) => listing.has(id) && visible(id) && !(distant && listing.get(id)! >= 2),
            exists,
          ),
    [handling, listing, shown, visible, exists, distant, time === null],
  );
  // At most two faces and "+n", as Hands draws them: 18px rings 2px apart.
  const measureHands = useCallback(
    (id: string) => {
      const list = handsAt.get(id);
      if (!list) return 0;
      const { doing, waiting } = handsOf(list);
      const lanes = doing.length + waiting.length,
        faces = Math.min(2, lanes);
      const more = lanes > 2 ? 3 + textWidth(t.map.handling.more(lanes - 2), 10) : 0;
      return Math.ceil(faces * 18 + (faces - 1) * 2 + more);
    },
    [handsAt, textWidth],
  );
  const laid = useMemo(
    () =>
      arrangeMap({
        kidsOf: shown.kidsOf,
        closed: folded,
        results: (_id, kids) => kids.filter((c) => isResult(graph, c.id)).map((c) => c.id),
        openOutputs,
        open: new Set(opened),
        focus: treeFocus,
        anchor: foldAnchor.current,
        measure: measureTopic,
        foldWidth: measureFold,
        handsWidth: measureHands,
        summaryWidth: measureSummary,
        grown,
        aspect,
        defaultDepth,
      }),
    [
      graph,
      shown,
      folded,
      openOutputs,
      grown,
      aspect,
      treeFocus,
      opened,
      measureTopic,
      measureFold,
      measureHands,
      measureSummary,
      defaultDepth,
    ],
  );
  const previousTree = useRef<{ graph: Graph; layout: typeof laid } | null>(null);
  const base = useMemo(
    () =>
      time !== null && previousTree.current
        ? historyLayout(previousTree.current, graph, laid)
        : laid,
    [laid, graph, time === null],
  );
  useLayoutEffect(() => {
    // Empty loading/error frames cannot discard the last known coordinates.
    if (time === null || pastTree) previousTree.current = { graph, layout: base };
  }, [graph, base, time === null, pastTree]);

  // Node cards a drawn line can hold on to, where they stand. It holds only for the look.
  const cardAnchors = useMemo<Anchor[]>(
    () =>
      inkShown
        ? [...base.placed.values()]
            .filter((p) => visible(p.id) && exists(p.id))
            .map((p) => ({ id: p.id, box: rectOf(p), shape: "rect" as const }))
        : [],
    [inkShown, base, visible, exists],
  );
  const inkContext = useMemo<InkContext>(
    () => ({
      topics: new Map(
        [...base.placed.values()]
          .filter((p) => visible(p.id) && exists(p.id))
          .map((p) => [p.id, [p.x + p.w / 2, p.y]]),
      ),
      existingIds: new Set(graph.nodes.keys()),
      centre: { id: treeFocus ?? CENTRE, at: [base.centre.x + base.centre.w / 2, base.centre.y] },
    }),
    [base, graph, visible, exists, treeFocus],
  );
  const projected = useMemo(() => projectInk(ink.ink, inkContext), [ink.ink, inkContext]);
  const drawn = useMemo(
    () => settle(projected.visible, anchorsOf(projected.visible, cardAnchors)),
    [projected, cardAnchors],
  );
  const projectedAll = useMemo(
    () => withChanges(projected.all, inkChanges(projected.visible, drawn)),
    [projected, drawn],
  );
  const commitGeometry = (changes: Map<string, Ink | null>, picks?: Picks) => {
    const attached = new Map(
      [...changes].map(([id, d]) => [id, d ? attachInk(d, inkContext, inkSizes) : null] as const),
    );
    ink.commit((all) => withChanges(all, attached), picks);
  };
  const inkLive = useRef({ settled: drawn, inkPicked, undo: () => {}, redo: () => {} });
  inkLive.current = { settled: drawn, inkPicked, undo: () => undo(), redo: () => redo() };
  /** A change worked out on the drawings as shown, laid over them as they are when it lands. */
  const inkChange = (next: Ink[], picks?: Picks, geometry = false) => {
    const changes = inkChanges(inkLive.current.settled, next);
    if (changes.size) {
      if (geometry) commitGeometry(changes, picks);
      else ink.commit((all) => withChanges(all, changes), picks);
    }
  };
  // Undo and redo pick again what was picked on the side they step to.
  const undo = () => {
    if (lens || time !== null) return;

    const back = canvas.undo();
    if (back && inking) setInkPicked(new Set(back));
  };
  const redo = () => {
    if (lens || time !== null) return;

    const back = canvas.redo();
    if (back && inking) setInkPicked(new Set(back));
  };
  // A line end held by a card keeps where it last met it, so it stays there when the card is hidden.
  useEffect(() => {
    if (time !== null || !treeReady || !ink.ready || inkPreview) return;
    const met = inkChanges(ink.ink, projectedAll);
    if (met.size) ink.keep(met);
  }, [projectedAll, treeReady, ink.ready, inkPreview, time === null]);

  const inkAct = (a: InkAct) => {
    const { settled: all, inkPicked: picked } = inkLive.current;
    const list = all.filter((d) => picked.has(d.id));
    if (!list.length) return;
    const before = [...picked];
    if (a === "delete") {
      inkChange(
        all.filter((d) => !picked.has(d.id)),
        { before, after: [] },
      );
      setInkPicked(new Set());
    } else if (a === "copy") {
      const z = topLayer(all);
      const made = copiesOf(list, 16, (d) => newId(d.kind)).map((d, i) => ({ ...d, z: z + i }));
      const after = made.map((d) => d.id);
      inkChange([...all, ...made], { before, after }, true);
      setInkPicked(new Set(after));
    } else inkChange(restack(all, picked, a), { before, after: before });
  };
  const inkSet = (change: InkSet) => {
    if ("color" in change) setInkStyle((s) => ({ ...s, color: change.color }));
    if ("fill" in change) setInkStyle((s) => ({ ...s, fill: change.fill }));
    if ("dash" in change) setInkStyle((s) => ({ ...s, dash: change.dash }));
    const { settled: all, inkPicked: picked } = inkLive.current;
    if (picked.size)
      inkChange(
        all.map((d) => (picked.has(d.id) ? restyle(d, change) : d)),
        { before: [...picked], after: [...picked] },
      );
  };
  // Words close into the drawings as they are then, which may have changed while they were open.
  const openWords = (w: Writing) => setInkWriting({ ...w, before: [...inkLive.current.inkPicked] });
  const writeWords = (w: Writing, value: string | null) => {
    setInkWriting((open) => (open === w ? null : open));
    if (w.fresh && !value?.trim()) return;
    // An emptied text goes; an emptied label leaves its shape.
    const gone =
      !w.fresh &&
      value !== null &&
      !value.trim() &&
      inkLive.current.settled.find((d) => d.id === w.id)?.kind === "text";
    const now = [...inkLive.current.inkPicked];
    ink.commit(
      (all) =>
        withWords(w.fresh ? [...all, attachInk(w.fresh, inkContext, inkSizes)] : all, w.id, value),
      {
        before: w.before ?? now,
        after: gone ? now.filter((id) => id !== w.id) : now,
      },
    );
  };
  useEffect(() => {
    if (!inking || !keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.body.classList.contains("is-dragging")) return;
      const el = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return;
      const { settled: all, inkPicked: picked } = inkLive.current;
      const list = all.filter((d) => picked.has(d.id));
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (picked.size) setInkPicked(new Set());
        else setInkTool(null);
      } else if (mod && key === "z") (e.shiftKey ? inkLive.current.redo : inkLive.current.undo)();
      else if (mod && key === "y") inkLive.current.redo();
      else if (mod && key === "a") {
        setInkTool("select");
        setInkPicked(new Set(all.map((d) => d.id)));
      } else if (mod && key === "d" && list.length) inkAct("copy");
      else if (mod && key === "c" && list.length) inkClip.current = list;
      else if (mod && key === "v" && inkClip.current.length) {
        const z = topLayer(all);
        const made = copiesOf(inkClip.current, 24, (d) => newId(d.kind)).map((d, i) => ({
          ...d,
          z: z + i,
        }));
        inkClip.current = made;
        const after = made.map((d) => d.id);
        inkChange([...all, ...made], { before: [...picked], after }, true);
        setInkTool("select");
        setInkPicked(new Set(after));
      } else if (mod && (e.key === "]" || e.key === "}") && list.length)
        inkAct(e.shiftKey ? "front" : "up");
      else if (mod && (e.key === "[" || e.key === "{") && list.length)
        inkAct(e.shiftKey ? "back" : "down");
      else if (mod || e.altKey) return;
      else if ((e.key === "Delete" || e.key === "Backspace") && list.length) inkAct("delete");
      else if (e.key === "Enter" && list.length === 1 && list[0].kind !== "pen")
        openWords({ id: list[0].id });
      else if (e.key.startsWith("Arrow") && list.length) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
          dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        inkChange(
          all.map((d) => (picked.has(d.id) ? loosen(moveBy(d, dx, dy), picked) : d)),
          { before: [...picked], after: [...picked] },
          true,
        );
      } else if (key === "q") setInkLocked((l) => !l);
      else if (key === "h") setInkTool("hand");
      else {
        const hit = INK_TOOLS.find((x) => x.key === key);
        if (!hit) return;
        setInkTool(hit.tool);
      }
      // Capture on the window runs before the page's own keys, which then never see these.
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inking, keys, ink]);
  // The style panel stands clear of the dock, which folds while the pen is out.
  const [inkLeft, setInkLeft] = useState(12);
  useLayoutEffect(() => {
    if (!inking) return;
    const el = box.current?.querySelector<HTMLElement>(".dock");
    if (!el) return setInkLeft(12);
    const put = () => setInkLeft(el.offsetLeft + el.offsetWidth + 8);
    put();
    const watch = new ResizeObserver(put);
    watch.observe(el);
    return () => watch.disconnect();
  }, [inking]);

  // ---------- facts among the current selection ----------
  const members = useMemo(() => {
    if (time !== null) return new Map<string, string[]>();
    const ids = [...picked].filter((id) => base.placed.has(id) && visible(id) && exists(id));
    return new Map(ids.length > 1 ? [["selection", ids]] : []);
  }, [picked, base, visible, exists, time === null]);
  const code: readonly CodeEdge[] = graph.snapshot.modules?.edges ?? NO_CODE;
  useWantDetails(time === null && !graph.detailed && members.size > 0);
  // The faces on topics come from the Card list the dock reads, asked for once the first layout is placed.
  useWantDetails(time === null && !graph.detailed && treeReady);
  const lines = useMemo(
    () =>
      new Map([...members].map(([id, ids]) => [id, selectionLines(graph, ids, shown.upOf, code)])),
    [members, graph, shown, code],
  );
  const [picturing, setPicturing] = useState(false);
  const [pictureFailed, setPictureFailed] = useState(false);
  // Selected outputs that meet a goal are compared with it by Core, on demand; material changes
  // move no revision, so each sync asks again.
  const [held, setHeld] = useState<Answer | null>(null);
  const [asked, setAsked] = useState({ key: "", ask: 0 });
  const toCompare = useMemo(
    () =>
      [
        ...new Set(
          [...members.values()].flatMap((ids) =>
            ids.length > 1 ? outputsToCompare(graph, ids.filter(visible)) : [],
          ),
        ),
      ].sort(),
    [members, graph, visible],
  );
  const workspaceId = graph.snapshot.workspace.id;
  const compareKey =
    graph.detailed && toCompare.length ? `${workspaceId}:${toCompare.join(" ")}` : "";
  const asks = useRef(0);
  useEffect(() => {
    if (!compareKey) return;
    const ask = { key: compareKey, ask: ++asks.current };
    setAsked(ask);
    // A late answer to an earlier ask is dropped; the held one only counts for the ask it answered.
    let current = true;
    api
      .compareOutputs(toCompare)
      .then(
        (list) =>
          current &&
          setHeld({ ...ask, map: new Map(list.map((c) => [c.nodeId, c])), failed: false }),
      )
      .catch(() => current && setHeld({ ...ask, map: new Map(), failed: true }));
    return () => {
      current = false;
    };
  }, [compareKey, graph.snapshot.workspace.revision, factsEpoch]);
  const compared = useMemo(
    () => comparisonsFor(held, asked, compareKey),
    [held, asked, compareKey],
  );
  // When the selected rules and outputs last changed or were recorded, for "对照" and "前后"; they
  // move only with commits, so each revision asks again.
  const toTime = useMemo(
    () =>
      [
        ...new Set(
          [...members.values()].flatMap((ids) =>
            ids.length > 1
              ? ids.filter(
                  (id) =>
                    visible(id) && ["prompt", "output"].includes(graph.nodes.get(id)?.type ?? ""),
                )
              : [],
          ),
        ),
      ].sort(),
    [members, graph, visible],
  );
  const revision = graph.snapshot.workspace.revision;
  const timeKey =
    graph.detailed && toTime.length ? `${workspaceId}@${revision}:${toTime.join(" ")}` : "";
  const [heldTimes, setHeldTimes] = useState<TimesAnswer | null>(null);
  const [askedTimes, setAskedTimes] = useState({ key: "", ask: 0 });
  const timeAsks = useRef(0);
  useEffect(() => {
    if (!timeKey) return;
    const ask = { key: timeKey, ask: ++timeAsks.current };
    setAskedTimes(ask);
    // A late answer to an earlier ask is dropped; a failure clears what the last answer said.
    let current = true;
    api
      .nodeTimes(toTime)
      .then(
        (list) =>
          current &&
          setHeldTimes({
            ...ask,
            map: new Map(list.map(({ nodeId, ...time }) => [nodeId, time])),
            failed: false,
          }),
      )
      .catch(() => current && setHeldTimes({ ...ask, map: noTimes, failed: true }));
    return () => {
      current = false;
    };
  }, [timeKey]);
  // Checked against the key of this render, not only the last ask: the ask for a new key is made after it.
  const timed = useMemo(
    () => timesFor(heldTimes, askedTimes, timeKey),
    [heldTimes, askedTimes, timeKey],
  );
  const reactions = useMemo(() => {
    const out = new Map<string, Reaction[]>();
    if (!graph.detailed) return out;
    for (const [rid, ids] of members)
      if (ids.length > 1) out.set(rid, reactionsIn(graph, compared, ids.filter(visible), timed));
    return out;
  }, [members, graph, compared, visible, timed]);
  // One focus at a time, and only it dims the map. A lane hovered in 分工 comes first: what its Cards
  // carried. Then a Card with its sources, numbered in order, or a Role with what its Cards carried and
  // the Nodes it watches. Otherwise a topic: the one the pointer rests on, else the selected one while it
  // is on the map. What it cites and what cites it are marked on those topics, not drawn as lines.
  const onMap = useCallback(
    (id: string) => base.placed.has(id) && visible(id) && exists(id),
    [base, visible, exists],
  );
  const [rested, setRested] = useState<string | null>(null);
  useEffect(() => {
    if (!hover) {
      setRested(null);
      return;
    }
    const timer = setTimeout(() => setRested(hover), 160);
    return () => clearTimeout(timer);
  }, [hover]);
  const byTopic =
    time === null && !lensId && hotLane === null && !sources && selected?.kind !== "role";
  const chosen = byTopic && selected?.kind === "node" && onMap(selected.id) ? selected.id : null;
  const pointed = byTopic && rested && rested !== chosen && onMap(rested) ? rested : null;
  const chosenNear = useMemo(
    () => (chosen ? focusOf(graph, chosen, onMap, visible) : null),
    [graph, chosen, onMap, visible],
  );
  const pointedNear = useMemo(
    () => (pointed ? focusOf(graph, pointed, onMap, visible) : null),
    [graph, pointed, onMap, visible],
  );
  const near = pointedNear ?? chosenNear;
  const focus = pointed ?? chosen;
  const laneLit = useMemo<ReadonlySet<string> | null>(() => {
    if (time !== null) return null;
    if (hotLane !== null) return carriedBy(hotLane);
    if (sources) return sources.ids;
    if (selected?.kind === "role")
      return new Set([...carriedBy(selected.id), ...graph.neighbours(selected.id)]);
    return null;
  }, [hotLane, carriedBy, sources, selected?.kind, selected?.id, graph, time === null]);
  const lit = laneLit ?? near?.lit ?? null;
  // A topic as marks and relation lines must see it: its title row and, past it, its count and faces.
  const reach = useCallback(
    (p: Placed): Rect => {
      const r = rectOf(p),
        f = base.placed.get(p.id) === p ? base.forks.get(p.id) : undefined;
      if (!f) return r;
      const x = Math.min(r.x, f.x);
      return { ...r, x, w: Math.max(r.x + r.w, f.x + f.w) - x };
    },
    [base],
  );
  const marks = useMemo(() => {
    const out = new Map<string, { text: string; dx: number; dy: number }>();
    if (laneLit || !near?.near.size) return out;
    const texts = new Map(
      [...near.near].map(
        ([id, how]) =>
          [id, typeof how === "object" ? t.map.near.inside(how.inside) : t.map.near[how]] as const,
      ),
    );
    const asks = [...texts].flatMap(([id, text]) => {
      const p = base.placed.get(id);
      if (!p) return [];
      const at = rectOf(p);
      return [
        {
          id,
          at,
          row: { ...reach(p), h: p.head ?? p.h },
          side: base.topics.get(id)?.side ?? 1,
          w: Math.ceil(textWidth(text, 11, 500)) + 12,
          h: 18,
        },
      ];
    });
    const blocks = [
      ...[...base.placed.values()].filter((p) => onMap(p.id)).map(reach),
      ...base.summaries.map((s) => rectOf(s.at)),
      ...(treeFocus ? [] : [rectOf(base.centre)]),
    ];
    for (const [id, place] of placeMarks(asks, blocks, base.lines))
      out.set(id, { text: texts.get(id)!, ...place });
    return out;
  }, [laneLit, near, base, reach, onMap, textWidth, treeFocus]);
  const facts = useMemo(() => (lensId ? lensFacts(graph, lensId) : null), [graph, lensId]);
  const relationLines = useMemo(
    () => (facts ? lensLines(graph, facts, base.placed, code) : [...lines.values()].flat()),
    [graph, facts, base, code, lines],
  );
  const view = base;

  // Departing topics leave first; survivors clear the space before new topics enter.
  const [motion, setMotion] = useState<{
    from: typeof base;
    to: typeof base;
    phase: TopicPhase;
  } | null>(null);
  const [laidSeen, setLaidSeen] = useState({ base, foldKey, treeFocus });
  if (laidSeen.base !== base) {
    setLaidSeen({ base, foldKey, treeFocus });
    if (
      treeReady &&
      time === null &&
      laidSeen.treeFocus === treeFocus &&
      (laidSeen.foldKey !== foldKey ||
        [...base.placed.keys()].some((id) => !laidSeen.base.placed.has(id))) &&
      !lensId &&
      !lensReturn.current &&
      !reducedMotion
    )
      setMotion({ from: laidSeen.base, to: base, phase: "leave" });
  }
  useEffect(() => {
    if (!motion) return;
    const timer = setTimeout(
      () =>
        setMotion((m) =>
          m !== motion
            ? m
            : m.phase === "leave"
              ? { ...m, phase: "move" }
              : m.phase === "move"
                ? { ...m, phase: "enter" }
                : null,
        ),
      TOPIC_PHASE_MS[motion.phase],
    );
    return () => clearTimeout(timer);
  }, [motion]);
  // Cards that did not change keep their objects, so a change to one card draws only that card.
  const unchanged = useMemo(() => keepUnchanged<Node>(), []);
  const nodes = useMemo<Node[]>(() => {
    if (!canvas.ready || !treeReady) return NO_NODES;
    const out: Node[] = [];
    const moving = !reducedMotion && motion?.to === base ? motion : null;
    const stages = moving ? stagedTopics(moving.from, base, moving.phase) : null;
    const positions = stages
      ? [...stages.keys()]
      : [...new Set([...base.placed.keys(), ...view.placed.keys()])];
    for (const id of positions) {
      if (!visible(id)) continue;
      const stage = stages?.get(id);
      const at = stage?.at ?? view.placed.get(id) ?? base.placed.get(id)!;
      const pos = { x: at.x, y: rectOf(at).y };
      const fold = base.folds?.get(id);
      out.push({
        // Top-left position computed here: an origin offset would wait for measurement and move the card twice.
        id,
        type: "node",
        position: pos,
        width: at.w,
        height: at.h,
        draggable: false,
        // Topics not yet written at the chosen time keep their place invisibly.
        // Cards take their own drags, so only blank space moves the map.
        className: `${stage && stage.appearance !== "shown" ? `is-${stage.appearance} ` : ""}${view.placed.has(id) && exists(id) ? "nopan" : stage?.appearance === "leaving" ? "nopan" : "is-away nopan"}`,
        data: {
          graph,
          topic: base.topics.get(id) ?? { depth: 1, side: 1, branch: id },
          head: at.head ?? at.h,
          id,
          h: at.h,
          w: at.w,
          preview: (() => {
            const file = previewFile(id);
            return file ? { file, open: previews.has(id) && !!at.head } : null;
          })(),
          top: (at.head ?? at.h) >= CARD.top - 2,
          fold: fold
            ? { ids: fold, open: false }
            : openOutputs.has(id)
              ? {
                  ids: shown.kidsOf(id).flatMap((c) => (isResult(graph, c.id) ? [c.id] : [])),
                  open: true,
                }
              : null,
          mark: marks.get(id) ?? null,
          selected: selected?.id === id,
          picked: picked.has(id),
          touched: touched.has(id),
          dim: facts ? !facts.ids.has(id) : !!lit && id !== focus && !lit.has(id),
          folded: folded.has(id) ? descendants(shown.kidsOf, id) : 0,
          count: folded.has(id) ? TOPIC.fork + measureFold(id) : 0,
          room: base.forks.has(id) ? TOPIC.fork + base.forks.get(id)!.w : 0,
          kids: shown.kidsOf(id).length,
          pin: pins.get(id) ?? 0,
          src: sources?.order?.get(id) ?? null,
          hands: handsAt.has(id) ? handsOf(handsAt.get(id)!) : null,
        },
      });
    }
    {
      const outline = moving?.phase === "leave" ? moving.from : base;
      if (!treeFocus)
        out.push({
          id: CENTRE,
          type: "centre",
          position: { x: outline.centre.x, y: rectOf(outline.centre).y },
          width: base.centre.w,
          height: base.centre.h,
          draggable: false,
          selectable: false,
          data: { name: graph.snapshot.workspace.name, w: base.centre.w, h: base.centre.h },
        });
      for (const item of outline.summaries)
        out.push({
          id: item.at.id,
          type: "summary",
          className:
            moving &&
            moving.phase !== "leave" &&
            !moving.from.summaries.some((s) => s.at.id === item.at.id)
              ? `is-${moving.phase === "move" ? "waiting" : "entering"}`
              : undefined,
          position: { x: item.at.x, y: rectOf(item.at).y },
          draggable: false,
          selectable: false,
          data: {
            kind: item.kind,
            parent: item.parent,
            count: item.count,
            w: item.at.w,
          },
        });
    }
    return unchanged(out);
  }, [
    canvas.ready,
    treeReady,
    graph,
    base,
    view,
    lensId,
    facts,
    motion,
    reducedMotion,
    openOutputs,
    marks,
    visible,
    exists,
    touched,
    focus,
    lit,
    selected?.id,
    picked,
    folded,
    pins,
    sources,
    previewFile,
    previews,
    shown,
    handsAt,
    treeFocus,
  ]);

  const relationObstacles = useMemo(
    () =>
      [...view.placed.values()]
        .filter((p) => graph.nodes.has(p.id) && visible(p.id) && exists(p.id))
        .map(reach),
    [view, graph, visible, exists, reach],
  );
  const selectionRoutes = useMemo(() => {
    const routes = new Map<string, { tip: string; route: ReturnType<typeof selectionPath> }>();
    for (const l of relationLines) {
      const a = view.placed.get(l.from),
        b = view.placed.get(l.to);
      if (!a || !b) continue;
      const tip =
        l.kind === "material"
          ? t.map.relations.material(l.files ?? [])
          : l.kind === "code"
            ? t.map.relations.code(l.imports ?? 0)
            : l.kind === "card"
              ? t.map.relations.card(l.cards ?? [])
              : t.map.relations[l.kind];
      routes.set(`${l.kind}:${l.from}>${l.to}`, {
        tip,
        route: selectionPath(
          reach(a),
          reach(b),
          l.kind,
          relationObstacles,
          1,
          textWidth(tip, 12.5, 500),
        ),
      });
    }
    return routes;
  }, [view, relationObstacles, relationLines, textWidth, reach]);

  const unchangedEdges = useMemo(() => keepUnchanged<Edge>(), []);
  const edges = useMemo<Edge[]>(() => {
    if (!canvas.ready || !treeReady) return NO_EDGES;
    const out: Edge<LinkData>[] = [];
    for (const line of base.lines) {
      if (
        (graph.nodes.has(line.source) && !exists(line.source)) ||
        (graph.nodes.has(line.target) && !exists(line.target))
      )
        continue;
      const summary = base.summaries.find((s) => s.at.id === line.target);
      const target = base.topics.get(line.target) ?? summary?.topic;
      const from = base.placed.get(line.source) ?? base.centre;
      const to = base.placed.get(line.target) ?? summary?.at;
      if (!to) continue;
      out.push({
        id: line.id,
        source: line.source,
        target: line.target,
        type: "link",
        focusable: false,
        interactionWidth: 0,
        sourceHandle: "out",
        targetHandle: "in",
        data: {
          kind: "tree",
          dim: facts
            ? !facts.ids.has(line.target) || !facts.ids.has(line.source)
            : !!lit && !lit.has(line.target),
          from: rectOf(from),
          to: rectOf(to),
          points: line.points,
          ...lineTo(target?.depth ?? 1, !!summary),
        },
      });
    }
    // Selection facts draw last, above the tree.
    const sorted: Edge[] = out;
    for (const l of relationLines) {
      const a = view.placed.get(l.from),
        b = view.placed.get(l.to);
      if (!a || !b) continue;
      const routed = selectionRoutes.get(`${l.kind}:${l.from}>${l.to}`)!;
      sorted.push({
        id: `selection:${l.kind}:${l.from}>${l.to}`,
        source: l.from,
        target: l.to,
        type: "selection",
        focusable: false,
        interactionWidth: 0,
        sourceHandle: "out",
        targetHandle: "in",
        data: { kind: l.kind, from: rectOf(a), to: rectOf(b), ...routed },
      });
    }
    return unchangedEdges(sorted);
  }, [
    canvas.ready,
    treeReady,
    graph,
    view,
    base,
    facts,
    exists,
    lit,
    relationLines,
    selectionRoutes,
  ]);

  // ---------- viewport ----------
  /** Width the map can actually show: on narrow screens the details panel floats over its right side. */
  const clearWidth = useCallback(() => {
    const el = box.current;
    if (!el) return 0;
    const panel = document.querySelector<HTMLElement>(".detail");
    const over =
      panel && getComputedStyle(panel).position === "absolute"
        ? Math.max(0, el.getBoundingClientRect().right - panel.getBoundingClientRect().left)
        : 0;
    return el.clientWidth - over;
  }, []);
  /** Screen rectangles occupied by persistent floating controls, relative to the map. */
  const coveredRects = useCallback((): Rect[] => {
    const el = box.current;
    if (!el) return [];
    const outer = el.getBoundingClientRect();
    return [
      ...document.querySelectorAll<HTMLElement>(
        ".stage .roles > .dock, .map > .maptools, .map > .inktools, .map > .ink-style, .map > .timebar, .map > .map-hint, .map > .map-lens, .map > .map-selection-reaction, .map > .map-focus-path",
      ),
    ].flatMap((panel) => {
      const r = panel.getBoundingClientRect();
      if (!r.width || !r.height) return [];
      return [
        { x: r.left - outer.left - 8, y: r.top - outer.top - 8, w: r.width + 16, h: r.height + 16 },
      ];
    });
  }, []);
  const clearArea = useCallback(
    (outline: { w: number; h: number }) => {
      const el = box.current;
      return clearRect(
        {
          x: PAD.left + 1,
          y: PAD.top,
          w: Math.max(1, clearWidth() - PAD.left - PAD.right - 2),
          h: Math.max(1, (el?.clientHeight ?? 0) - PAD.top - PAD.bottom),
        },
        coveredRects(),
        outline,
      );
    },
    [clearWidth, coveredRects],
  );
  const inView = useCallback(
    (r: Rect, margin = 12) => {
      const el = box.current;
      if (!el) return true;
      const v = flow.getViewport();
      const painted = {
        x: r.x * v.zoom + v.x,
        y: r.y * v.zoom + v.y,
        w: r.w * v.zoom,
        h: r.h * v.zoom,
      };
      return (
        r.x * v.zoom + v.x >= margin &&
        r.y * v.zoom + v.y >= margin &&
        (r.x + r.w) * v.zoom + v.x <= clearWidth() - margin &&
        (r.y + r.h) * v.zoom + v.y <= el.clientHeight - PAD.bottom + 36 - margin &&
        !coveredRects().some(
          (c) =>
            painted.x < c.x + c.w &&
            painted.x + painted.w > c.x &&
            painted.y < c.y + c.h &&
            painted.y + painted.h > c.y,
        )
      );
    },
    [flow, clearWidth, coveredRects],
  );
  /** Fit map rectangles into the clear area, zooming no further in than `maxZoom` or out than `minZoom`. */
  const fitRects = useCallback(
    (
      rects: Rect[],
      maxZoom = 1,
      motion: { duration: number } = { duration: 400 },
      minZoom = FIT_MIN,
    ) => {
      const el = box.current;
      if (!el || !rects.length) return;
      const x1 = Math.min(...rects.map((r) => r.x)),
        y1 = Math.min(...rects.map((r) => r.y));
      const x2 = Math.max(...rects.map((r) => r.x + r.w)),
        y2 = Math.max(...rects.map((r) => r.y + r.h));
      const area = clearArea({ w: x2 - x1, h: y2 - y1 });
      const floor = Math.max(ZOOM.min, Math.min(minZoom, area.w / (x2 - x1), area.h / (y2 - y1)));
      void flow.setViewport(
        fitViewport(
          { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
          area,
          Math.min(maxZoom, ZOOM.max),
          floor,
        ),
        motion,
      );
    },
    [flow, clearArea],
  );
  const viewRects = useCallback(
    (layout: Layout) => [
      ...[...layout.placed.values()].filter((p) => visible(p.id)).map(rectOf),
      ...layout.labels.map((l) => ({ x: l.x, y: l.y, w: CARD.w, h: 20 })),
      ...(layout === base
        ? [rectOf(base.centre), ...base.summaries.map((s) => rectOf(s.at)), ...base.forks.values()]
        : []),
    ],
    [visible, base],
  );
  useLayoutEffect(() => {
    const id = revealTarget.current;
    if (!lensId || !id) return;
    revealTarget.current = null;
    const at = base.placed.get(id);
    if (!at || !visible(id)) return;
    fitRects([rectOf(at)], flow.getZoom(), { duration: reducedMotion ? 0 : 180 }, READABLE);
  }, [base, lensId, visible, fitRects, flow, reducedMotion]);
  // Restore before paint; the selection effect below also holds this view while the detail panel settles.
  useLayoutEffect(() => {
    if (!lens && lensReturn.current) void flow.setViewport(lensReturn.current, { duration: 0 });
  }, [lens, base, flow]);

  /** Centre the whole visible tree in the area left clear by panels and tools. */
  const overview = useCallback(
    (motion: { duration: number } = { duration: 400 }, floor = ZOOM.min) => {
      const el = box.current;
      const rects = viewRects(view);
      if (!el || !rects.length) return;
      const x1 = Math.min(...rects.map((r) => r.x)),
        y1 = Math.min(...rects.map((r) => r.y));
      const x2 = Math.max(...rects.map((r) => r.x + r.w)),
        y2 = Math.max(...rects.map((r) => r.y + r.h));
      const area = clearArea({ w: x2 - x1, h: y2 - y1 });
      const zoom = Math.min(1, Math.max(Math.min(area.w / (x2 - x1), area.h / (y2 - y1)), floor));
      void flow.setViewport(
        {
          x: area.x + area.w / 2 - ((x1 + x2) / 2) * zoom,
          y: area.y + area.h / 2 - ((y1 + y2) / 2) * zoom,
          zoom,
        },
        motion,
      );
    },
    [flow, view, viewRects, clearArea],
  );
  useLayoutEffect(() => {
    if (!ready || !focusMove.current) return;
    const move = focusMove.current;
    focusMove.current = null;
    if (move === "fit")
      fitRects(viewRects(base), 1, { duration: reducedMotion ? 0 : 180 }, READABLE);
    else void flow.setViewport(move, { duration: reducedMotion ? 0 : 180 });
  }, [treeFocus, ready, base, flow, fitRects, viewRects, reducedMotion]);
  useEffect(() => {
    if (!focusMenu) return;
    const close = () => setFocusMenu(null);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    addEventListener("pointerdown", close);
    addEventListener("keydown", esc, true);
    return () => {
      removeEventListener("pointerdown", close);
      removeEventListener("keydown", esc, true);
    };
  }, [focusMenu]);
  useLayoutEffect(() => {
    if (ready && canvas.ready && initialView.current) {
      const el = box.current;
      if (!el) return;
      const over =
        selected?.kind === "node"
          ? graph.ancestors(selected.id).filter((a) => folded.has(a.id))
          : [];
      if (over.length) {
        arrange({ folds: Object.fromEntries(over.map((a) => [a.id, "open"])) });
        return;
      }
      const rects = viewRects(base);
      const w = Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x));
      const h = Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y));
      const area = clearArea({ w, h });
      if (defaultDepth > 1 && (w * 0.8 > area.w || h * 0.8 > area.h)) {
        setDefaultDepth(1);
        return;
      }
      const zoom = Math.max(ZOOM.min, Math.min(1, area.w / w, area.h / h));
      fitRects(rects, 1, { duration: 0 }, 0.8);
      // Font compensation can change the bounds once when the first zoom is set.
      // Show the tree only after its saved folds and final measured bounds agree.
      if (Math.abs(topicScale - scaleAt(zoom)) < 0.0001) {
        initialView.current = false;
        setTreeReady(true);
      }
    }
    if (ready && fittingAll.current) overview({ duration: 0 });
  }, [
    ready,
    canvas.ready,
    overview,
    base,
    viewRects,
    defaultDepth,
    clearWidth,
    clearArea,
    fitRects,
    topicScale,
    graph,
    selected?.kind,
    selected?.id,
    folded,
    arrange,
  ]);
  useEffect(() => {
    const el = box.current;
    if (!el || !treeReady) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(".panel, .roles, input, textarea, select")) return;
      e.preventDefault();
      e.stopPropagation();
      initialView.current = false;
      fittingAll.current = false;
      setPeek(null);
      const r = el.getBoundingClientRect();
      void flow.setViewport(
        wheelViewport(flow.getViewport(), { x: e.clientX - r.left, y: e.clientY - r.top }, e, ZOOM),
        { duration: 0 },
      );
    };
    el.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", wheel, true);
  }, [flow, treeReady]);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      if (!initialView.current) overview();
    }, 60);
    return () => clearTimeout(t);
  }, [filters.types]);

  // Keep the selected title inside the remaining map area as either side panel changes size.
  const keepSelectionVisible = useSteady((moved: number) => {
    const el = box.current;
    if (!el) return;
    const v = { ...flow.getViewport() };
    v.x -= moved;
    const p = selected?.kind === "node" ? view.placed.get(selected.id) : undefined;
    if (p) {
      const r = rectOf(p);
      const painted = {
        x: r.x * v.zoom + v.x,
        y: r.y * v.zoom + v.y,
        w: r.w * v.zoom,
        h: r.h * v.zoom,
      };
      if (
        coveredRects().some(
          (c) =>
            painted.x < c.x + c.w &&
            painted.x + painted.w > c.x &&
            painted.y < c.y + c.h &&
            painted.y + painted.h > c.y,
        )
      ) {
        void flow.setViewport(
          uncoverViewport(
            v,
            r,
            {
              x: 12,
              y: 12,
              w: Math.max(1, clearWidth() - 24),
              h: Math.max(1, el.clientHeight - PAD.bottom - 24),
            },
            coveredRects(),
          ),
          { duration: 0 },
        );
        return;
      }
      const width = clearWidth() - 24,
        height = el.clientHeight - PAD.bottom - 24;
      const zoom = Math.min(v.zoom, width / r.w, height / r.h);
      v.zoom = Math.max(ZOOM.min, zoom);
      const left = r.x * v.zoom + v.x,
        right = (r.x + r.w) * v.zoom + v.x;
      const top = r.y * v.zoom + v.y,
        bottom = (r.y + r.h) * v.zoom + v.y;
      v.x += left < 12 ? 12 - left : right > width + 12 ? width + 12 - right : 0;
      v.y += top < 12 ? 12 - top : bottom > height + 12 ? height + 12 - bottom : 0;
    }
    const old = flow.getViewport();
    if (Math.abs(old.x - v.x) > 0.1 || Math.abs(old.y - v.y) > 0.1 || old.zoom !== v.zoom)
      void flow.setViewport(v, { duration: 0 });
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let left = el.getBoundingClientRect().left;
    const observer = new ResizeObserver(() => {
      const now = el.getBoundingClientRect().left,
        moved = now - left;
      left = now;
      keepSelectionVisible(moved);
    });
    observer.observe(el);
    const panel = document.querySelector(".detail");
    if (panel) observer.observe(panel);
    return () => observer.disconnect();
  }, [keepSelectionVisible, selected?.id]);

  // A dock opening or growing changes the usable map, even without a side-panel resize.
  const uncoverTopics = useSteady(() => {
    if (!treeReady || initialView.current || document.body.classList.contains("is-dragging"))
      return;
    // Opening a floating panel preserves the reader's view. Only the selected topic needs uncovering.
    if (selected?.kind !== "node" || !view.placed.has(selected.id)) return;
    const covered = coveredRects();
    const v = flow.getViewport();
    const rects = [rectOf(view.placed.get(selected.id)!)];
    const hidden = rects.some((r) => {
      const x = r.x * v.zoom + v.x,
        y = r.y * v.zoom + v.y;
      return covered.some(
        (c) => x < c.x + c.w && x + r.w * v.zoom > c.x && y < c.y + c.h && y + r.h * v.zoom > c.y,
      );
    });
    if (hidden) {
      keepSelectionVisible(0);
    }
  });
  useLayoutEffect(() => {
    const roles = box.current?.closest(".stage")?.querySelector(".roles");
    let last = "";
    let dockGeometry = "";
    const refresh = () => {
      const dock = roles?.querySelector(".dock")?.getBoundingClientRect();
      const nextDock = dock ? `${dock.x},${dock.y},${dock.width},${dock.height}` : "";
      if (nextDock !== dockGeometry) {
        // A popup is a reading excursion, not another request to fit the whole graph.
        fittingAll.current = false;
        dockGeometry = nextDock;
      }
      const next = JSON.stringify(coveredRects());
      if (next === last) return;
      last = next;
      uncoverTopics();
    };
    const sizes = new ResizeObserver(refresh);
    const listen = () => {
      const dock = roles?.querySelector(".dock");
      if (dock) sizes.observe(dock);
      refresh();
    };
    const children = new MutationObserver(listen);
    if (roles) children.observe(roles, { childList: true, subtree: true });
    listen();
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, [coveredRects, uncoverTopics, treeReady, inking, timeOpen, picked.size, lensId]);

  // Selecting pans only when the topic is out of view. Entering the lens keeps the view intact.
  useEffect(() => {
    if (!ready) return;
    // Wait for the details panel to take its width.
    const t = setTimeout(() => {
      if (lensId) return;
      const back = lensReturn.current;
      lensReturn.current = null;
      if (back) {
        void flow.setViewport(back, { duration: 0 });
        return;
      }
      if ((selected?.kind === "role" || selected?.kind === "card") && lit) {
        const rects = [...lit].flatMap((id) => {
          const p = base.placed.get(id);
          return p && visible(id) ? [rectOf(p)] : [];
        });
        // A view the map picks by itself stays readable; the hint brings in whatever is left outside.
        if (rects.some((r) => !inView(r))) fitRects(rects, 1, undefined, READABLE);
      } else if (selected?.kind === "node" && !archived.has(selected.id)) {
        // An archived Node opens beside the map and leaves it as it is. A result folded into its parent's
        // count is brought in by that parent.
        let at: string | null | undefined = selected.id;
        while (at && !base.placed.has(at)) at = graph.nodes.get(at)?.parentId;
        const p = at ? base.placed.get(at) : undefined;
        const n = at ? graph.nodes.get(at) : undefined;
        if (!p || !n) return;
        const rectsOf = (ids: (string | null)[]) =>
          ids.flatMap((id) => {
            const q = id ? base.placed.get(id) : undefined;
            return q && visible(q.id) ? [rectOf(q)] : [];
          });
        const up = shown.upOf(n.id),
          kids = shown.kidsOf(n.id).map((c) => c.id);
        // The card stays whole between the sidebar and the details panel, and its open children with it
        // where they fit; when they do not, the card itself comes first.
        const selfIn = inView(rectOf(p), COMFORT);
        if (selfIn && rectsOf(kids).every((r) => inView(r))) return;
        const el = box.current!;
        const fits = (rects: Rect[]) => {
          const w = Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x));
          const h = Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y));
          return Math.min(
            (clearWidth() - PAD.left - PAD.right) / w,
            (el.clientHeight - PAD.top - PAD.bottom) / h,
          );
        };
        // The most of its family that still fits at a readable size; at least the card itself.
        const groups = selfIn
          ? [[n.id, ...kids]]
          : [
              [up, n.id, ...kids],
              [n.id, ...kids],
              [up, n.id],
            ];
        const rects = groups.map(rectsOf).find((r) => fits(r) >= READABLE);
        if (!rects && selfIn) return;
        fitRects(
          rects ?? rectsOf([n.id]),
          Math.max(flow.getZoom(), READABLE),
          { duration: 350 },
          READABLE,
        );
      }
    }, 140);
    return () => clearTimeout(t);
  }, [selected?.id, ready, lensId, !!lens]);

  // Related cards outside the view get a way to bring them in.
  // What the selection lights, not a topic the pointer passes over.
  const related = useMemo(() => {
    const ids = laneLit ?? chosenNear?.lit;
    if (!ids || lensId) return [];
    return [...ids].flatMap((id) => {
      const p = base.placed.get(id);
      return p && visible(id) ? [rectOf(p)] : [];
    });
  }, [laneLit, chosenNear, lensId, base, visible]);
  const countOutside = useCallback(() => {
    setOutside(related.filter((r) => !inView(r)).length);
    const ids = [...(facts?.ids ?? [])].filter((id) => {
      const at = base.placed.get(id);
      return id !== lensId && at && !inView(rectOf(at));
    });
    setLensOutside((old) =>
      old.size === ids.length && ids.every((id) => old.has(id)) ? old : new Set(ids),
    );
  }, [related, inView, facts, base, lensId]);
  useEffect(() => {
    const t = setTimeout(countOutside, 600);
    return () => clearTimeout(t);
  }, [countOutside]);

  const pinTopic = (id: string) => {
    initialView.current = false;
    fittingAll.current = false;
    const at = base.placed.get(id);
    foldAnchor.current = at ? { id, at: [at.x, at.y] } : undefined;
  };
  // Cards glide when the layout changes shape; lines wait until they land. The glide must be on in the
  // same render as the new positions, so it is derived rather than set afterwards.
  const shape = view;
  const [settled, setSettled] = useState(shape);
  const morphing = !reducedMotion && shape !== settled;
  useEffect(() => {
    const t = setTimeout(() => setSettled(shape), reducedMotion ? 0 : 180);
    return () => clearTimeout(t);
  }, [shape, reducedMotion]);

  // A short look at a card's summary once the pointer has rested on it.
  useEffect(() => {
    setPeek(null);
    if (!hover || hover === selected?.id) return;
    const t = setTimeout(() => {
      const el = box.current?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(hover)}"]`,
      );
      const outer = box.current?.getBoundingClientRect();
      if (!el || !outer) return;
      const r = el.getBoundingClientRect();
      // Beside, below, above or before the card: whichever covers the fewest other cards.
      const W = 300,
        H = 110,
        SPACE = 10;
      const cards = [...box.current!.querySelectorAll<HTMLElement>(".react-flow__node")].map(
        (n) => [n === el ? 50 : 1, n.getBoundingClientRect()] as const,
      );
      const covered = (x: number, y: number) =>
        cards.reduce(
          (sum, [weight, o]) =>
            sum +
            weight *
              Math.max(0, Math.min(x + W, o.right) - Math.max(x, o.left)) *
              Math.max(0, Math.min(y + H, o.bottom) - Math.max(y, o.top)),
          0,
        );
      const spots = [
        { x: r.right + SPACE, y: r.top, above: false },
        { x: r.left, y: r.bottom + 8, above: false },
        { x: r.left, y: r.top - 8 - H, above: true },
        { x: r.left - SPACE - W, y: r.top, above: false },
      ].map((s) => {
        const x = Math.max(outer.left + 8, Math.min(s.x, outer.right - W - 8));
        const y = Math.max(outer.top + 8, Math.min(s.y, outer.bottom - PAD.bottom - H));
        return { ...s, x, y, cost: covered(x, y) };
      });
      const best = spots.reduce((a, b) => (b.cost < a.cost ? b : a));
      setPeek({
        id: hover,
        left: best.x - outer.left,
        top: best.above ? best.y + H - outer.top : best.y - outer.top,
        above: best.above,
      });
    }, 450);
    return () => clearTimeout(t);
  }, [hover, selected?.id]);

  useFloatingPanels(box, [
    ...picked,
    ...(hover ? [hover] : []),
    ...(selected?.kind === "node" ? [selected.id] : []),
  ]);

  // ---------- opening and closing ----------
  /**
   * Opens a card one level, or closes it; `open` says which, else it turns over. The card stays where it is
   * on screen. Closing also forgets what was opened under it, so opening it again shows one level.
   * Closing over the selection selects the closed card.
   */
  const fold = (id: string, open?: boolean) => {
    const opening = open ?? folded.has(id);
    if (opening !== folded.has(id) || (!opening && !shown.kidsOf(id).length)) return;
    const top = id === treeFocus || shown.upOf(id) === treeFocus;
    const folds: Record<string, Fold | null> = {};
    if (opening) folds[id] = "open";
    else {
      folds[id] = top ? "shut" : null;
      const under = new Set(underIds(shown.kidsOf, id));
      for (const u of [...opened, ...shut]) if (under.has(u)) folds[u] = null;
    }
    pinTopic(id);
    arrange({ folds });
    if (
      !opening &&
      selected?.kind === "node" &&
      graph.ancestors(selected.id).some((a) => a.id === id)
    )
      onSelect({ kind: "node", id });
  };
  // A Node chosen elsewhere, in the tree or a Card, opens the cards over it on the map.
  useEffect(() => {
    if (selected?.kind !== "node" || !canvas.ready || !treeReady) return;
    const over = graph.ancestors(selected.id).filter((a) => folded.has(a.id));
    if (!over.length) return;
    pinTopic(selected.id);
    arrange({
      folds: Object.fromEntries(over.map((a) => [a.id, "open"])),
    });
  }, [selected?.kind, selected?.id, canvas.ready, treeReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- keyboard ----------
  // What the keys act on, current at the moment of the key.
  const live = {
    view,
    selected,
    lensId,
    folded,
    fold,
    visible,
    shown,
    timeOpen,
    inking,
    picked,
    overview,
    openTime,
    closeTime,
    arrange,
    undo,
    redo,
  };
  const latest = useRef(live);
  latest.current = live;
  useEffect(() => {
    if (!keys || !treeReady) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.body.classList.contains("is-dragging")) return;
      const el = e.target as HTMLElement;
      const { view, selected, lensId, folded, fold, visible, shown, timeOpen, inking, picked } =
        latest.current;
      // While drawing, the keys are the drawing tools'.
      if (inking) return;
      if (e.key === "Escape" && picked.size) {
        e.preventDefault();
        e.stopPropagation();
        setPicked(new Set());
        return;
      }
      // Esc leaves the map's modes first, even from the time slider.
      if (e.key === "Escape" && (lensId || timeOpen)) {
        e.preventDefault();
        e.stopPropagation();
        if (lensId) setLens(false);
        else {
          setPlaying(false);
          setTime(null);
        }
        return;
      }
      const typing = /INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable;
      // Keys belong to the map only while attention is on it.
      if (typing || !(el === document.body || el.closest(".map, .sidebar"))) return;
      // The tree moves and folds with its own keys.
      if (el.closest("[role=tree]") && TREE_KEYS.has(e.key)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
        e.preventDefault();
        if (lensId) return;
        (e.key.toLowerCase() === "y" || e.shiftKey ? latest.current.redo : latest.current.undo)();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a" && !lensId) {
        e.preventDefault();
        setPicked(new Set([...view.placed.keys()].filter(visible)));
        return;
      }
      // Zoom keys as in Excalidraw and Canva; the browser would otherwise zoom the whole page.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "0"].includes(e.key)) {
        e.preventDefault();
        initialView.current = false;
        fittingAll.current = false;
        if (e.key === "0") void flow.zoomTo(1, ZOOM_NOW);
        else if (e.key === "-") void flow.zoomOut(ZOOM_NOW);
        else void flow.zoomIn(ZOOM_NOW);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const onControl = !!el.closest("button, a, [role=radio]");
      // Shift 1 shows everything, Shift 2 what is selected.
      if (e.shiftKey && (e.code === "Digit1" || e.code === "Digit2")) {
        e.preventDefault();
        initialView.current = false;
        fittingAll.current = e.code === "Digit1";
        if (e.code === "Digit1") return latest.current.overview({ duration: 0 }, ZOOM.min);
        const ids = picked.size ? [...picked] : selected?.kind === "node" ? [selected.id] : [];
        const shownIds = ids.filter((id) => view.placed.has(id) && visible(id));
        if (shownIds.length)
          void flow.fitView({
            nodes: shownIds.map((id) => ({ id })),
            padding: 0.25,
            maxZoom: 1.5,
            duration: 0,
          });
        return;
      }
      // Space held is the hand: dragging then moves the map. Pressed and let go alone, it folds or opens
      // the selected topic.
      if (e.key === " " && !onControl) {
        e.preventDefault();
        if (!handHeld.current) {
          handHeld.current = true;
          handUsed.current = false;
          setHand(true);
        }
        return;
      }
      const node = selected?.kind === "node" ? graph.nodes.get(selected.id) : undefined;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const act = (f: () => void) => {
        e.preventDefault();
        initialView.current = false;
        fittingAll.current = false;
        f();
      };
      if (key === "l") return !timeOpen && node && act(() => setLens((l) => !l));
      if (key === "f")
        return act(() => {
          fittingAll.current = true;
          latest.current.overview({ duration: 0 }, ZOOM.min);
        });

      if (key === "0") return act(() => void flow.zoomTo(1, ZOOM_NOW));
      if (key === "=" || key === "+") return act(() => void flow.zoomIn(ZOOM_NOW));
      if (key === "-") return act(() => void flow.zoomOut(ZOOM_NOW));
      if (key === "t")
        return act(() => (timeOpen ? latest.current.closeTime() : latest.current.openTime()));
      if (key === "p") return !timeOpen && act(() => setInkTool("select"));
      if (key === "?") return act(() => setKeyOpen((o) => !o));
      if (key === "b" && node && !lensId)
        return act(() => {
          const branch = new Set<string>();
          const walk = (id: string) => {
            branch.add(id);
            for (const kid of shown.kidsOf(id)) if (view.placed.has(kid.id)) walk(kid.id);
          };
          walk(node.id);
          setPicked(branch);
        });
      if ((key === "[" || key === "]") && node && !lensId)
        return act(() => {
          // [ folds the selected card's children, ] opens them.
          const closing = key === "[";
          if (closing ? !folded.has(node.id) && shown.kidsOf(node.id).length : folded.has(node.id))
            fold(node.id, !closing);
        });
      if (e.key === "Enter" && !onControl) {
        if (selected) {
          e.preventDefault();
          onExpand();
        }
        return;
      }
      const dir = KEYS[e.key];
      if (!dir) return;
      e.preventDefault();
      const here = node && view.placed.get(node.id);
      if (!node || !here) {
        const first = shown.kidsOf(null)[0];
        if (first) onSelect({ kind: "node", id: first.id });
        return;
      }
      const next = nearest(view, here, dir, visible);
      if (next) onSelect({ kind: "node", id: next });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !handHeld.current) return;
      handHeld.current = false;
      setHand(false);
      const { selected, lensId, fold, shown } = latest.current;
      const node = selected?.kind === "node" ? selected.id : null;
      if (!handUsed.current && node && !lensId && shown.kidsOf(node).length) fold(node);
    };
    const letGo = () => {
      handHeld.current = false;
      setHand(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", letGo);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", letGo);
    };
  }, [keys, treeReady, graph, onSelect, onExpand, flow]);

  // ---------- the pointer: dragging empty space picks with a box, dragging a card moves it ----------
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  /** Follow a press to its release; `step` hears the distance once it is past a few pixels. */
  const track = (
    e: React.PointerEvent,
    step: (dx: number, dy: number, ev: PointerEvent) => boolean | void,
    end: (moved: boolean, ev: PointerEvent) => void,
  ) => {
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x,
        dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      if (step(dx, dy, ev) === false) stop();
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (moved) {
        // The release that ends a drag is not also a click on the card it dropped.
        const swallow = (c: Event) => c.stopPropagation();
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      }
      end(moved, ev);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const cardEl = (id: string) =>
    box.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`) ??
    null;
  /**
   * The map as it looks, saved as a PNG: the view as it stands, or with cards or drawings picked, the
   * view fitted round them and cut to them, then put back.
   */
  const exportPicture = async () => {
    const el = box.current;
    if (!el || picturing) return;
    setPicturing(true);
    setPictureFailed(false);
    const boxes = [
      ...[...picked].flatMap((id) => {
        const p = view.placed.get(id);
        return p ? [rectOf(p)] : [];
      }),
      ...drawn.filter((d) => inkPicked.has(d.id)).map((d) => aabb(d, inkSizes)),
    ];
    const keep = flow.getViewport();
    try {
      let crop: Crop | undefined;
      if (boxes.length) {
        const x0 = Math.min(...boxes.map((b) => b.x)),
          y0 = Math.min(...boxes.map((b) => b.y)),
          x1 = Math.max(...boxes.map((b) => b.x + b.w)),
          y1 = Math.max(...boxes.map((b) => b.y + b.h));
        await flow.fitBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { padding: 0.15 });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const at = el.getBoundingClientRect();
        const a = flow.flowToScreenPosition({ x: x0, y: y0 }),
          b = flow.flowToScreenPosition({ x: x1, y: y1 });
        crop = { x: a.x - at.x - 24, y: a.y - at.y - 24, w: b.x - a.x + 48, h: b.y - a.y + 48 };
      }
      saveFile(await pictureOf(el, crop), pictureName(graph.snapshot.workspace.name));
    } catch {
      setPictureFailed(true);
      setTimeout(() => setPictureFailed(false), 4000);
    } finally {
      if (boxes.length) void flow.setViewport(keep);
      setPicturing(false);
    }
  };
  const onPress = (e: React.PointerEvent) => {
    if (!treeReady) return;
    initialView.current = false;
    fittingAll.current = false;
    const el = box.current;
    const target = e.target as HTMLElement;
    if (hand) handUsed.current = true;
    if (e.button !== 0 || hand || !el || inking || lensId || moment) return;
    if (target.closest("button, a, input, textarea, .panel")) return;
    const card = target.closest<HTMLElement>(".react-flow__node-node");
    if (card) {
      const id = card.dataset.id!;
      const ids = picked.has(id) ? [...picked] : [id];
      beginDrag(
        e,
        {
          kind: "node",
          id,
          from: "map",
          ...(ids.length > 1 ? { ids: [id, ...ids.filter((i) => i !== id)] } : {}),
        },
        {
          source: card,
          originals: ids.flatMap((i) => cardEl(i) ?? []),
          onLift: () => {
            setPeek(null);
            setHandsPop(null);
          },
        },
      );
      return;
    }
    // Anywhere else on the map, lines included, a drag draws the box, as in Excalidraw and Canva; with
    // Shift the box adds to what is picked. Space or the middle button moves the map instead.
    if (!target.closest(".react-flow")) return;
    const add = e.shiftKey;
    const r = el.getBoundingClientRect();
    const from = { x: e.clientX - r.left, y: e.clientY - r.top };
    track(
      e,
      (dx, dy) =>
        setMarquee({
          x: Math.min(from.x, from.x + dx),
          y: Math.min(from.y, from.y + dy),
          w: Math.abs(dx),
          h: Math.abs(dy),
        }),
      (moved, ev) => {
        setMarquee(null);
        if (!moved) return;
        // Every card the box touches, in map units.
        const a = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const b = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        const x1 = Math.min(a.x, b.x),
          x2 = Math.max(a.x, b.x),
          y1 = Math.min(a.y, b.y),
          y2 = Math.max(a.y, b.y);
        const hit = [...view.placed.values()].filter((p) => {
          if (!visible(p.id)) return false;
          const q = rectOf(p);
          return q.x < x2 && q.x + q.w > x1 && q.y < y2 && q.y + q.h > y1;
        });
        setPicked((old) => new Set([...(add ? old : []), ...hit.map((p) => p.id)]));
      },
    );
  };

  const toggleType = (t: Primary) => {
    foldAnchor.current = undefined;
    setFilters((f) => ({ ...f, types: { ...f.types, [t]: !f.types[t] } }));
  };

  const actions = useMemo<Actions>(
    () => ({
      onFold: (id) => latest.current.fold(id),
      onMore: (id) => {
        pinTopic(id);
        arrange({ folds: { [id]: "open" } });
      },
      onOutputs: (id) => {
        pinTopic(id);
        setOpenOutputs((open) => {
          const next = new Set(open);
          if (!next.delete(id)) next.add(id);
          return next;
        });
      },
      onHands: (id, faces) => {
        clearTimeout(handsTimer.current);
        // Leaving the faces gives the pointer a moment to reach the list.
        if (!id || !faces)
          return void (handsTimer.current = setTimeout(() => setHandsPop(null), 220));
        const outer = box.current?.getBoundingClientRect();
        if (!outer) return;
        const r = faces.getBoundingClientRect();
        setPeek(null);
        // Kept inside the map at its widest, under the faces.
        const left = Math.max(8, Math.min(r.left - outer.left, outer.width - HANDS_W - 8));
        setHandsPop({ id, left, top: r.bottom - outer.top + 4 });
      },
      onPreview: (id) => {
        pinTopic(id);
        setPreviews((open) => {
          const next = new Set(open);
          if (!next.delete(id)) next.add(id);
          if (!lens) writeStored(previewKey, [...next]);
          return next;
        });
      },
    }),
    [hotLane, selected, onSelect, previewKey, base, arrange, lens],
  );
  const revealRelated = (id: string) => {
    if (!lens || !visible(id) || !exists(id)) return;
    foldAnchor.current = undefined;
    revealTarget.current = id;
    setLensSession(revealInLens(lens, graph, id, visible));
  };
  const lensName = lensId ? graph.nodes.get(lensId)?.name : undefined;
  // What a commit did to Nodes.
  const summarize = useCallback(
    (commit: SnapshotCommit) => {
      const status = new Map<string, string>();
      for (const f of commit.files)
        if (f.ref?.kind === "node" && status.get(f.ref.id) !== "A") status.set(f.ref.id, f.status);
      const added = [...status.values()].filter((s) => s === "A").length,
        changed = status.size - added;
      if (!status.size) return t.map.commitOnlyOther;
      const names = [...status.keys()].map((id) => graph.name({ kind: "node", id }));
      return t.map.commitSummary(added, changed, names);
    },
    [graph],
  );
  const momentText = useMemo(() => (moment ? summarize(moment) : ""), [moment, summarize]);

  // Handed to every card: steady, so a change elsewhere does not draw every card again.
  const onNodeClick = useSteady((e: React.MouseEvent, node: Node) => {
    if (node.type !== "node") return;
    initialView.current = false;
    // Shift or Ctrl adds a card to the picked ones, or takes it out.
    if (!lens && (e.shiftKey || e.ctrlKey || e.metaKey))
      return setPicked((old) => {
        const next = new Set(old);
        if (!next.delete(node.id)) next.add(node.id);
        return next;
      });
    setPicked(new Set());
    onSelect({ kind: "node", id: node.id });
  });
  const onNodeMouseEnter = useSteady((_: React.MouseEvent, node: Node) => {
    if (node.type === "node") setHover(node.id);
  });
  const onNodeMouseLeave = useSteady(() => setHover(null));

  return (
    <div
      className={`map${hand ? " is-hand" : ""}${lensId ? " is-lens" : ""}${morphing || motion ? " is-morphing" : ""}${motion ? ` motion-${motion.phase}` : ""}${timeOpen ? " is-time" : ""}${distant ? " is-distant" : ""}`}
      style={{ "--topic-scale": topicScale } as CSSProperties}
      ref={box}
      inert={!treeReady}
      onPointerDownCapture={onPress}
      // The middle button moves the map, not the browser's own scrolling.
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
    >
      {marquee && (
        <div
          className="map-marquee"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
      <MapActions.Provider value={actions}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={ZOOM.min}
          maxZoom={ZOOM.max}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable={false}
          nodeClickDistance={5}
          paneClickDistance={5}
          disableKeyboardA11y
          panOnDrag={[1]}
          selectionKeyCode={null}
          panActivationKeyCode="Space"
          noPanClassName={hand ? "map-hand-pans-all" : "nopan"}
          onInit={() => setReady(true)}
          onMoveStart={(event) => {
            if (event) {
              initialView.current = false;
              fittingAll.current = false;
            }
            setPeek(null);
          }}
          onMoveEnd={countOutside}
          zoomOnDoubleClick={false}
          onNodeDoubleClick={(e, node) => {
            if (node.type === "node") {
              e.preventDefault();
              enterFocus(node.id);
            }
          }}
          onNodeContextMenu={(e, node) => {
            if (node.type !== "node") return;
            e.preventDefault();
            const r = box.current!.getBoundingClientRect();
            setFocusMenu({
              id: node.id,
              x: Math.max(8, Math.min(e.clientX - r.left, clearWidth() - 160)),
              y: Math.max(8, Math.min(e.clientY - r.top, r.height - 80)),
            });
          }}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={() => {
            setPicked(new Set());
            onSelect(null);
          }}
        >
          {inkShown && treeReady && (
            <InkLayer
              ink={inkPreview ?? drawn}
              picked={inking ? inkPicked : NOTHING}
              writing={inking ? (inkWriting?.id ?? null) : null}
              hints={inkHints}
              framed={inking && inkTool === "select"}
              onSizes={setInkSizes}
            />
          )}
        </ReactFlow>
      </MapActions.Provider>

      {treeFocus && !lensId && (
        // Back goes up one level, from the first to the whole map; the trail after it goes to any level.
        <nav className="map-focus-path" aria-label={t.map.topicPath}>
          <button
            type="button"
            className="map-back"
            onClick={() => enterFocus(focusUp)}
            data-tip={t.map.backTo(
              focusUp ? graph.name({ kind: "node", id: focusUp }) : graph.snapshot.workspace.name,
            )}
          >
            <Icon name="back" size={14} />
            {t.map.back}
          </button>
          <span className="map-crumbs">
            <button type="button" onClick={() => enterFocus(null)}>
              {graph.snapshot.workspace.name}
            </button>
            {graph.ancestors(treeFocus).map((n) => (
              <Fragment key={n.id}>
                <span className="map-crumb-sep">/</span>
                <button type="button" onClick={() => enterFocus(n.id)}>
                  {n.name}
                </button>
              </Fragment>
            ))}
            <span className="map-crumb-sep">/</span>
            <span className="map-crumb-here">{graph.nodes.get(treeFocus)?.name}</span>
          </span>
        </nav>
      )}
      {focusMenu && (
        <div
          className="map-focus-menu"
          style={{ left: focusMenu.x, top: focusMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => enterFocus(focusMenu.id)}>{t.map.enterTopic}</button>
        </div>
      )}
      {!inking && !lensId && picked.size > 1 && (
        <div className="map-selection-reaction">
          <SelectionReaction
            list={reactions.get("selection") ?? []}
            nameOf={(id) => graph.nodes.get(id)?.name ?? id}
          />
        </div>
      )}
      {inking && (
        <InkPad
          tool={inkTool}
          ink={drawn}
          anchors={cardAnchors}
          sizes={inkSizes}
          picked={inkPicked}
          style={inkStyle}
          zoom={ZOOM}
          onPick={setInkPicked}
          onPreview={setInkPreview}
          onHints={setInkHints}
          onCommit={commitGeometry}
          onWrite={(w) => {
            openWords(w);
            if (inkTool === "text" && !inkLocked) setInkTool("select");
          }}
          onDrawn={(d) => {
            if (inkLocked) return;
            setInkTool("select");
            if (d.kind !== "pen") setInkPicked(new Set([d.id]));
          }}
        />
      )}
      {inking && inkWriting && (
        <InkEditor
          key={inkWriting.id}
          d={drawn.find((d) => d.id === inkWriting.id) ?? inkWriting.fresh ?? null}
          sizes={inkSizes}
          onDone={(value) => writeWords(inkWriting, value)}
        />
      )}
      {inking && (
        <InkTools
          tool={inkTool}
          locked={inkLocked}
          onTool={setInkTool}
          onLock={() => setInkLocked((l) => !l)}
          onDone={() => setInkTool(null)}
        />
      )}
      {inking && !inkWriting && (
        <InkStylePanel
          list={drawn.filter((d) => inkPicked.has(d.id))}
          tool={inkTool}
          style={inkStyle}
          left={inkLeft}
          onSet={inkSet}
          onAct={inkAct}
        />
      )}
      {time === null && peek && !inking && !handsPop && <PeekCard graph={graph} peek={peek} />}
      {time === null && handsPop && handsAt.has(handsPop.id) && (
        <div
          className="panel map-hands"
          style={{ left: handsPop.left, top: handsPop.top, maxWidth: HANDS_W }}
          onPointerEnter={() => clearTimeout(handsTimer.current)}
          onPointerLeave={() => setHandsPop(null)}
        >
          <HandlingRows
            graph={graph}
            list={handsAt.get(handsPop.id)!}
            onOpen={(ref) => {
              setHandsPop(null);
              onSelect(ref);
            }}
          />
        </div>
      )}
      {time === null && hotLane !== null && lit && <DeskWires lane={hotLane} ids={lit} box={box} />}

      {lensName ? (
        <div className="panel map-hint">
          <Icon name="lens" size={14} />
          <span className="map-hint-text">{t.map.lensOf(lensName)}</span>
          <button type="button" onClick={() => setLens(false)}>
            {t.map.exit}
            <kbd>Esc</kbd>
          </button>
        </div>
      ) : picked.size ? (
        <div className="panel map-hint">
          <span className="map-hint-text">{t.map.picked(picked.size)}</span>
          <button type="button" onClick={() => setPicked(new Set())}>
            {t.map.unpick}
            <kbd>Esc</kbd>
          </button>
        </div>
      ) : (
        outside > 0 && (
          <div className="panel map-hint">
            <span className="map-hint-text">{t.map.outside(outside)}</span>
            <button type="button" onClick={() => fitRects(related)}>
              {t.map.showAll}
            </button>
          </div>
        )
      )}
      {lensId && facts && (
        <aside className="panel map-lens" aria-label={t.map.lensOf(lensName ?? "")}>
          <div className="map-lens-note">{t.lens.hidden}</div>
          {Object.entries(facts.groups).map(([group, ids]) => {
            const hidden = ids.filter(
              (id) => !base.placed.has(id) || lensOutside.has(id) || !visible(id) || !exists(id),
            );
            return hidden.length ? (
              <section key={group}>
                <h3>{t.lens[group as keyof typeof facts.groups]}</h3>
                {hidden.map((id) => (
                  <button
                    type="button"
                    key={id}
                    disabled={!visible(id) || !exists(id)}
                    onClick={() => revealRelated(id)}
                  >
                    {graph.nodes.get(id)!.name}
                    {!visible(id) && <small>{t.lens.filtered}</small>}
                  </button>
                ))}
              </section>
            ) : null;
          })}
          <section>
            <h3>{t.lens.files}</h3>
            {facts.files === null ? (
              <p>{t.lens.reading}</p>
            ) : (
              facts.files.map((m, index) => (
                <button type="button" key={index} onClick={onExpand} title={m.error ?? m.resource}>
                  {m.title ?? m.workspacePath ?? m.uri ?? m.resource}
                </button>
              ))
            )}
          </section>
          <section>
            <h3>{t.lens.cards}</h3>
            {facts.cards === null ? (
              <p>{t.lens.reading}</p>
            ) : (
              facts.cards.map(({ card, role }) => (
                <div key={card.id}>
                  <button type="button" onClick={() => onSelect({ kind: "card", id: card.id })}>
                    {card.title || card.id}
                  </button>
                  {card.receivedBy && (
                    <button
                      type="button"
                      className="map-lens-role"
                      onClick={() => onSelect({ kind: "role", id: card.receivedBy! })}
                    >
                      {t.lens.receivedBy(role?.title ?? card.receivedBy)}
                    </button>
                  )}
                </div>
              ))
            )}
          </section>
        </aside>
      )}

      {moment && !pastTree && (
        <div className="empty" role="status">
          {past.commit === moment.hash && past.error ? describe(past.error) : t.page.reading}
        </div>
      )}
      {moment && (
        <div className="panel timebar" role="group" aria-label={t.map.replay}>
          <div className="timebar-head">
            <button
              type="button"
              className="tool"
              onClick={play}
              aria-label={playing ? t.map.pause : t.map.replayFromStart}
              data-tip={playing ? t.map.pause : t.map.replayFromStart}
            >
              <Icon name={playing ? "pause" : "play"} size={14} />
            </button>
            <div className="timebar-info" data-tip={momentText} data-tip-start="">
              <span className="timebar-when">
                {when(moment.date)}
                <span className="muted">
                  {" "}
                  · {time === last ? t.map.latest : t.map.commitOf(time! + 1, last + 1)}
                </span>
              </span>
              <span className="timebar-what">{momentText}</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={closeTime}
              aria-label={t.map.backToNow}
              data-tip={t.map.backToNow}
              data-key="Esc"
              data-tip-end=""
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <Timeline
            commits={history.commits}
            index={time!}
            rangeRef={range}
            summarize={summarize}
            onChange={(i) => {
              setPlaying(false);
              setTime(i);
            }}
          />
        </div>
      )}

      <div className="panel maptools" role="toolbar" aria-label={t.map.tools}>
        {!!graph.nodes.size &&
          (["goal", "prompt", "output"] as const).map((type) => (
            <button
              key={type}
              type="button"
              className="tool"
              aria-pressed={filters.types[type]}
              onClick={() => toggleType(type)}
              aria-label={t.map.toggleType(filters.types[type], type)}
              data-tip={t.map.toggleType(filters.types[type], type)}
            >
              <TypeGlyph type={type} size={15} />
              <span>{typeCounts[type]}</span>
            </button>
          ))}
        {!!graph.nodes.size && <span className="tool-sep" />}
        <button
          type="button"
          className="tool sq is-roomy"
          disabled={timeOpen || !!lens || !canvas.canUndo}
          onClick={undo}
          aria-label={t.ink.undo}
          data-tip={t.ink.undo}
          data-key="Ctrl Z"
        >
          <Icon name="undo" size={15} />
        </button>
        <button
          type="button"
          className="tool sq is-roomy"
          disabled={timeOpen || !!lens || !canvas.canRedo}
          onClick={redo}
          aria-label={t.ink.redo}
          data-tip={t.ink.redo}
          data-key="Ctrl Shift Z"
        >
          <Icon name="redo" size={15} />
        </button>
        <span className="tool-sep is-roomy" />
        <button
          type="button"
          className="tool sq zoom-step"
          onClick={() => void flow.zoomOut(ZOOM_NOW)}
          aria-label={t.map.zoomOut}
          data-tip={t.map.zoomOut}
        >
          <Icon name="minus" size={15} />
        </button>
        <ZoomValue onReset={() => void flow.zoomTo(1, ZOOM_NOW)} />
        <button
          type="button"
          className="tool sq zoom-step"
          onClick={() => void flow.zoomIn(ZOOM_NOW)}
          aria-label={t.map.zoomIn}
          data-tip={t.map.zoomIn}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button"
          className="tool sq"
          onClick={() => {
            initialView.current = false;
            fittingAll.current = true;
            overview({ duration: 0 }, ZOOM.min);
          }}
          aria-label={t.map.fit}
          data-tip={t.map.fit}
        >
          <Icon name="fit" size={15} />
        </button>
        <span className="tool-sep" />
        <ToolMenu
          open={toolsOpen}
          onOpen={setToolsOpen}
          items={[
            {
              icon: "lens",
              label: t.map.lens,
              note: selected?.kind === "node" ? "L" : t.map.lensNeedsNode,
              checked: !!lensId,
              disabled: timeOpen || selected?.kind !== "node",
              run: () => {
                setInkTool(null);
                setLens((l) => !l);
              },
            },
            {
              icon: "clock",
              label: t.map.time,
              checked: timeOpen,
              run: () => (timeOpen ? closeTime() : openTime()),
            },
            {
              icon: "pen",
              label: t.ink.draw,
              checked: inking,
              disabled: !inkShown || !ink.ready,
              run: () => setInkTool((tool) => (tool ? null : "select")),
            },
            {
              icon: "undo",
              label: t.ink.undo,
              note: "Ctrl Z",
              tight: true,
              apart: true,
              disabled: timeOpen || !!lens || !canvas.canUndo,
              run: undo,
            },
            {
              icon: "redo",
              label: t.ink.redo,
              note: "Ctrl Shift Z",
              tight: true,
              disabled: timeOpen || !!lens || !canvas.canRedo,
              run: redo,
            },
            {
              icon: "download",
              label: t.map.picture,
              note: pictureFailed ? t.map.pictureFailed : undefined,
              apart: true,
              disabled: picturing,
              run: () => void exportPicture(),
            },
            {
              icon: "help",
              label: t.map.legend,
              note: "?",
              checked: keyOpen,
              run: () => setKeyOpen((o) => !o),
            },
          ]}
        />
        {keyOpen && <MapKey />}
      </div>
    </div>
  );
}

type ToolItem = {
  icon: IconName;
  label: string;
  /** Its key, or why it is off. */
  note?: string;
  /** A mode: shows whether it is on. */
  checked?: boolean;
  disabled?: boolean;
  /** Only here while the bar is too narrow to show it. */
  tight?: boolean;
  /** Set apart from the items above it. */
  apart?: boolean;
  run: () => void;
};
/** The toolbar's ···: the paused modes, export and the legend, and what a narrow bar leaves out. */
function ToolMenu({
  open,
  onOpen,
  items,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  items: ToolItem[];
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as globalThis.Node)) onOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, onOpen]);
  return (
    <div className="more tool-more" ref={box}>
      <button
        type="button"
        className="tool sq"
        aria-label={t.manage.more}
        aria-expanded={open}
        aria-haspopup="menu"
        data-tip={open ? undefined : t.manage.more}
        data-tip-end=""
        onClick={() => onOpen(!open)}
      >
        <Icon name="working" size={15} />
      </button>
      {open && (
        <div className="more-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              disabled={item.disabled}
              className={`more-item tool-item${item.tight ? " is-tight" : ""}${item.apart ? " is-apart" : ""}`}
              onClick={() => {
                onOpen(false);
                item.run();
              }}
            >
              <Icon name={item.icon} size={15} />
              <span>{item.label}</span>
              {item.note && <small>{item.note}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The current zoom; click for 100%. Its own component, so zooming redraws only this. */
function ZoomValue({ onReset }: { onReset: () => void }) {
  const zoom = useStore((s) => Math.round(s.transform[2] * 100));
  return (
    <button
      type="button"
      className="tool zoom-value"
      onClick={onReset}
      aria-label={t.map.zoomReset}
      data-tip={t.map.zoomReset}
    >
      {zoom}%
    </button>
  );
}

/** What the marks on the map mean, opened from the toolbar. */
function MapKey() {
  return (
    <dl className="panel mapkey">
      <div>
        <dt>
          <i className="key-dot" />
        </dt>
        <dd>{t.map.keyRecent}</dd>
      </div>
      {(["goal", "prompt", "output"] as const).map((p) => (
        <div key={p}>
          <dt>
            <span className={`key-shape t-${p}`} />
          </dt>
          <dd>{t.map[p === "goal" ? "keyGoal" : p === "prompt" ? "keyPrompt" : "keyOutput"]}</dd>
        </div>
      ))}
      <div>
        <dt>
          <span className="mcard-pin is-key">1</span>
        </dt>
        <dd>{t.map.keyPin}</dd>
      </div>
      <div>
        <dt>
          <span className="key-line" />
        </dt>
        <dd>{t.map.keyTree}</dd>
      </div>
      <div>
        <dt>
          <span className="key-preview">
            <Icon name="preview" size={13} />
          </span>
        </dt>
        <dd>{t.map.keyPreview}</dd>
      </div>
      <div>
        <dt>
          <span className="key-ink">
            <Icon name="pen" size={13} />
          </span>
        </dt>
        <dd>{t.ink.keyInk}</dd>
      </div>
      <div className="mapkey-head">{t.map.keysTitle}</div>
      {t.map.shortcuts.map(([keys, what]) => (
        <div key={keys} className="mapkey-key">
          <dt>
            <kbd>{keys}</kbd>
          </dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}
