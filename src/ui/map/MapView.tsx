import { aheadKind, onlyGaps } from "../data/reasons.js";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { primaryOf, suffixOf, type Graph, type Hand, type Primary } from "../data/store.js";
import type { SnapshotCommit, SnapshotRef, SyncFlag, SyncFlags } from "../data/types.js";
import { isDraft } from "../data/drafts.js";
import { Icon, TypeGlyph, TypeTile } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { CARD, GAP, lensLayout, rectOf, treeLayout, type Layout, type Rect } from "./layout.js";
import { PUBLIC } from "../shell/work.js";
import { nearest, refPath } from "./geometry.js";
import { routeLinks, type Route } from "./route.js";
import { Timeline } from "./Timeline.js";
import { ago, readStored, when, writeStored } from "../util.js";
import { t } from "../i18n.js";
const ZOOM = { min: 0.25, max: 2 };
// Below this, card names get too small to read at a glance; views the map picks by itself stay above it.
const READABLE = 0.9;
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
  dim: boolean;
  selected: boolean;
  top: boolean;
  folded: number;
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
type Peek = { id: string; left: number; top: number; above: boolean };

/** Card controls that act without selecting the card. */
type Actions = {
  activeRole: string | null;
  onRole: (id: string) => void;
  onFold: (id: string) => void;
};
const MapActions = createContext<Actions>({ activeRole: null, onRole: () => {}, onFold: () => {} });
/** Ahead and behind Nodes; every other card stays quiet. */
const MapFlags = createContext<SyncFlags>({});

const descendants = (graph: Graph, id: string): number =>
  graph.childrenOf(id).reduce((sum, c) => sum + 1 + descendants(graph, c.id), 0);
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
  const { onFold } = useContext(MapActions);
  const flag = useContext(MapFlags)[data.id];
  const n = data.graph.nodes.get(data.id)!;
  const state = data.graph.states.get(data.id)!;
  const hands = data.graph.handedTo(data.id);
  const p = primaryOf(n.type);
  return (
    <div
      className={`mcard t-${p}${data.top ? " is-top" : ""}${data.dim ? " is-dim" : ""}${data.selected ? " is-selected" : ""}${data.touched ? " is-touched" : ""}${state.deprecated ? " is-deprecated" : ""}${flag?.ahead ? " is-ahead" : ""}${flag?.behind ? ` is-behind${onlyGaps(flag.behind.reasons) ? " is-gap" : ""}` : ""}`}
      style={{ width: CARD.w, height: data.h }}
    >
      <Handles />
      {data.pin > 0 && (
        <span className="mcard-pin" title={t.side.draftSource(data.pin)}>
          {data.pin}
        </span>
      )}
      <TypeTile kind={n.type} size={data.top ? 26 : 22} />
      <span className="mcard-name">{n.name}</span>
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
      {suffixOf(n.type) && <span className="mcard-tag">{suffixOf(n.type)}</span>}
      {hands.length > 0 && <Faces graph={data.graph} hands={hands} />}
      {n.childIds.length > 0 && (
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
          {data.folded || <Icon name="minus" size={10} />}
        </button>
      )}
    </div>
  );
});

/**
 * The lanes a Node went to in published Cards, up to three faces: a Role, or the public area. One still
 * waiting to be received has a blue ring and an envelope, amber when that Card pinned an older version;
 * one received but without outputs for all its goals has a grey ellipsis. Finished lanes stay quiet, and
 * the tooltip counts the goals. A Role's face selects the Role.
 */
function Faces({ graph, hands }: { graph: Graph; hands: Hand[] }) {
  const { activeRole, onRole } = useContext(MapActions);
  return (
    <span className="mcard-faces">
      {hands.slice(0, 3).map((h) => {
        const role = h.lane === PUBLIC ? undefined : graph.roles.get(h.lane);
        const tip = t.map.handed(
          role?.title ?? (h.lane === PUBLIC ? null : h.lane),
          h.cards,
          h.waiting,
          h.old,
          h.outputs,
          h.reviews,
          h.goalCount,
          h.totalGoalCount,
        );
        const cls = `mcard-face${h.old ? " is-old" : h.waiting ? " is-waiting" : ""}${activeRole !== null && activeRole === h.lane ? " is-active" : ""}`;
        const face =
          h.lane === PUBLIC ? (
            <span className="pub-face">
              <Icon name="public" size={10} />
            </span>
          ) : (
            <Pet id={h.lane} size={16} />
          );
        const badge = h.waiting
          ? "mail"
          : h.reviews
            ? "review"
            : h.goalCount < h.totalGoalCount
              ? "working"
              : null;
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
      {hands.length > 3 && <span className="mcard-more">+{hands.length - 3}</span>}
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
 * How many Nodes are behind or ahead, in the top corner of the map; a Node that is both counts in each.
 * Each count steps through its Nodes in tree order; nothing shows while no Node needs attention.
 */
function FlagCounts({
  graph,
  flags,
  onSelect,
}: {
  graph: Graph;
  flags: SyncFlags;
  onSelect: (ref: SnapshotRef) => void;
}) {
  const step = useRef<Record<keyof SyncFlag, number>>({ behind: 0, ahead: 0 });
  const order = useMemo(() => {
    const out: string[] = [];
    const walk = (parentId: string | null) => {
      for (const n of graph.childrenOf(parentId)) {
        out.push(n.id);
        walk(n.id);
      }
    };
    walk(null);
    return out;
  }, [graph]);
  const kinds = (["behind", "ahead"] as const)
    .map((state) => [state, order.filter((id) => flags[id]?.[state])] as const)
    .filter(([, ids]) => ids.length > 0);
  if (!kinds.length) return null;
  return (
    <div className="panel map-flags" role="group" aria-label={t.map.flagsLabel}>
      {kinds.map(([state, ids]) => (
        <button
          key={state}
          type="button"
          className={`map-flag is-${state}`}
          data-tip={t.map.flagStep}
          onClick={() => {
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

const nodeTypes = { node: NodeCard, label: LensLabel };
const edgeTypes = { link: LinkEdge };
const KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Filters = { types: Record<Primary, boolean>; allRefs: boolean };

type MapProps = {
  graph: Graph;
  /** Ahead and behind Nodes from the real workspace; empty when the service cannot say. */
  flags: SyncFlags;
  selected: SnapshotRef | null;
  collapsed: ReadonlySet<string>;
  /** The draft being written: its sources in order (null for an address outside Tent). */
  draft: (string | null)[];
  /** The lane the pointer rests on in 分工, and the Nodes a lane's Cards carried. */
  hotLane: string | null;
  carriedBy: (lane: string) => ReadonlySet<string>;
  /** Whether arrow keys, Enter and Space drive the map right now. */
  keys: boolean;
  onSelect: (ref: SnapshotRef | null) => void;
  onFold: (id: string, expand?: boolean) => void;
  onExpand: () => void;
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
  keys,
  onSelect,
  onFold,
  onExpand,
}: MapProps) {
  const [filters, setFilters] = useState<Filters>(() => {
    const stored = readStored<Partial<Filters>>("tent-map-filters-v2", {});
    return {
      types: { goal: true, prompt: true, output: true, ...stored.types },
      allRefs: !!stored.allRefs,
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

  // Semantic zoom: the level switches card detail; --z lets names stay readable as the map shrinks.
  const zoomLevel = useStore((s) =>
    s.transform[2] < 0.36 ? "far" : s.transform[2] < 0.62 ? "compact" : "near",
  );
  const trackZoom = (zoom: number) => box.current?.style.setProperty("--z", zoom.toFixed(3));
  useEffect(() => trackZoom(flow.getZoom()), [zoomLevel]);

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

  const visible = useCallback(
    (id: string) => {
      const n = graph.nodes.get(id);
      return !!n && filters.types[primaryOf(n.type)];
    },
    [graph, filters.types],
  );
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
  useEffect(() => {
    if (selected?.kind !== "node") setLens(false);
  }, [selected?.kind]);

  const base = useMemo(() => treeLayout(graph, collapsed), [graph, collapsed]);
  const lensView = useMemo(
    () => (lensId ? lensLayout(graph, lensId, visible) : null),
    [graph, lensId, visible],
  );
  const view = lensView ?? base;

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [];
    for (const id of new Set([...base.placed.keys(), ...view.placed.keys()])) {
      if (!visible(id)) continue;
      const at = view.placed.get(id) ?? base.placed.get(id)!;
      const n = graph.nodes.get(id)!;
      out.push({
        // Top-left position computed here: an origin offset would wait for measurement and move the card twice.
        id,
        type: "node",
        position: { x: at.x, y: at.y - at.h / 2 },
        draggable: false,
        // Cards outside the lens, or not yet written at the chosen time, keep their place invisibly.
        className: view.placed.has(id) && exists(id) ? undefined : "is-away",
        data: {
          graph,
          id,
          h: at.h,
          top: !n.parentId,
          selected: selected?.id === id,
          touched: touched.has(id),
          dim: !lensView && !!lit && id !== focus && !lit.has(id),
          folded: collapsed.has(id) ? descendants(graph, id) : 0,
          pin: pins.get(id) ?? 0,
          src: sources?.order?.get(id) ?? null,
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
    visible,
    exists,
    touched,
    focus,
    lit,
    selected?.id,
    collapsed,
    pins,
    sources,
  ]);

  const routed = useRef<{ view: typeof view; key: string; routes: Map<string, Route> } | null>(
    null,
  );
  const edges = useMemo<Edge<LinkData>[]>(() => {
    const out: Edge<LinkData>[] = [];
    const seen = new Set<string>();
    const add = (source: string, target: string, kind: LinkData["kind"]) => {
      const key = `${source}>${target}`;
      const a = view.placed.get(source),
        b = view.placed.get(target);
      if (
        source === target ||
        seen.has(key) ||
        !a ||
        !b ||
        !visible(source) ||
        !visible(target) ||
        !exists(source) ||
        !exists(target)
      )
        return;
      // The lens shows only the focused Node's own lines.
      if (lensId && source !== lensId && target !== lensId) return;
      const hot = !!lensId || [focus, hover].some((id) => id && (source === id || target === id));
      // References stay out of the way until a card is selected or hovered, unless asked for.
      if (kind === "ref" && !hot && !filters.allRefs) return;
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
    for (const n of graph.snapshot.nodes) if (n.parentId) add(n.parentId, n.id, "tree");
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
            loop: (lensId ? e.data!.from.x < 0 : !graph.nodes.get(e.source)?.parentId) ? -1 : 1,
          })),
        ),
      };
    for (const e of refs) e.data!.route = routed.current.routes.get(e.id);
    // Lines that matter now draw last, above the rest.
    return out.sort((x, y) => Number(x.data!.hot) - Number(y.data!.hot));
  }, [graph, view, lensId, visible, exists, filters.allRefs, focus, lit, hover]);

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
    (r: Rect) => {
      const el = box.current;
      if (!el) return true;
      const v = flow.getViewport();
      return (
        r.x * v.zoom + v.x >= 12 &&
        r.y * v.zoom + v.y >= 12 &&
        (r.x + r.w) * v.zoom + v.x <= clearWidth() - 12 &&
        (r.y + r.h) * v.zoom + v.y <= el.clientHeight - PAD.bottom + 24
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
      const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(w / (x2 - x1), h / (y2 - y1))));
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

  /**
   * The view the map opens with: everything, if it fits at a readable size; otherwise that size,
   * starting from the top. The fit button still shows everything.
   */
  const overview = useCallback(
    (motion: { duration: number } = { duration: 400 }) => {
      const el = box.current;
      const rects = viewRects(view);
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
    [flow, view, viewRects, clearWidth],
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
        fitRects(viewRects(lensView), 1.1, GLIDE);
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
        const p = base.placed.get(selected.id);
        const n = graph.nodes.get(selected.id);
        // Bring the card in with what it hangs from and what hangs from it, or at least its parent,
        // centred in the part of the map that no floating panel covers.
        if (p && n && !inView(rectOf(p))) {
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
          const family = rectsOf([n.parentId, selected.id, ...n.childIds]);
          const rects = fits(family) >= 0.7 ? family : rectsOf([n.parentId, selected.id]);
          fitRects(rects, Math.max(flow.getZoom(), READABLE), { duration: 350 });
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
    if (before === base || !ready || lensView || !el) return;
    const v = flow.getViewport();
    if (!anchor || !before.placed.has(anchor) || !base.placed.has(anchor)) {
      const cx = (el.clientWidth / 2 - v.x) / v.zoom,
        cy = (el.clientHeight / 2 - v.y) / v.zoom;
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
    if (!a || !b || (a.x === b.x && a.y === b.y)) return;
    void flow.setViewport(
      { x: v.x - (b.x - a.x) * v.zoom, y: v.y - (b.y - a.y) * v.zoom, zoom: v.zoom },
      GLIDE,
    );
  }, [base]);

  // Cards glide when the layout changes shape; lines wait until they land. The glide must be on in the
  // same render as the new positions, so it is derived rather than set afterwards.
  const shape = `${lensId}|${[...collapsed].sort().join()}`;
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
  const latest = useRef({ view, selected, lensId, collapsed, visible, timeOpen });
  latest.current = { view, selected, lensId, collapsed, visible, timeOpen };
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const { view, selected, lensId, collapsed, visible, timeOpen } = latest.current;
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
      if (
        /INPUT|TEXTAREA|SELECT/.test(el.tagName) ||
        el.isContentEditable ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      // Keys belong to the map only while attention is on it.
      if (!(el === document.body || el.closest(".map, .sidebar"))) return;
      const onControl = !!el.closest("button, a, [role=radio]");
      const node = selected?.kind === "node" ? graph.nodes.get(selected.id) : undefined;
      if (e.key === " " && !onControl) {
        if (node) {
          e.preventDefault();
          setLens((l) => !l);
        }
        return;
      }
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
        const first = graph.childrenOf(null).find((n) => visible(n.id));
        if (first) onSelect({ kind: "node", id: first.id });
        return;
      }
      let next: string | null | undefined;
      if (!lensId && e.key === "ArrowLeft" && node.parentId && visible(node.parentId))
        next = node.parentId;
      if (!lensId && e.key === "ArrowRight") {
        if (collapsed.has(node.id)) {
          foldAnchor.current = node.id;
          onFold(node.id, true);
          return;
        }
        const kids = graph.childrenOf(node.id).flatMap((c) => {
          const p = view.placed.get(c.id);
          return p && visible(c.id) ? [p] : [];
        });
        next = kids.sort((a, b) => Math.abs(a.y - here.y) - Math.abs(b.y - here.y))[0]?.id;
      }
      next ??= nearest(view, here, dir, visible);
      if (next) onSelect({ kind: "node", id: next });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, graph, onSelect, onFold, onExpand]);

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
    }),
    [hotLane, selected, onSelect, onFold],
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
      className={`map zoom-${zoomLevel}${lensView ? " is-lens" : ""}${morphing ? " is-morphing" : ""}${timeOpen ? " is-time" : ""}`}
      ref={box}
    >
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
            panActivationKeyCode={null}
            onInit={() => setReady(true)}
            onMove={(_, v) => {
              trackZoom(v.zoom);
            }}
            onMoveStart={() => setPeek(null)}
            onMoveEnd={countOutside}
            onNodeClick={(_, node) => {
              if (node.type === "node") onSelect({ kind: "node", id: node.id });
            }}
            onNodeMouseEnter={(_, node) => {
              if (node.type === "node") hoverSoon(node.id, 150);
            }}
            onNodeMouseLeave={() => hoverSoon(null, 100)}
            onPaneClick={() => onSelect(null)}
          />
        </MapActions.Provider>
      </MapFlags.Provider>

      {peek && <PeekCard graph={graph} peek={peek} flag={flags[peek.id]} />}
      <FlagCounts graph={graph} flags={flags} onSelect={onSelect} />
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
          className="tool"
          aria-pressed={filters.allRefs}
          onClick={() => setFilters((f) => ({ ...f, allRefs: !f.allRefs }))}
          aria-label={t.map.refs}
          data-tip={t.map.refsTitle}
        >
          <Icon name="refs" size={15} />
          <span className="lbl">{t.map.refs}</span>
        </button>
        <button
          type="button"
          className="tool tool-lens"
          aria-pressed={!!lensId}
          disabled={selected?.kind !== "node"}
          onClick={() => setLens((l) => !l)}
          aria-label={t.map.lens}
          data-tip={selected?.kind === "node" ? t.map.lensTitle : t.map.lensNeedsNode}
          data-key={selected?.kind === "node" ? "Space" : undefined}
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
          onClick={() => fitRects(viewRects(view))}
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
      </div>
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
          <span className="key-line ref" />
        </dt>
        <dd>{t.map.keyRef}</dd>
      </div>
      <div className="mapkey-keys">
        <dt>
          <kbd>←→↑↓</kbd>
        </dt>
        <dd>{t.map.keyKeys}</dd>
      </div>
    </dl>
  );
}
