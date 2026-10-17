import { aheadKind, onlyGaps } from "../data/reasons.js";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  cloneElement,
  type CSSProperties,
  type ReactElement,
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
import { createPortal } from "react-dom";
import { primaryOf, type Graph, type Hand, type Primary } from "../data/store.js";
import type { SnapshotCommit, SnapshotRef, SyncFlag, SyncFlags } from "../data/types.js";
import { isDraft } from "../data/drafts.js";
import { FileGlyph, Icon, TypeGlyph, TypeTile } from "../components/Glyph.js";
import { fileOf, infoOf, previewOf, useFiles } from "../data/files.js";
import type { LocalFile } from "../panel/FileView.js";
import { CardPreview, previewHeight } from "./CardPreview.js";
import { Tray, Pet } from "../components/Pet.js";
import {
  CARD,
  GAP,
  lensLayout,
  rectOf,
  treeLayout,
  isResult,
  flagRuns,
  shownTree,
  type Layout,
  type Placed,
  type Rect,
  type Shown,
} from "./layout.js";
import { PUBLIC } from "../shell/work.js";
import { continueDrag } from "../shell/drag.js";
import { nearest, refPath, regionPath } from "./geometry.js";
import { fitZoom, watchSpace } from "./pointer.js";
import { routeLinks, type Route } from "./route.js";
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
  type Pt,
  type Sizes,
} from "./drawings.js";
import { useCanvas, type Picks } from "./useCanvas.js";
import {
  boxRect,
  cornerOf,
  fitBox,
  heldBy,
  membersOf,
  newRegionId,
  placeCards,
  shifted,
  type Region,
} from "./canvas.js";
import { regionLines, type CodeEdge, type RegionLine, type RegionLineKind } from "./regions.js";
import {
  comparisonsFor,
  outputsToCompare,
  reactionsIn,
  reactsWith,
  type Answer,
  type Reaction,
} from "./reactions.js";
import { RegionProducts } from "./Reaction.js";
import { api } from "../data/api.js";
import { ago, readStored, when, writeStored } from "../util.js";
import { t } from "../i18n.js";
// At 100% a card shows all it has; there is nothing more to see closer in.
const ZOOM = { min: 0.4, max: 1 };
// Below this, card names get too small to read at a glance; views the map picks by itself stay above it.
const READABLE = 0.9;
// Each card's second line of facts, under its title row. It is always laid out, so zooming never moves
// a card; far out it is hidden.
const DETAIL_H = 18;
// Further out than these, a card shows only its type and name, the name a size and then two sizes larger
// so it still reads.
const FAR = [0.7, 0.5];
// A selected card this close to an edge, or under a floating panel, is brought further in.
const COMFORT = 56;
// Room kept clear around fitted cards; the bottom leaves space for the toolbar.
const PAD = { top: 40, right: 48, bottom: 84, left: 48 };
// Matches the card glide in styles.css (cubic-bezier(.215, .61, .355, 1), .42s), so a pinned card holds still.
const GLIDE = {
  duration: 420,
  ease: (t: number) => 1 - (1 - t) ** 3,
  interpolate: "linear" as const,
};

type CardData = {
  graph: Graph;
  id: string;
  h: number;
  w: number;
  /** Its file, when the card can open a preview of it, and whether that preview is open. */
  preview: { file: LocalFile; open: boolean } | null;
  /** In the tree, this card's result outputs: folded into a count, or opened as children. */
  fold: { ids: string[]; open: boolean } | null;
  /** Its reference to or from the selected Node. */
  rel: "cites" | "citedBy" | null;
  dim: boolean;
  selected: boolean;
  /** Picked with the box or with Shift / Ctrl, to move together. */
  picked: boolean;
  /** Close up, a second line of facts under its title row. */
  detail: boolean;
  top: boolean;
  /** Nodes under it, and how many of them are behind: named on it when the map is zoomed far out. */
  under: { n: number; behind: number } | null;
  folded: number;
  /** Shown cards hanging from it. */
  kids: number;
  touched: boolean;
  /** Its place among the sources of the draft being written, from 1; 0 when it is not there. */
  pin: number;
  /** Its place among the sources of the Card opened beside the map, and whether it changed since. */
  src: { n: number; changed: boolean } | null;
};
type LabelData = { text: string };
type LinkData = {
  kind: "tree" | "ref";
  dim: boolean;
  hot: boolean;
  from: Rect;
  to: Rect;
  /** A reference's way round the cards; without one it curves straight across. */
  route?: Route;
};
type RegionLineData = { kind: RegionLineKind; from: Rect; to: Rect; tip: string };
type GhostData = { name: string; w: number; h: number; region: string };
type Peek = { id: string; left: number; top: number; above: boolean };
/** A card in a region keeps a faint copy at its place in the tree: `ghost:<id>`. */
const GHOST = "ghost:";
/** How long a dragged card waits over another before letting go forms a region. */
const HOLD = 450;

/** Card controls that act without selecting the card. */
type Actions = {
  activeRole: string | null;
  onRole: (id: string) => void;
  onFold: (id: string) => void;
  /** Opens a card's folded result outputs as children, or folds them again. */
  onOutputs: (id: string) => void;
  /** Opens a preview of the card's file under it, or closes it. */
  onPreview: (id: string) => void;
};
const MapActions = createContext<Actions>({
  activeRole: null,
  onRole: () => {},
  onFold: () => {},
  onOutputs: () => {},
  onPreview: () => {},
});
/** Ahead and behind Nodes; every other card stays quiet. */
const MapFlags = createContext<SyncFlags>({});

const descendants = (kidsOf: Shown["kidsOf"], id: string): number =>
  kidsOf(id).reduce((sum, c) => sum + 1 + descendants(kidsOf, c.id), 0);
const underIds = (kidsOf: Shown["kidsOf"], id: string): string[] =>
  kidsOf(id).flatMap((c) => [c.id, ...underIds(kidsOf, c.id)]);
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

/**
 * A card is one line: its type, its name, then what sets it apart. On the left corner, its number in the
 * draft being written; after the name, the new dot and its place in an opened Card; on the right, its tag
 * and the lanes it went to in Cards.
 */
const NodeCard = memo(function NodeCard({ data }: NodeProps<Node<CardData>>) {
  const { onFold, onOutputs, onPreview } = useContext(MapActions);
  const flags = useContext(MapFlags);
  const flag = flags[data.id];
  const files = useFiles();
  const n = data.graph.nodes.get(data.id)!;
  const state = data.graph.states.get(data.id)!;
  const hands = data.graph.handedTo(data.id);
  const p = primaryOf(n.type);
  const foldBehind = data.fold?.ids.filter((id) => flags[id]?.behind).length ?? 0;
  const file = fileOf(n);
  const local = file?.kind === "file" ? file : null;
  const missing = !!local && infoOf(files, local.path) === null;
  const open = !!data.preview?.open;
  const tileSize = data.top ? 26 : 22;
  const glyph = local && (
    <FileGlyph show={local.show} missing={missing} size={data.top ? 15 : 13} kind={p} />
  );
  const card = (
    <div
      className={`mcard t-${p}${local ? " is-file" : ""}${missing ? " is-missing" : ""}${data.top ? " is-top" : ""}${data.folded ? " is-stack" : ""}${data.rel ? " is-rel" : ""}${data.dim ? " is-dim" : ""}${data.selected ? " is-selected" : ""}${data.picked ? " is-picked" : ""}${data.detail ? " has-detail" : ""}${data.touched ? " is-touched" : ""}${state.deprecated ? " is-deprecated" : ""}${flag?.ahead ? " is-ahead" : ""}${flag?.behind ? ` is-behind${onlyGaps(flag.behind.reasons) ? " is-gap" : ""}` : ""}`}
      style={
        {
          width: data.w,
          height: open ? (data.top ? CARD.top : CARD.h) : data.h,
          "--head": `${data.top ? CARD.top : CARD.h}px`,
        } as CSSProperties
      }
    >
      <Handles />
      {data.pin > 0 && (
        <span className="mcard-pin" title={t.side.draftSource(data.pin)}>
          {data.pin}
        </span>
      )}
      {local && data.preview ? (
        // The file's tile opens a look at the file under the card, as a note embeds it.
        <button
          type="button"
          className={`tile k-${p} is-file mcard-preview nopan nodrag${open ? " is-open" : ""}`}
          style={{ width: tileSize, height: tileSize }}
          onClick={(e) => {
            e.stopPropagation();
            onPreview(data.id);
          }}
          aria-label={open ? t.map.closePreview : t.map.openPreview}
          aria-pressed={open}
          data-tip={open ? t.map.closePreview : t.map.openPreview}
        >
          {glyph}
          <span className="mcard-preview-eye">
            <Icon name={open ? "unpreview" : "preview"} size={data.top ? 14 : 12} />
          </span>
        </button>
      ) : local ? (
        <span
          className={`tile k-${p} is-file`}
          style={{ width: tileSize, height: tileSize }}
          title={missing ? t.file.missing : local.path}
        >
          {glyph}
        </span>
      ) : (
        <TypeTile kind={n.type} size={data.top ? 30 : 24} />
      )}
      <span className="mcard-name">{n.name}</span>
      {data.under && (
        // Short on the card, the behind count marked as the legend marks it; spelled out on hover.
        <span className="mcard-sum" title={t.map.branchSum(data.under.n, data.under.behind)}>
          {data.under.n}
          {data.under.behind > 0 && <i className="mcard-sum-behind">{data.under.behind}</i>}
        </span>
      )}
      {state.recent && <i className="new-dot" title={t.node.recent} />}
      {data.src?.changed && (
        <span className="mcard-changed" title={t.side.changedSince}>
          <Icon name="clock" size={12} />
        </span>
      )}
      {data.src && (
        <span className="num ref" title={t.side.cardSource(data.src.n)}>
          {data.src.n}
        </span>
      )}
      {data.rel ? (
        <span className="mcard-rel">
          {data.rel === "cites" ? t.map.relCites : t.map.relCitedBy}
        </span>
      ) : local?.ext ? (
        <span className="mcard-tag is-ext">{local.ext}</span>
      ) : (
        n.tags.length > 0 && (
          <span className="mcard-tag" title={n.tags.join(", ")}>
            {n.tags[0]}
          </span>
        )
      )}
      {hands.length > 0 && <Faces graph={data.graph} hands={hands} />}
      {data.fold && (
        <button
          type="button"
          className={`mcard-outputs nopan nodrag${data.fold.open ? " is-open" : ""}${foldBehind ? " is-behind" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onOutputs(data.id);
          }}
          aria-label={
            data.fold.open
              ? t.map.foldOutputs
              : t.map.foldedOutputs(data.fold.ids.length, foldBehind)
          }
          data-tip={
            data.fold.open
              ? t.map.foldOutputs
              : t.map.foldedOutputs(data.fold.ids.length, foldBehind)
          }
        >
          <TypeGlyph type="output" size={11} />
          {data.fold.ids.length}
        </button>
      )}
      {data.kids > 0 && (
        <button
          type="button"
          className={`mcard-fold nopan nodrag${data.folded ? " is-folded" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onFold(data.id);
          }}
          aria-label={
            data.folded ? t.map.expandChildren(n.name, data.folded) : t.map.collapseChildren(n.name)
          }
          data-tip={data.folded ? t.map.expandTitle(data.folded) : t.map.collapseTitle}
        >
          <Icon name={data.folded ? "plus" : "minus"} size={10} />
        </button>
      )}
      {data.detail && <Detail graph={data.graph} id={data.id} flag={flag} path={local?.path} />}
    </div>
  );
  // A preview hangs under its card; the card stays the title row that links meet.
  if (open && data.preview)
    return (
      <div className="mstack" style={{ width: data.w, height: data.h }}>
        {card}
        <CardPreview file={data.preview.file} graph={data.graph} />
      </div>
    );
  return card;
});

/**
 * The lanes a Node went to in published Cards, up to three faces: a Role, or the public area. One still
 * waiting to be received has a blue ring and an envelope, amber when that Card pinned an older version;
 * one received and still being done, to be returned, has a grey ellipsis. Finished lanes stay quiet. A
 * Role's face selects the Role.
 */
function Faces({ graph, hands }: { graph: Graph; hands: Hand[] }) {
  const { activeRole, onRole } = useContext(MapActions);
  // Two faces at most, those still waiting on a Card first; the rest are counted.
  const need = (h: Hand) => (h.old ? 3 : h.waiting ? 2 : h.doing ? 1 : 0);
  const shown = [...hands].sort((x, y) => need(y) - need(x)).slice(0, 2);
  return (
    <span className="mcard-faces">
      {shown.map((h) => {
        const role = h.lane === PUBLIC ? undefined : graph.roles.get(h.lane);
        const tip = t.map.handed(
          role?.title ?? (h.lane === PUBLIC ? null : t.work.goneRole(h.lane)),
          h.cards,
          h.waiting,
          h.doing,
          h.old,
        );
        const cls = `mcard-face${h.old ? " is-old" : h.waiting ? " is-waiting" : ""}${activeRole !== null && activeRole === h.lane ? " is-active" : ""}`;
        const face = h.lane === PUBLIC ? <Tray size={18} /> : <Pet id={h.lane} size={18} />;
        const badge = h.waiting ? "mail" : h.doing ? "working" : null;
        const envelope = badge && (
          <i className={`face-env${badge === "mail" ? "" : ` is-${badge}`}`}>
            <Icon name={badge} size={8} />
          </i>
        );
        return role ? (
          <button
            key={h.lane}
            type="button"
            className={`${cls} nopan nodrag`}
            aria-label={tip}
            data-tip={tip}
            onClick={(e) => {
              e.stopPropagation();
              onRole(role.id);
            }}
          >
            {face}
            {envelope}
          </button>
        ) : (
          <span key={h.lane || "public"} className={cls} data-tip={tip}>
            {face}
            {envelope}
          </span>
        );
      })}
      {hands.length > shown.length && (
        <span className="mcard-more">+{hands.length - shown.length}</span>
      )}
    </span>
  );
}

function LensLabel({ data }: NodeProps<Node<LabelData>>) {
  return (
    <div className="lens-label" style={{ width: CARD.w }}>
      {data.text}
    </div>
  );
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<LinkData>>) {
  const state = `${data?.dim ? " is-dim" : ""}${data?.hot ? " is-hot" : ""}`;
  if (data?.kind === "ref") {
    const { path, arrow } = data.route ?? refPath(data.from, data.to);
    return (
      <>
        <BaseEdge id={id} path={path} className={`link link-ref${state}`} />
        <path d={arrow} className={`link-arrow${state}`} />
      </>
    );
  }
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

/** A line between two cards in a region; its meaning shows on hover, beside it. */
function RegionEdge({ id, data }: EdgeProps<Edge<RegionLineData>>) {
  if (!data) return null;
  const { path, arrow, label } = regionPath(data.from, data.to, data.kind);
  const arrowed = data.kind === "link" || data.kind === "code" || data.kind === "card";
  return (
    <g className={`rline rline-${data.kind}`} data-line={id}>
      <path d={path} className="rline-hit" />
      <path d={path} className="rline-path" />
      {data.kind === "card" && <path d={path} className="rline-inner" />}
      {arrowed && <path d={arrow} className="rline-arrow" />}
      <text
        x={label.x}
        y={label.y}
        className="rline-label"
        textAnchor={label.anchor}
        dominantBaseline="middle"
      >
        {data.tip}
      </text>
    </g>
  );
}

/** Where a card in a region stands in the tree: faint, and a click goes to its region. */
function GhostCard({ data }: NodeProps<Node<GhostData>>) {
  return (
    <div
      className="mghost"
      style={{ width: data.w, height: data.h }}
      title={t.map.region.ghost(data.region)}
    >
      <Handles />
      <span className="mghost-name">{data.name}</span>
    </div>
  );
}

/**
 * Regions under the cards: a tinted block with its name, how many cards stand in it and a way to
 * dissolve it. Its edge shows dashed while a card dragged over it would join, and while one is drawn.
 */
function RegionLayer({
  regions,
  members,
  related,
  reactions,
  editing,
  onEdit,
  onName,
  onDissolve,
}: {
  regions: Region[];
  members: Map<string, string[]>;
  /** Regions with at least one line between their cards. */
  related: ReadonlySet<string>;
  /** What each region's cards give together, by region; a region with one shows it instead of the no-relation line. */
  reactions: Map<string, Reaction[]>;
  editing: string | null;
  onEdit: (id: string | null) => void;
  onName: (id: string, name: string) => void;
  onDissolve: (id: string) => void;
}) {
  // Straight into the viewport, under the cards and lines: the flow's own portal layer sits above them.
  const host = useStore(
    (s) => s.domNode?.querySelector<HTMLElement>(".react-flow__viewport") ?? null,
  );
  if (!host) return null;
  return createPortal(
    <div className="map-regions">
      {regions.map((r) => {
        const ids = members.get(r.id) ?? [];
        return (
          <div
            key={r.id}
            className="map-region"
            data-region={r.id}
            style={{ left: r.box[0], top: r.box[1], width: r.box[2], height: r.box[3] }}
          >
            <div className="map-region-head">
              {editing === r.id ? (
                <input
                  className="map-region-input"
                  aria-label={t.map.region.name}
                  placeholder={t.map.region.unnamed}
                  defaultValue={r.name}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      onEdit(null);
                    }
                  }}
                  onBlur={(e) => {
                    if (editing === r.id) onName(r.id, e.currentTarget.value.trim());
                  }}
                />
              ) : (
                <span
                  className={`map-region-name${r.name ? "" : " is-blank"}`}
                  title={t.map.region.rename}
                  onClick={() => onEdit(r.id)}
                >
                  {r.name || t.map.region.unnamed}
                </span>
              )}
              <span className="map-region-count">{t.map.region.count(ids.length)}</span>
              <button
                type="button"
                className="icon-btn map-region-dissolve"
                aria-label={t.map.region.dissolve}
                title={t.map.region.dissolve}
                onClick={() => onDissolve(r.id)}
              >
                <Icon name="ungroup" size={14} />
              </button>
            </div>
            {ids.length > 1 && !related.has(r.id) && !reactions.get(r.id)?.length && (
              <div className="map-region-none">{t.map.region.none}</div>
            )}
          </div>
        );
      })}
    </div>,
    host,
  );
}

/**
 * The second line a card gets close up: why it is behind or ahead, then its tags (or a file's path), when
 * it last changed and what it is linked to. Only facts the map already has, nothing summarised.
 */
function Detail({
  graph,
  id,
  flag,
  path,
}: {
  graph: Graph;
  id: string;
  flag?: SyncFlag;
  path?: string;
}) {
  const n = graph.nodes.get(id)!;
  const changed = changedAt(graph, id);
  const cites =
    n.links.filter((l) => l.ref?.kind === "node").length +
    n.materials.filter((m) => m.kind === "node").length;
  const citedBy = n.incoming.filter((i) => i.from.kind === "node").length;
  const facts = [
    path ?? n.tags.join(" · "),
    changed && t.map.changedAgo(ago(changed)),
    n.childIds.length > 0 && t.map.children(n.childIds.length),
    cites > 0 && t.map.cites(cites),
    citedBy > 0 && t.map.citedBy(citedBy),
  ].filter(Boolean);
  return (
    <span className="mcard-detail">
      {flag?.behind && <b className="is-behind">{t.map.behindWhy(flag.behind.reasons)}</b>}
      {flag?.ahead && (
        <b className="is-ahead">{t.map.aheadWhy(null, aheadKind(flag.ahead.reasons))}</b>
      )}
      {facts.join(" · ")}
    </span>
  );
}

function PeekCard({ graph, peek, flag }: { graph: Graph; peek: Peek; flag?: SyncFlag }) {
  const n = graph.nodes.get(peek.id);
  if (!n) return null;
  const cites =
    n.links.filter((l) => l.ref?.kind === "node").length +
    n.materials.filter((m) => m.kind === "node").length;
  const citedBy = n.incoming.filter((i) => i.from.kind === "node").length;
  const changed = changedAt(graph, n.id);
  const facts = [
    changed && t.map.changedAgo(ago(changed)),
    n.childIds.length > 0 && t.map.children(n.childIds.length),
    cites > 0 && t.map.cites(cites),
    citedBy > 0 && t.map.citedBy(citedBy),
  ].filter(Boolean);
  return (
    <div
      className={`panel map-peek${peek.above ? " is-above" : ""}`}
      style={{ left: peek.left, top: peek.top }}
      role="tooltip"
    >
      {flag?.behind && (
        <div className="map-peek-flag is-behind">
          <b>{t.map.behindWhy(flag.behind.reasons)}</b>
          <span>{t.map.behindNext}</span>
        </div>
      )}
      {flag?.ahead && (
        <div className="map-peek-flag is-ahead">
          <b>
            {t.map.aheadWhy(
              flag.ahead.since ? ago(flag.ahead.since) : null,
              aheadKind(flag.ahead.reasons),
            )}
          </b>
          <span>{t.map.aheadNext(aheadKind(flag.ahead.reasons))}</span>
        </div>
      )}
      <p>{n.description || t.node.noSummary}</p>
      {facts.length > 0 && <div className="map-peek-meta">{facts.join(" · ")}</div>}
    </div>
  );
}

/**
 * Lines from the robot lit in the dock to the cards on screen that the Cards on its desk carry, drawn
 * over the map in screen space and redrawn as the map moves.
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
  // The dock folding, a row opening or the window resizing moves where the lines start.
  const [moved, setMoved] = useState(0);
  useEffect(() => {
    const dock = box.current?.querySelector(".dock");
    if (!dock) return;
    const watch = new ResizeObserver(() => setMoved((n) => n + 1));
    watch.observe(dock);
    return () => watch.disconnect();
  }, [box]);
  useLayoutEffect(() => {
    const host = box.current;
    const row = host?.querySelector(`.dock [data-lane="${CSS.escape(lane)}"]`);
    const from = row?.querySelector(".lane-head") ?? row;
    if (!host || !from) return setPaths([]);
    const o = host.getBoundingClientRect(),
      a = from.getBoundingClientRect();
    const x1 = a.right - o.left,
      y1 = a.top + a.height / 2 - o.top;
    const next: string[] = [];
    for (const id of ids) {
      const card = host.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .mcard`);
      if (!card) continue;
      const b = card.getBoundingClientRect();
      const x2 = b.left - o.left,
        y2 = b.top + Math.min(b.height, 48) / 2 - o.top;
      // Off screen, or tucked under the dock.
      if (b.right < o.left || b.left > o.right || b.bottom < o.top || b.top > o.bottom) continue;
      if (x2 < x1 + 12) continue;
      const mx = x1 + (x2 - x1) / 2;
      next.push(`M${x1} ${y1}C${mx} ${y1},${mx} ${y2},${x2} ${y2}`);
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

/**
 * How many Nodes are behind or ahead, in the top corner of the map; a Node that is both counts in each.
 * Each count steps through its Nodes in tree order; nothing shows while no Node needs attention.
 */
/**
 * Behind and ahead counts at the top left. They count and step through only the types switched on; when a
 * type is off, the tip gives the count over all of them.
 */
function FlagCounts({
  graph,
  flags,
  visible,
  partial,
  onSelect,
}: {
  graph: Graph;
  flags: SyncFlags;
  visible: (id: string) => boolean;
  partial: boolean;
  onSelect: (ref: SnapshotRef) => void;
}) {
  const step = useRef<Record<keyof SyncFlag, number>>({ behind: 0, ahead: 0 });
  const kinds = useMemo(() => flagRuns(graph, flags, visible), [graph, flags, visible]);
  if (!kinds.length) return null;
  return (
    <div className="panel map-flags" role="group" aria-label={t.map.flagsLabel}>
      {kinds.map(({ state, ids, all }) => (
        <button
          key={state}
          type="button"
          className={`map-flag is-${state}`}
          aria-disabled={ids.length === 0 || undefined}
          data-tip-start=""
          data-tip={partial ? t.map.flagStepAll(all) : t.map.flagStep}
          onClick={() => {
            if (!ids.length) return;
            const i = step.current[state] % ids.length;
            step.current[state] = i + 1;
            onSelect({ kind: "node", id: ids[i] });
          }}
        >
          <i className="map-flag-sw" />
          {state === "behind" ? t.map.behindCount(ids.length) : t.map.aheadCount(ids.length)}
        </button>
      ))}
    </div>
  );
}

const nodeTypes = { node: NodeCard, label: LensLabel, ghost: GhostCard };
const edgeTypes = { link: LinkEdge, region: RegionEdge };
const NOTHING: ReadonlySet<string> = new Set();
const KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Filters = { types: Record<Primary, boolean> };

type MapProps = {
  graph: Graph;
  /** Ahead and behind Nodes from the real workspace; empty when the service cannot say. */
  flags: SyncFlags;
  selected: SnapshotRef | null;
  collapsed: ReadonlySet<string>;
  /** The draft being written: its sources in order (null for an address outside Tent). */
  draft: (string | null)[];
  /** The robot lit in the dock, and the Nodes the Cards on a robot's desk carry. */
  hotLane: string | null;
  carriedBy: (lane: string) => ReadonlySet<string>;
  /** The robot dock, laid over the map's top left; cards and regions dragged onto it go to a robot. */
  dock?: ReactNode;
  /** Whether arrow keys, Enter and Space drive the map right now. */
  keys: boolean;
  onSelect: (ref: SnapshotRef | null) => void;
  onFold: (id: string, expand?: boolean) => void;
  onExpand: () => void;
  /** A short message for the page to show, such as a save that lost to one made elsewhere. */
  onNotice: (message: string) => void;
};

export function MapView(props: MapProps) {
  return (
    <ReactFlowProvider>
      <MapContent {...props} />
    </ReactFlowProvider>
  );
}

function MapContent({
  graph,
  flags,
  selected,
  collapsed,
  draft,
  hotLane,
  carriedBy,
  dock,
  keys,
  onSelect,
  onFold,
  onExpand,
  onNotice,
}: MapProps) {
  const [filters, setFilters] = useState<Filters>(() => {
    const stored = readStored<Partial<Filters>>("tent-map-filters-v2", {});
    return {
      types: { goal: true, prompt: true, output: true, ...stored.types },
    };
  });
  const [hover, setHover] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Hover only previews a card's references once the pointer rests on it; passing over cards changes nothing.
  const hoverSoon = (id: string | null, delay: number) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(id), delay);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [lens, setLens] = useState(false);
  const [outside, setOutside] = useState(0);
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const flow = useReactFlow();
  useEffect(() => writeStored("tent-map-filters-v2", filters), [filters]);
  const visible = useCallback(
    (id: string) => {
      const n = graph.nodes.get(id);
      return !!n && filters.types[primaryOf(n.type)];
    },
    [graph, filters.types],
  );
  // The tree with switched-off types taken out: everything below lays out, folds and counts on this.
  const shown = useMemo(() => shownTree(graph, visible), [graph, visible]);

  // Cards fold only by hand. Only a change in what is folded makes a new layout.
  const foldKey = [...collapsed].sort().join();
  const folded = useMemo(() => collapsed, [foldKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- time ----------
  // null means now; otherwise an index into the commits, oldest first.
  const [time, setTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const history = useMemo(() => {
    const born = new Map<string, number>();
    for (const n of graph.snapshot.nodes) {
      const first = n.history.at(-1);
      const date = first ? graph.commits.get(first)?.date : undefined;
      born.set(n.id, date ? Date.parse(date) : 0);
    }
    return { commits: [...graph.snapshot.commits].reverse(), born };
  }, [graph]);
  const moment = time === null ? null : (history.commits[time] ?? null);
  const exists = useCallback(
    (id: string) => !moment || (history.born.get(id) ?? 0) <= Date.parse(moment.date),
    [history, moment],
  );
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
  const openTime = () => {
    setLens(false);
    setInkTool(null);
    setTime(last);
  };
  const closeTime = () => {
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

  // One focus at a time, and only it dims the map. A lane hovered in 分工 comes first: what its Cards
  // carried. Then the selection: a Node with its neighbours, a Role with what its Cards carried and the
  // Nodes it watches, or a Card with its sources, numbered in order.
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
  const focus = hotLane === null && selected?.kind === "node" ? selected.id : null;
  const lit = useMemo<ReadonlySet<string> | null>(() => {
    if (hotLane !== null) return carriedBy(hotLane);
    if (sources) return sources.ids;
    if (selected?.kind === "role")
      return new Set([...carriedBy(selected.id), ...graph.neighbours(selected.id)]);
    if (selected?.kind === "node") return graph.neighbours(selected.id);
    return null;
  }, [hotLane, carriedBy, sources, selected?.kind, selected?.id, graph]);
  const pins = useMemo(() => new Map(draft.map((id, i) => [id, i + 1] as const)), [draft]);
  const lensId = lens && selected?.kind === "node" && visible(selected.id) ? selected.id : null;

  // ---------- drawing ----------
  // Drawings keep their own map coordinates, so they show only on the tree, not in the lens or a
  // moment of the past, where cards stand elsewhere. null: drawing is off.
  const canvas = useCanvas(
    graph.snapshot.workspace.id,
    graph.snapshot.workspace.revision,
    onNotice,
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
    if (selected?.kind !== "node") setLens(false);
  }, [selected?.kind]);

  const [openOutputs, setOpenOutputs] = useState<ReadonlySet<string>>(() => new Set());
  // Cards showing a preview of their file: kept in this browser only, like what is folded.
  const files = useFiles();
  const previewKey = `tent-map-previews:${graph.snapshot.workspace.id}`;
  const [previews, setPreviews] = useState<ReadonlySet<string>>(
    () => new Set(readStored<string[]>(previewKey, [])),
  );
  useEffect(() => setPreviews(new Set(readStored<string[]>(previewKey, []))), [previewKey]);
  const previewFile = useCallback(
    (id: string) => {
      const n = graph.nodes.get(id);
      return n ? previewOf(n, files) : null;
    },
    [graph, files],
  );
  const grown = useCallback(
    (id: string) => {
      const file = previews.has(id) ? previewFile(id) : null;
      return file ? previewHeight(file) : DETAIL_H;
    },
    [previews, previewFile],
  );
  // Cards moved by hand stay where they were left, in the canvas file; the tree is laid out without them.
  // Moving cards keeps the view still, where another change of layout pins a card instead.
  const still = useRef(false);
  const arrange: typeof canvas.arrange = (change) => {
    still.current = true;
    canvas.arrange(change);
  };
  // Cards picked with the box or with Shift / Ctrl, which move together.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const tree = useMemo(
    () => treeLayout(graph, folded, openOutputs, grown, shown.kidsOf),
    [graph, folded, openOutputs, grown, shown],
  );
  const base = useMemo(() => placeCards(tree, canvas.positions), [tree, canvas.positions]);

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
  const drawn = useMemo(
    () => settle(ink.ink, anchorsOf(ink.ink, cardAnchors)),
    [ink.ink, cardAnchors],
  );
  const inkLive = useRef({ settled: drawn, inkPicked, undo: () => {}, redo: () => {} });
  inkLive.current = { settled: drawn, inkPicked, undo: () => undo(), redo: () => redo() };
  /** A change worked out on the drawings as shown, laid over them as they are when it lands. */
  const inkChange = (next: Ink[], picks?: Picks) => {
    const changes = inkChanges(inkLive.current.settled, next);
    if (changes.size) ink.commit((all) => withChanges(all, changes), picks);
  };
  // Undo and redo pick again what was picked on the side they step to.
  const undo = () => {
    const back = canvas.undo();
    if (back && inking) setInkPicked(new Set(back));
  };
  const redo = () => {
    const back = canvas.redo();
    if (back && inking) setInkPicked(new Set(back));
  };
  // A line end held by a card keeps where it last met it, so it stays there when the card is hidden.
  useEffect(() => {
    if (!ink.ready || inkPreview) return;
    const met = inkChanges(ink.ink, drawn);
    if (met.size) ink.keep(met);
  }, [drawn]);
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
      inkChange([...all, ...made], { before, after });
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
    ink.commit((all) => withWords(w.fresh ? [...all, w.fresh] : all, w.id, value), {
      before: w.before ?? now,
      after: gone ? now.filter((id) => id !== w.id) : now,
    });
  };
  useEffect(() => {
    if (!inking || !keys) return;
    const onKey = (e: KeyboardEvent) => {
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
        inkChange([...all, ...made], { before: [...picked], after });
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

  // ---------- regions ----------
  // Like drawings, regions show on the tree only. A card belongs to the region it was put in and stands in.
  const regionsShown = inkShown;
  const [naming, setNaming] = useState<string | null>(null);
  const members = useMemo(
    () =>
      regionsShown
        ? membersOf(
            canvas.regions,
            base,
            (id) => !!canvas.positions[id] && visible(id) && exists(id),
          )
        : new Map<string, string[]>(),
    [regionsShown, canvas.regions, canvas.positions, base, visible, exists],
  );
  const regionOfCard = useMemo(
    () => new Map([...members].flatMap(([r, ids]) => ids.map((id) => [id, r] as const))),
    [members],
  );
  // Cards standing in a region away from their place in the tree leave a ghost there.
  const ghosted = useMemo(() => {
    const out = new Set<string>();
    for (const id of regionOfCard.keys()) {
      const a = tree.placed.get(id),
        b = base.placed.get(id);
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) > 1) out.add(id);
    }
    return out;
  }, [regionOfCard, tree, base]);
  // Code imports, read only while some region holds two cards that could have them.
  const [code, setCode] = useState<CodeEdge[]>([]);
  const wantsCode = [...members.values()].some((ids) => ids.length > 1);
  useEffect(() => {
    if (!wantsCode) return;
    let current = true;
    api
      .moduleDeps()
      .then((r) => current && setCode(r.edges))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [wantsCode, graph.snapshot.workspace.revision]);
  const lines = useMemo(() => {
    const out = new Map<string, RegionLine[]>();
    for (const [rid, ids] of members)
      if (ids.length > 1) out.set(rid, regionLines(graph, ids, shown.upOf, code));
    return out;
  }, [members, graph, shown, code]);
  const linked = useMemo(
    () => new Set([...lines].flatMap(([rid, l]) => (l.length ? [rid] : []))),
    [lines],
  );
  // Outputs that meet a goal in a region are compared with it by Core, on demand; material changes
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
  const compareKey = toCompare.length ? `${workspaceId}:${toCompare.join(" ")}` : "";
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
  }, [compareKey, graph.snapshot.workspace.revision, flags]);
  const compared = useMemo(() => comparisonsFor(held, asked), [held, asked]);
  const reactions = useMemo(() => {
    const out = new Map<string, Reaction[]>();
    for (const [rid, ids] of members)
      if (ids.length > 1) out.set(rid, reactionsIn(graph, compared, ids.filter(visible)));
    return out;
  }, [members, graph, compared, visible]);
  const regionName = (rid: string) =>
    canvas.regions.find((r) => r.id === rid)?.name || t.map.region.unnamed;
  // The selected Node's references, marked on the cards at either end instead of drawn as lines.
  const rel = useMemo(() => {
    const n = focus ? graph.nodes.get(focus) : undefined;
    const out = new Map<string, "cites" | "citedBy">();
    if (!n) return out;
    for (const i of n.incoming) if (i.from.kind === "node") out.set(i.from.id, "citedBy");
    for (const l of n.links)
      if (l.ref?.kind === "node" && l.ref.id !== n.parentId && !n.childIds.includes(l.ref.id))
        out.set(l.ref.id, "cites");
    for (const m of n.materials) if (m.kind === "node" && m.id) out.set(m.id, "cites");
    out.delete(n.id);
    return out;
  }, [graph, focus]);
  const lensView = useMemo(
    () => (lensId ? lensLayout(graph, lensId, visible) : null),
    [graph, lensId, visible],
  );
  const view = lensView ?? base;

  // When what is folded changes, cards folding away stay for one glide and slide into the card that takes
  // them in; cards coming out start on that card and slide to their places. `from` is the layout before.
  const [motion, setMotion] = useState<{ from: Layout; to: Layout; run: boolean } | null>(null);
  const [laidSeen, setLaidSeen] = useState({ base, foldKey });
  if (laidSeen.base !== base) {
    setLaidSeen({ base, foldKey });
    if (laidSeen.foldKey !== foldKey && !lensView)
      setMotion({ from: laidSeen.base, to: base, run: false });
  }
  useEffect(() => {
    if (!motion) return;
    if (!motion.run) {
      // Let the cards coming out be drawn on their parent first, then send them off.
      const t = setTimeout(() => setMotion((m) => (m === motion ? { ...m, run: true } : m)), 40);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setMotion((m) => (m === motion ? null : m)), GLIDE.duration + 80);
    return () => clearTimeout(t);
  }, [motion]);
  // Where a card folding away or coming out sits at the far end of its slide: on its nearest shown ancestor.
  const hostOf = useCallback(
    (id: string, laid: Layout): Placed | null => {
      for (let up = shown.upOf(id); up; up = shown.upOf(up)) {
        const p = laid.placed.get(up);
        if (p) return p;
      }
      return null;
    },
    [shown],
  );

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [];
    const moving = motion?.to === base ? motion : null;
    const leaving = moving
      ? [...moving.from.placed.keys()].filter((id) => !base.placed.has(id))
      : [];
    for (const id of new Set([...base.placed.keys(), ...view.placed.keys(), ...leaving])) {
      if (!visible(id)) continue;
      const placed = view.placed.get(id) ?? base.placed.get(id);
      const at = placed ?? moving!.from.placed.get(id)!;
      // Folding away: at its host now, fading as it slides there. Coming out: on its host until it runs.
      const host = !placed
        ? hostOf(id, base)
        : moving && !moving.run && !moving.from.placed.has(id)
          ? (hostOf(id, moving.from) ?? hostOf(id, base))
          : null;
      if (!placed && !host) continue;
      const pos = host ? { x: host.x, y: rectOf(host).y } : { x: at.x, y: rectOf(at).y };
      const fold = lensView ? undefined : base.folds?.get(id);
      out.push({
        // Top-left position computed here: an origin offset would wait for measurement and move the card twice.
        id,
        type: "node",
        position: pos,
        draggable: false,
        // Cards outside the lens, or not yet written at the chosen time, keep their place invisibly.
        className: host ? "is-tucked" : view.placed.has(id) && exists(id) ? undefined : "is-away",
        data: {
          graph,
          id,
          h: at.h,
          w: at.w,
          preview: (() => {
            const file = lensView ? null : previewFile(id);
            return file ? { file, open: previews.has(id) && !!at.head } : null;
          })(),
          top: (at.head ?? at.h) >= CARD.top - 2,
          under: (() => {
            const ids = folded.has(id) ? underIds(shown.kidsOf, id) : [];
            return ids.length
              ? { n: ids.length, behind: ids.filter((u) => flags[u]?.behind).length }
              : null;
          })(),
          fold: fold
            ? { ids: fold, open: false }
            : !lensView && openOutputs.has(id)
              ? {
                  ids: shown.kidsOf(id).flatMap((c) => (isResult(graph, c.id) ? [c.id] : [])),
                  open: true,
                }
              : null,
          rel: lensView ? null : (rel.get(id) ?? null),
          detail: !lensView && !(previews.has(id) && previewFile(id)),
          selected: selected?.id === id,
          picked: picked.has(id),
          touched: touched.has(id),
          dim: !lensView && !!lit && id !== focus && !lit.has(id),
          folded: folded.has(id) ? descendants(shown.kidsOf, id) : 0,
          kids: shown.kidsOf(id).length,
          pin: pins.get(id) ?? 0,
          src: sources?.order?.get(id) ?? null,
        },
      });
    }
    if (!lensView)
      for (const id of ghosted) {
        const at = tree.placed.get(id)!;
        out.push({
          id: GHOST + id,
          type: "ghost",
          position: { x: at.x, y: rectOf(at).y },
          draggable: false,
          selectable: false,
          data: {
            name: graph.nodes.get(id)?.name ?? id,
            w: at.w,
            h: at.head ?? at.h,
            region: regionName(regionOfCard.get(id)!),
          },
        });
      }
    for (const l of view.labels)
      out.push({
        id: l.id,
        type: "label",
        position: { x: l.x, y: l.y },
        draggable: false,
        selectable: false,
        data: { text: l.text },
      });
    return out;
  }, [
    graph,
    base,
    view,
    lensView,
    motion,
    hostOf,
    openOutputs,
    rel,
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
    flags,
    previewFile,
    previews,
    shown,
    ghosted,
    tree,
    regionOfCard,
    canvas.regions,
  ]);

  const routed = useRef<{ view: typeof view; key: string; routes: Map<string, Route> } | null>(
    null,
  );
  const edges = useMemo<Edge[]>(() => {
    const out: Edge<LinkData>[] = [];
    const seen = new Set<string>();
    const real = (id: string) => (id.startsWith(GHOST) ? id.slice(GHOST.length) : id);
    const spot = (id: string) =>
      id.startsWith(GHOST) ? tree.placed.get(real(id)) : view.placed.get(id);
    // Tree lines keep to the tree: a card in a region is met at its ghost.
    const inTree = (id: string) => (!lensId && ghosted.has(id) ? GHOST + id : id);
    const add = (source: string, target: string, kind: LinkData["kind"]) => {
      const key = `${source}>${target}`;
      const a = spot(source),
        b = spot(target);
      if (
        source === target ||
        seen.has(key) ||
        !a ||
        !b ||
        !visible(real(source)) ||
        !visible(real(target)) ||
        !exists(real(source)) ||
        !exists(real(target))
      )
        return;
      // The lens shows only the focused Node's own lines. Elsewhere references are marks on the cards, not
      // lines; the tree keeps its own.
      if (lensId ? source !== lensId && target !== lensId : kind === "ref") return;
      const hot = !!lensId || [focus, hover].some((id) => id && (source === id || target === id));
      seen.add(key);
      out.push({
        id: key,
        source,
        target,
        type: "link",
        focusable: false,
        interactionWidth: 0,
        sourceHandle: "out",
        targetHandle: "in",
        data: { kind, hot, dim: !lensId && !!lit && !hot, from: rectOf(a), to: rectOf(b) },
      });
    };
    for (const n of graph.snapshot.nodes) {
      const up = visible(n.id) ? shown.upOf(n.id) : null;
      if (up) add(inTree(up), inTree(n.id), "tree");
    }
    for (const n of graph.snapshot.nodes) {
      for (const l of n.links)
        if (l.ref?.kind === "node" && l.ref.id !== n.parentId && !n.childIds.includes(l.ref.id))
          add(n.id, l.ref.id, "ref");
      for (const m of n.materials) if (m.kind === "node" && m.id) add(n.id, m.id, "ref");
    }
    // References find their way round the cards on the map now.
    const cards = [...view.placed.values()].filter((p) => visible(p.id) && exists(p.id));
    const refs = out.filter((e) => e.data!.kind === "ref");
    // Hover and focus only restyle lines, so the same references over the same cards keep their routes.
    const key = [...cards.map((p) => p.id), "|", ...refs.map((e) => e.id)].join(" ");
    if (routed.current?.view !== view || routed.current.key !== key)
      routed.current = {
        view,
        key,
        routes: routeLinks(
          cards.map(rectOf),
          refs.map((e) => ({
            id: e.id,
            from: e.data!.from,
            to: e.data!.to,
            // Within one column a reference goes round on the side free of tree lines: the outer side in the
            // lens, the left of top-level cards, otherwise the right.
            loop: (lensId ? e.data!.from.x < 0 : !shown.upOf(e.source)) ? -1 : 1,
          })),
        ),
      };
    for (const e of refs) e.data!.route = routed.current.routes.get(e.id);
    // Lines that matter now draw last, above the rest.
    const sorted: Edge[] = out.sort((x, y) => Number(x.data!.hot) - Number(y.data!.hot));
    if (lensId) return sorted;
    for (const l of [...lines.values()].flat()) {
      const a = view.placed.get(l.from),
        b = view.placed.get(l.to);
      if (!a || !b) continue;
      const tip =
        l.kind === "material"
          ? t.map.region.line.material(l.files ?? [])
          : l.kind === "code"
            ? t.map.region.line.code(l.imports ?? 0)
            : l.kind === "card"
              ? t.map.region.line.card(l.cards ?? [])
              : t.map.region.line[l.kind];
      sorted.push({
        id: `region:${l.kind}:${l.from}>${l.to}`,
        source: l.from,
        target: l.to,
        type: "region",
        focusable: false,
        interactionWidth: 0,
        sourceHandle: "out",
        targetHandle: "in",
        data: { kind: l.kind, from: rectOf(a), to: rectOf(b), tip },
      });
    }
    return sorted;
  }, [graph, view, lensId, visible, shown, exists, focus, lit, hover, tree, ghosted, lines]);

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
  const inView = useCallback(
    (r: Rect, margin = 12) => {
      const el = box.current;
      if (!el) return true;
      const v = flow.getViewport();
      return (
        r.x * v.zoom + v.x >= margin &&
        r.y * v.zoom + v.y >= margin &&
        (r.x + r.w) * v.zoom + v.x <= clearWidth() - margin &&
        (r.y + r.h) * v.zoom + v.y <= el.clientHeight - PAD.bottom + 36 - margin
      );
    },
    [flow, clearWidth],
  );
  /** Fit map rectangles into the clear area, zooming no further in than `maxZoom` or out than `minZoom`. */
  const fitRects = useCallback(
    (
      rects: Rect[],
      maxZoom = 1,
      motion: { duration: number } = { duration: 400 },
      minZoom = ZOOM.min,
    ) => {
      const el = box.current;
      if (!el || !rects.length) return;
      const x1 = Math.min(...rects.map((r) => r.x)),
        y1 = Math.min(...rects.map((r) => r.y));
      const x2 = Math.max(...rects.map((r) => r.x + r.w)),
        y2 = Math.max(...rects.map((r) => r.y + r.h));
      const w = clearWidth() - PAD.left - PAD.right,
        h = el.clientHeight - PAD.top - PAD.bottom;
      const zoom = fitZoom(x2 - x1, y2 - y1, { w, h }, Math.min(maxZoom, ZOOM.max), minZoom);
      void flow.setViewport(
        {
          x: PAD.left + w / 2 - ((x1 + x2) / 2) * zoom,
          y: PAD.top + h / 2 - ((y1 + y2) / 2) * zoom,
          zoom,
        },
        motion,
      );
    },
    [flow, clearWidth],
  );
  const viewRects = useCallback(
    (layout: Layout) => [
      ...[...layout.placed.values()].filter((p) => visible(p.id)).map(rectOf),
      ...layout.labels.map((l) => ({ x: l.x, y: l.y, w: CARD.w, h: 20 })),
    ],
    [visible],
  );

  /** The view the map opens with, and the fit button: everything if it fits at a readable size, else from the top. */
  const overview = useCallback(
    (motion: { duration: number } = { duration: 400 }) => {
      const el = box.current;
      const rects = [...viewRects(view), ...(regionsShown ? canvas.regions.map(boxRect) : [])];
      if (!el || !rects.length) return;
      const x1 = Math.min(...rects.map((r) => r.x)),
        y1 = Math.min(...rects.map((r) => r.y));
      const x2 = Math.max(...rects.map((r) => r.x + r.w)),
        y2 = Math.max(...rects.map((r) => r.y + r.h));
      const w = clearWidth() - PAD.left - PAD.right,
        h = el.clientHeight - PAD.top - PAD.bottom;
      const zoom = Math.min(1, Math.max(Math.min(w / (x2 - x1), h / (y2 - y1)), READABLE));
      void flow.setViewport(
        {
          x:
            (x2 - x1) * zoom <= w
              ? PAD.left + w / 2 - ((x1 + x2) / 2) * zoom
              : PAD.left - x1 * zoom,
          y: (y2 - y1) * zoom <= h ? PAD.top + h / 2 - ((y1 + y2) / 2) * zoom : PAD.top - y1 * zoom,
          zoom,
        },
        motion,
      );
    },
    [flow, view, viewRects, clearWidth, regionsShown, canvas.regions],
  );
  useEffect(() => {
    if (ready) overview({ duration: 0 });
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => overview(), 60);
    return () => clearTimeout(t);
  }, [filters.types]);

  // When the map's left edge moves (the sidebar folds or opens), shift the view back so cards stay put on screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let left = el.getBoundingClientRect().left;
    const observer = new ResizeObserver(() => {
      const now = el.getBoundingClientRect().left,
        moved = now - left;
      left = now;
      if (Math.abs(moved) < 1) return;
      const v = flow.getViewport();
      void flow.setViewport({ ...v, x: v.x - moved });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [flow]);

  // Selecting pans only when the card is out of view; the lens frames its whole neighbourhood.
  const lensReturn = useRef<{ viewport: Viewport; id: string } | null>(null);
  useEffect(() => {
    if (!ready) return;
    // Wait for the details panel to take its width.
    const t = setTimeout(() => {
      if (lensView) {
        fitRects(viewRects(lensView), 1, GLIDE);
        return;
      }
      const back = lensReturn.current;
      lensReturn.current = null;
      if (back && (!selected || back.id === selected.id)) {
        void flow.setViewport(back.viewport, { duration: 400 });
        return;
      }
      if ((selected?.kind === "role" || selected?.kind === "card") && lit) {
        const rects = [...lit].flatMap((id) => {
          const p = base.placed.get(id);
          return p && visible(id) ? [rectOf(p)] : [];
        });
        // A view the map picks by itself stays readable; the hint brings in whatever is left outside.
        if (rects.some((r) => !inView(r))) fitRects(rects, 1, undefined, READABLE);
      } else if (selected?.kind === "node") {
        // A result folded into its parent's count is brought in by that parent.
        let at: string | null | undefined = selected.id;
        while (at && !base.placed.has(at)) at = graph.nodes.get(at)?.parentId;
        const p = at ? base.placed.get(at) : undefined;
        const n = at ? graph.nodes.get(at) : undefined;
        // Bring the card in with what it hangs from and what hangs from it, or at least its parent,
        // centred in the part of the map that no floating panel covers.
        if (p && n && !inView(rectOf(p), COMFORT)) {
          const rectsOf = (ids: (string | null)[]) =>
            ids.flatMap((id) => {
              const q = id ? base.placed.get(id) : undefined;
              return q && visible(q.id) ? [rectOf(q)] : [];
            });
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
          const up = shown.upOf(n.id),
            kids = shown.kidsOf(n.id).map((c) => c.id);
          const rects =
            [
              [up, n.id, ...kids],
              [n.id, ...kids],
              [up, n.id],
            ]
              .map(rectsOf)
              .find((r) => fits(r) >= READABLE) ?? rectsOf([n.id]);
          fitRects(rects, Math.max(flow.getZoom(), READABLE), { duration: 350 }, READABLE);
        }
      }
    }, 140);
    return () => clearTimeout(t);
  }, [selected?.id, ready, lensId]);

  // Related cards outside the view get a way to bring them in.
  const related = useMemo(() => {
    if (!lit || lensView) return [];
    const ids = focus ? [focus, ...lit] : [...lit];
    return ids.flatMap((id) => {
      const p = base.placed.get(id);
      return p && visible(id) ? [rectOf(p)] : [];
    });
  }, [focus, lit, lensView, base, visible]);
  const countOutside = useCallback(
    () => setOutside(related.filter((r) => !inView(r)).length),
    [related, inView],
  );
  useEffect(() => {
    const t = setTimeout(countOutside, 600);
    return () => clearTimeout(t);
  }, [countOutside]);

  // When branches fold or unfold, the card you acted on (or the one nearest the middle) stays put on screen.
  const foldAnchor = useRef<string | null>(null);
  const prevBase = useRef(base);
  useEffect(() => {
    const before = prevBase.current;
    prevBase.current = base;
    const el = box.current;
    let anchor = foldAnchor.current;
    foldAnchor.current = null;
    if (still.current) {
      still.current = false;
      return;
    }
    if (before === base || !ready || lensView || !el) return;
    const v = flow.getViewport();
    if (!anchor || !before.placed.has(anchor) || !base.placed.has(anchor)) {
      const at = { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      const cx = (at.x - v.x) / v.zoom,
        cy = (at.y - v.y) / v.zoom;
      let best = Infinity;
      for (const p of before.placed.values()) {
        const d = Math.hypot(p.x + CARD.w / 2 - cx, p.y - cy);
        if (base.placed.has(p.id) && d < best) {
          best = d;
          anchor = p.id;
        }
      }
    }
    const a = anchor ? before.placed.get(anchor) : undefined,
      b = anchor ? base.placed.get(anchor) : undefined;
    if (!a || !b) return;
    // A card folded from off screen (from the tree outline, or scrolled away) is brought in: keeping it
    // where it was would leave the view on the space its branch used to fill.
    if (!inView(rectOf(a))) {
      fitRects([rectOf(b)], v.zoom, GLIDE, v.zoom);
      return;
    }
    if (a.x === b.x && a.y === b.y) return;
    void flow.setViewport(
      { x: v.x - (b.x - a.x) * v.zoom, y: v.y - (b.y - a.y) * v.zoom, zoom: v.zoom },
      GLIDE,
    );
  }, [base]);

  // Cards glide when the layout changes shape; lines wait until they land. The glide must be on in the
  // same render as the new positions, so it is derived rather than set afterwards.
  const shape = `${lensId}|${foldKey}`;
  const [settled, setSettled] = useState(shape);
  const morphing = shape !== settled;
  useEffect(() => {
    const t = setTimeout(() => setSettled(shape), 560);
    return () => clearTimeout(t);
  }, [shape]);

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

  // ---------- keyboard ----------
  // What the keys act on, current at the moment of the key.
  const live = {
    view,
    selected,
    lensId,
    collapsed,
    visible,
    shown,
    timeOpen,
    inking,
    picked,
    positions: canvas.positions,
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
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const {
        view,
        selected,
        lensId,
        collapsed,
        visible,
        shown,
        timeOpen,
        inking,
        picked,
        positions,
      } = latest.current;
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
      if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
        e.preventDefault();
        (e.key.toLowerCase() === "y" || e.shiftKey ? latest.current.redo : latest.current.undo)();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a" && !lensId) {
        e.preventDefault();
        setPicked(new Set([...view.placed.keys()].filter(visible)));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const onControl = !!el.closest("button, a, [role=radio]");
      const node = selected?.kind === "node" ? graph.nodes.get(selected.id) : undefined;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const act = (f: () => void) => {
        e.preventDefault();
        f();
      };
      if (key === "l") return node && act(() => setLens((l) => !l));
      if (key === "f") return act(() => latest.current.overview());
      if (key === "0") return act(() => void flow.zoomTo(1, { duration: 250 }));
      if (key === "=" || key === "+") return act(() => void flow.zoomIn({ duration: 200 }));
      if (key === "-") return act(() => void flow.zoomOut({ duration: 200 }));
      if (key === "t")
        return act(() => (timeOpen ? latest.current.closeTime() : latest.current.openTime()));
      if (key === "p") return act(() => setInkTool("select"));
      if (key === "?") return act(() => setKeyOpen((o) => !o));
      if (key === "r" && !lensId)
        return act(() => {
          // Back to where the tree puts them: the picked cards, else the selected one; with Shift, all.
          const back = e.shiftKey ? null : picked.size ? picked : new Set(node ? [node.id] : []);
          const going = Object.keys(positions).filter((id) => !back || back.has(id));
          if (going.length)
            latest.current.arrange({
              positions: Object.fromEntries(going.map((id) => [id, null])),
            });
        });
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
          const fold = key === "[";
          if (
            fold ? !collapsed.has(node.id) && shown.kidsOf(node.id).length : collapsed.has(node.id)
          ) {
            foldAnchor.current = node.id;
            onFold(node.id, !fold);
          }
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
      let next: string | null | undefined;
      if (!lensId && e.key === "ArrowLeft") next = shown.upOf(node.id);
      if (!lensId && e.key === "ArrowRight") {
        if (collapsed.has(node.id)) {
          foldAnchor.current = node.id;
          onFold(node.id, true);
          return;
        }
        const kids = shown.kidsOf(node.id).flatMap((c) => {
          const p = view.placed.get(c.id);
          return p ? [p] : [];
        });
        next = kids.sort((a, b) => Math.abs(a.y - here.y) - Math.abs(b.y - here.y))[0]?.id;
      }
      next ??= nearest(view, here, dir, visible);
      if (next) onSelect({ kind: "node", id: next });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, graph, onSelect, onFold, onExpand, flow]);

  // ---------- the pointer: dragging empty space picks with a box, dragging a card moves it ----------
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  // Cards dragged by hand wait, shifted, for the map to draw them where they were dropped.
  const settling = useRef<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const els = settling.current;
    if (!els.length) return;
    settling.current = [];
    // The map draws the new positions a moment after this render; the shift goes as it does.
    const done = () => els.forEach((el) => (el.style.translate = ""));
    const watch = new MutationObserver(() => {
      watch.disconnect();
      done();
    });
    els.forEach((el) => watch.observe(el, { attributes: true, attributeFilter: ["style"] }));
    const t = setTimeout(() => {
      watch.disconnect();
      done();
    }, 300);
    return () => clearTimeout(t);
  }, [base]);
  // Space held down: the left button moves the map instead.
  const space = useRef<ReturnType<typeof watchSpace> | null>(null);
  useEffect(() => {
    const watching = watchSpace(window);
    space.current = watching;
    return () => watching.stop();
  }, []);
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
  const regionEl = (id: string) =>
    box.current?.querySelector<HTMLElement>(`.map-region[data-region="${CSS.escape(id)}"]`) ?? null;
  /** The region under a map point: the last drawn wins where regions overlap. */
  const regionAt = (x: number, y: number) =>
    regionsShown
      ? ([...canvas.regions]
          .reverse()
          .find(
            (r) =>
              x >= r.box[0] &&
              x <= r.box[0] + r.box[2] &&
              y >= r.box[1] &&
              y <= r.box[1] + r.box[3],
          ) ?? null)
      : null;
  /**
   * Cards let go over a card held long enough: they stack under it, and the two stand in a region,
   * the one it is in or a new one. A new region takes the spot where the cards are if nothing else is
   * there, else the free margin left of the tree.
   */
  const gather = (onto: string, ids: string[]) => {
    const at = base.placed.get(onto)!;
    const head = rectOf(at);
    let top = head.y + (head.head ?? head.h) + 16;
    const placed: Record<string, Pt> = {};
    const rects: Rect[] = [head];
    for (const id of ids) {
      const p = base.placed.get(id);
      if (!p) continue;
      const r = rectOf(p);
      placed[id] = [head.x, top];
      rects.push({ ...r, x: head.x, y: top });
      top += (r.head ?? r.h) + 16;
    }
    const rid = regionOfCard.get(onto);
    const old = rid ? canvas.regions.find((r) => r.id === rid) : undefined;
    if (old) {
      arrange({
        positions: placed,
        regions: { [old.id]: { ...old, box: fitBox(old.box, rects) } },
      });
      return;
    }
    let box = fitBox(null, rects);
    const taken = (b: Region["box"]) =>
      [...view.placed.values()].some((p) => {
        if (p.id === onto || ids.includes(p.id) || !visible(p.id)) return false;
        const q = rectOf(p);
        return q.x < b[0] + b[2] && q.x + q.w > b[0] && q.y < b[1] + b[3] && q.y + q.h > b[1];
      }) ||
      canvas.regions.some(
        (r) =>
          r.box[0] < b[0] + b[2] &&
          r.box[0] + r.box[2] > b[0] &&
          r.box[1] < b[1] + b[3] &&
          r.box[1] + r.box[3] > b[1],
      );
    let dx = 0,
      dy = 0;
    if (taken(box)) {
      const left = Math.min(...[...tree.placed.values()].map((p) => p.x));
      dx = left - 160 - box[2] - box[0];
      for (let i = 0; i < 40 && taken([box[0] + dx, box[1] + dy, box[2], box[3]]); i++) dy += 80;
      box = [box[0] + dx, box[1] + dy, box[2], box[3]];
    }
    const positions: Record<string, Pt> = { [onto]: cornerOf(at, dx, dy) };
    for (const [id, [x, y]] of Object.entries(placed)) positions[id] = [x + dx, y + dy];
    const id = newRegionId();
    arrange({ positions, regions: { [id]: { id, name: "", box } } });
    if (!inView(boxRect({ id, name: "", box }))) fitRects([boxRect({ id, name: "", box })], 1);
  };
  const overDock = (ev: PointerEvent) =>
    !!document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".dock");
  const onPress = (e: React.PointerEvent) => {
    const el = box.current;
    const target = e.target as HTMLElement;
    if (e.button !== 0 || !el || inking || lensView || moment || space.current?.held()) return;
    if (target.closest("button, a, input, textarea, .panel")) return;
    const zoom = flow.getZoom();
    // A region's title moves the region and every card in it.
    const head = target.closest<HTMLElement>(".map-region-head");
    if (head) {
      const rid = head.parentElement!.dataset.region!;
      const r = canvas.regions.find((g) => g.id === rid);
      if (!r) return;
      const ids = members.get(rid) ?? [];
      const els = [head.parentElement!, ...ids.flatMap((i) => cardEl(i) ?? [])];
      track(
        e,
        (dx, dy, ev) => {
          // Over the robots, the region's cards go on together as a drag into a Card.
          if (ids.length && overDock(ev)) {
            el.classList.remove("is-moving");
            els.forEach((n) => (n.style.translate = ""));
            continueDrag({ kind: "node", id: ids[0], ids }, { x: ev.clientX, y: ev.clientY });
            return false;
          }
          el.classList.add("is-moving");
          setPeek(null);
          els.forEach((n) => (n.style.translate = `${dx / zoom}px ${dy / zoom}px`));
        },
        (moved, ev) => {
          if (!moved) return;
          el.classList.remove("is-moving");
          const dx = (ev.clientX - e.clientX) / zoom,
            dy = (ev.clientY - e.clientY) / zoom;
          const [x, y] = cornerOf({ id: rid, x: r.box[0], y: r.box[1], w: 0, h: 0 }, dx, dy);
          settling.current = els;
          // Cards hidden by the type switches or a folded branch move with the region too.
          const held = heldBy(canvas.regions, canvas.positions, base).get(rid) ?? [];
          arrange({
            regions: { [rid]: { ...r, box: [x, y, r.box[2], r.box[3]] } },
            positions: Object.fromEntries(
              held.map((i) => {
                const p = base.placed.get(i);
                return [i, p ? cornerOf(p, dx, dy) : shifted(canvas.positions[i]!, dx, dy)];
              }),
            ),
          });
        },
      );
      return;
    }
    const card = target.closest<HTMLElement>(".react-flow__node-node");
    if (card) {
      const id = card.dataset.id!;
      const ids = picked.has(id) ? [...picked] : [id];
      const els = ids.flatMap((i) => cardEl(i) ?? []);
      let gone = false;
      // The card held over, once it has waited long enough; and the region the pointer is over.
      let over: string | null = null,
        onto: string | null = null,
        into: string | null = null;
      let wait: ReturnType<typeof setTimeout> | undefined;
      // Cards the dragged ones would react with light up while they move.
      const kinds = new Set(ids.flatMap((i) => reactsWith(graph.nodes.get(i)?.type ?? "")));
      const glow = regionsShown
        ? [...view.placed.keys()]
            .filter(
              (q) =>
                !ids.includes(q) &&
                visible(q) &&
                kinds.has(primaryOf(graph.nodes.get(q)?.type ?? "")),
            )
            .flatMap((q) => cardEl(q) ?? [])
        : [];
      const mark = (kind: "join" | "into", id: string | null) => {
        const was = kind === "join" ? onto : into;
        if (was === id) return;
        if (was) (kind === "join" ? cardEl(was) : regionEl(was))?.classList.remove(`is-${kind}`);
        if (id) (kind === "join" ? cardEl(id) : regionEl(id))?.classList.add(`is-${kind}`);
        if (kind === "join") onto = id;
        else into = id;
      };
      const clear = () => {
        clearTimeout(wait);
        mark("join", null);
        mark("into", null);
        glow.forEach((n) => n.classList.remove("is-react"));
      };
      track(
        e,
        (dx, dy, ev) => {
          el.classList.add("is-moving");
          setPeek(null);
          // Over the robots, the cards go on as a drag into a Card instead of moving.
          if (overDock(ev)) {
            gone = true;
            clear();
            el.classList.remove("is-moving");
            els.forEach((n) => (n.style.translate = ""));
            continueDrag(
              {
                kind: "node",
                id,
                ...(ids.length > 1 ? { ids: [id, ...ids.filter((i) => i !== id)] } : {}),
              },
              { x: ev.clientX, y: ev.clientY },
            );
            return false;
          }
          els.forEach((n) => (n.style.translate = `${dx / zoom}px ${dy / zoom}px`));
          glow.forEach((n) => n.classList.add("is-react"));
          if (!regionsShown) return;
          const p = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          const under = [...view.placed.values()].find((q) => {
            if (ids.includes(q.id) || !visible(q.id) || !exists(q.id)) return false;
            const r = rectOf(q);
            return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + (r.head ?? r.h);
          });
          if ((under?.id ?? null) !== over) {
            clearTimeout(wait);
            mark("join", null);
            over = under?.id ?? null;
            if (over) {
              const held = over;
              wait = setTimeout(() => mark("join", held), HOLD);
            }
          }
          mark("into", onto ? null : (regionAt(p.x, p.y)?.id ?? null));
        },
        (moved, ev) => {
          const joining = onto,
            region = into;
          clear();
          if (!moved || gone) return;
          el.classList.remove("is-moving");
          const dx = (ev.clientX - e.clientX) / zoom,
            dy = (ev.clientY - e.clientY) / zoom;
          settling.current = els;
          if (joining) return gather(joining, ids);
          const positions: Record<string, Pt> = {};
          const rects: Rect[] = [];
          for (const i of ids) {
            const p = base.placed.get(i);
            if (!p) continue;
            positions[i] = cornerOf(p, dx, dy);
            rects.push({ ...rectOf(p), x: positions[i][0], y: positions[i][1] });
          }
          const r = region ? canvas.regions.find((g) => g.id === region) : undefined;
          arrange({
            positions,
            // Dropped into a region, the cards join it, and it grows to hold them.
            ...(r ? { regions: { [r.id]: { ...r, box: fitBox(r.box, rects) } } } : {}),
          });
        },
      );
      return;
    }
    // Anywhere else on the map, lines included, a drag draws the box.
    if (!target.closest(".react-flow")) return;
    const r = el.getBoundingClientRect();
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
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

  const toggleType = (t: Primary) =>
    setFilters((f) => ({ ...f, types: { ...f.types, [t]: !f.types[t] } }));

  const actions = useMemo<Actions>(
    () => ({
      activeRole: hotLane ?? (selected?.kind === "role" ? selected.id : null),
      onRole: (id) => onSelect({ kind: "role", id }),
      onFold: (id) => {
        foldAnchor.current = id;
        onFold(id);
      },
      onOutputs: (id) => {
        foldAnchor.current = id;
        setOpenOutputs((open) => {
          const next = new Set(open);
          if (!next.delete(id)) next.add(id);
          return next;
        });
      },
      onPreview: (id) => {
        foldAnchor.current = id;
        setPreviews((open) => {
          const next = new Set(open);
          if (!next.delete(id)) next.add(id);
          writeStored(previewKey, [...next]);
          return next;
        });
      },
    }),
    [hotLane, selected, onSelect, onFold, previewKey],
  );
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

  return (
    <div
      className={`map${lensView ? " is-lens" : ""}${morphing ? " is-morphing" : ""}${timeOpen ? " is-time" : ""}`}
      ref={box}
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
      <MapFlags.Provider value={flags}>
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
            panActivationKeyCode="Space"
            onInit={() => setReady(true)}
            onMoveStart={() => setPeek(null)}
            onMoveEnd={countOutside}
            onNodeClick={(e, node) => {
              if (node.type === "ghost") {
                const rid = regionOfCard.get(node.id.slice(GHOST.length));
                const r = rid && canvas.regions.find((g) => g.id === rid);
                if (r) fitRects([boxRect(r)], 1);
                return;
              }
              if (node.type !== "node") return;
              // Shift or Ctrl adds a card to the picked ones, or takes it out.
              if (e.shiftKey || e.ctrlKey || e.metaKey)
                return setPicked((old) => {
                  const next = new Set(old);
                  if (!next.delete(node.id)) next.add(node.id);
                  return next;
                });
              setPicked(new Set());
              onSelect({ kind: "node", id: node.id });
            }}
            onNodeMouseEnter={(_, node) => {
              if (node.type === "node") hoverSoon(node.id, 150);
            }}
            onNodeMouseLeave={() => hoverSoon(null, 100)}
            onPaneClick={() => {
              setPicked(new Set());
              onSelect(null);
            }}
          >
            {regionsShown && (
              <RegionLayer
                regions={canvas.regions}
                members={members}
                related={linked}
                reactions={reactions}
                editing={naming}
                onEdit={setNaming}
                onName={(rid, name) => {
                  setNaming(null);
                  const r = canvas.regions.find((g) => g.id === rid);
                  if (r && r.name !== name) arrange({ regions: { [rid]: { ...r, name } } });
                }}
                onDissolve={(rid) =>
                  arrange({
                    regions: { [rid]: null },
                    // Hidden members go back to the tree too, not only the cards on screen.
                    positions: Object.fromEntries(
                      (heldBy(canvas.regions, canvas.positions, base).get(rid) ?? []).map((i) => [
                        i,
                        null,
                      ]),
                    ),
                  })
                }
              />
            )}
            {inkShown && (
              <InkLayer
                ink={inkPreview ?? drawn}
                picked={inking ? inkPicked : NOTHING}
                writing={inking ? (inkWriting?.id ?? null) : null}
                hints={inkHints}
                framed={inking && inkTool === "select"}
                onSizes={setInkSizes}
              />
            )}
            {regionsShown && !inking && (
              <RegionProducts
                regions={canvas.regions}
                reactions={reactions}
                nameOf={(id) => graph.nodes.get(id)?.name ?? id}
              />
            )}
          </ReactFlow>
        </MapActions.Provider>
      </MapFlags.Provider>

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
          onCommit={(changes, picks) => ink.commit((all) => withChanges(all, changes), picks)}
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
      {peek && !inking && <PeekCard graph={graph} peek={peek} flag={flags[peek.id]} />}
      <FlagCounts
        graph={graph}
        flags={flags}
        visible={visible}
        partial={!Object.values(filters.types).every(Boolean)}
        onSelect={onSelect}
      />
      {inking && dock
        ? cloneElement(dock as ReactElement<{ shut?: boolean }>, { shut: true })
        : dock}
      {hotLane !== null && lit && <DeskWires lane={hotLane} ids={lit} box={box} />}
      {lensName ? (
        <div className="panel map-hint">
          <Icon name="lens" size={14} />
          <span className="map-hint-text">{t.map.lensOf(lensName)}</span>
          <button type="button" onClick={() => setLens(false)}>
            {t.map.exit}
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
            <div className="timebar-info">
              <span className="timebar-when">
                {when(moment.date)}
                <span className="muted">
                  {" "}
                  · {time === last ? t.map.latest : t.map.commitOf(time! + 1, last + 1)}
                </span>
              </span>
              <span className="timebar-what" title={momentText}>
                {momentText}
              </span>
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
        {(["goal", "prompt", "output"] as const).map((type) => (
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
            <span>{graph.counts[type]}</span>
          </button>
        ))}
        <span className="tool-sep" />
        <button
          type="button"
          className="tool tool-lens"
          aria-pressed={!!lensId}
          disabled={selected?.kind !== "node"}
          onClick={() => {
            setInkTool(null);
            setLens((l) => !l);
          }}
          aria-label={t.map.lens}
          data-tip={selected?.kind === "node" ? t.map.lensTitle : t.map.lensNeedsNode}
          data-key={selected?.kind === "node" ? "L" : undefined}
        >
          <Icon name="lens" size={15} />
          <span className="lbl">{t.map.lens}</span>
        </button>
        <button
          type="button"
          className="tool tool-time"
          aria-pressed={timeOpen}
          onClick={() => (timeOpen ? closeTime() : openTime())}
          aria-label={t.map.time}
          data-tip={t.map.timeTitle}
        >
          <Icon name="clock" size={15} />
          <span className="lbl">{t.map.time}</span>
        </button>
        <button
          type="button"
          className="tool tool-ink"
          aria-pressed={inking}
          disabled={!inkShown || !ink.ready}
          onClick={() => setInkTool((tool) => (tool ? null : "select"))}
          aria-label={t.ink.draw}
          data-tip={t.ink.drawTitle}
        >
          <Icon name="pen" size={15} />
          <span className="lbl">{t.ink.draw}</span>
        </button>
        <span className="tool-sep" />
        <button
          type="button"
          className="tool sq"
          disabled={!canvas.canUndo}
          onClick={undo}
          aria-label={t.ink.undo}
          data-tip={t.ink.undo}
          data-key="Ctrl Z"
        >
          <Icon name="undo" size={15} />
        </button>
        <button
          type="button"
          className="tool sq"
          disabled={!canvas.canRedo}
          onClick={redo}
          aria-label={t.ink.redo}
          data-tip={t.ink.redo}
          data-key="Ctrl Shift Z"
        >
          <Icon name="redo" size={15} />
        </button>
        <span className="tool-sep" />
        <button
          type="button"
          className="tool sq zoom-step"
          onClick={() => void flow.zoomOut({ duration: 200 })}
          aria-label={t.map.zoomOut}
          data-tip={t.map.zoomOut}
        >
          <Icon name="minus" size={15} />
        </button>
        <ZoomValue onReset={() => void flow.zoomTo(1, { duration: 250 })} />
        <button
          type="button"
          className="tool sq zoom-step"
          onClick={() => void flow.zoomIn({ duration: 200 })}
          aria-label={t.map.zoomIn}
          data-tip={t.map.zoomIn}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button"
          className="tool sq"
          onClick={() => overview()}
          aria-label={t.map.fit}
          data-tip={t.map.fit}
        >
          <Icon name="fit" size={15} />
        </button>
        <span className="tool-sep" />
        <button
          type="button"
          className="tool sq"
          aria-expanded={keyOpen}
          onClick={() => setKeyOpen((o) => !o)}
          aria-label={t.map.legend}
          data-tip={keyOpen ? undefined : t.map.legend}
          data-tip-end=""
        >
          <Icon name="help" size={15} />
        </button>
        {keyOpen && <MapKey graph={graph} />}
        <FarFace box={box} />
      </div>
    </div>
  );
}

/**
 * How far out the map is, past FAR, marked on the map for the card face to follow. Marked rather than
 * rendered, so crossing a step restyles the cards once and redraws neither them nor the map.
 */
function FarFace({ box }: { box: RefObject<HTMLDivElement | null> }) {
  const far = useStore((s) => FAR.filter((z) => s.transform[2] < z).length);
  useEffect(() => {
    if (!box.current) return;
    if (far) box.current.dataset.far = String(far);
    else delete box.current.dataset.far;
  }, [box, far]);
  return null;
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
function MapKey({ graph }: { graph: Graph }) {
  const role = graph.snapshot.roles[0]?.id ?? "role";
  return (
    <dl className="panel mapkey">
      <div>
        <dt>
          <i className="key-dot" />
        </dt>
        <dd>{t.map.keyRecent}</dd>
      </div>
      <div>
        <dt>
          <span className="mcard-face">
            <Pet id={role} size={16} />
          </span>
        </dt>
        <dd>{t.map.keyRole}</dd>
      </div>
      <div>
        <dt>
          <span className="mcard-face is-waiting">
            <Pet id={role} size={16} />
            <i className="face-env">
              <Icon name="mail" size={8} />
            </i>
          </span>
        </dt>
        <dd>{t.map.keyWaiting}</dd>
      </div>
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
