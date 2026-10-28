import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, describe, type KnownWorkspace } from "../data/api.js";
import { primaryOf, type Graph } from "../data/store.js";
import type { SnapshotNode, SnapshotRef } from "../data/types.js";
import { isDraft } from "../data/drafts.js";
import { hasUnsavedNodeDrafts } from "../data/node-drafts.js";
import { FileMark, Icon, TypeGlyph, TypeTile } from "../components/Glyph.js";
import { Tray, Pet } from "../components/Pet.js";
import { t, type Lang } from "../i18n.js";
import { ago, pathTail, when } from "../util.js";
import { beginDrag, useDragState } from "./drag.js";
import { carried, PUBLIC, sourceIds, type Work } from "./work.js";
import { ContextMenu, useNodeActions } from "../panel/Manage.js";
import { useWantDetails } from "../data/details.js";
import {
  TREE_ROW_HEIGHT,
  treeKeyTarget,
  treeRows,
  treeScrollTop,
  treeWindow,
} from "./tree-window.js";

export type ThemePref = "light" | "dark" | "system";

type Props = {
  graph: Graph;
  selected: SnapshotRef | null;
  open: boolean;
  /** Folded Nodes in the tree; the map folds on its own. */
  collapsed: ReadonlySet<string>;
  work: Work;
  /** The open draft is on the page, so its lane shows it folded. */
  draftOnPage: boolean;
  themePref: ThemePref;
  lang: Lang;
  onTheme: (pref: ThemePref) => void;
  onLang: (lang: Lang) => void;
  /** Fold (`expand` false), unfold (true) or flip a Node; `deep` takes every Node under it along. */
  onFold: (id: string, expand?: boolean, deep?: boolean) => void;
  onOpen: (ref: SnapshotRef) => void;
  /** Open a Role or Card as a page. */
  onPage: (ref: SnapshotRef) => void;
  onLocate: (ref: SnapshotRef) => void;
  onSearch: () => void;
  onToggle: () => void;
  /** Drag on the sidebar's edge: resize, or pull past the end to fold to the rail and back. */
  onResize: (e: React.PointerEvent) => void;
  onResetWidth: () => void;
  onMarkAllSeen: () => void;
  /** The robot the pointer rests on in the dock; the tree marks what its Cards carry. */
  hotLane: string | null;
  /** The robot clicked to keep it lit; the tree's top line offers to let it go. */
  pinnedLane: string | null;
  onUnpin: () => void;
  /** A page covers the map: the row preview stays shut. */
  reading: boolean;
  onToast: (text: string) => void;
};

/** How long a pointer rests on a row before its preview opens. */
const PEEK_DELAY = 650;

/**
 * Left column, on the window frame: the Node tree (目录). The Roles and the Cards on their way sit on the
 * map instead, as the robot dock (Dock.tsx); Nodes are dragged from here onto them.
 */
export function Sidebar(props: Props) {
  const { graph, open, work, onSearch, onToggle } = props;
  const drag = useDragState();
  const { hotLane } = props;
  const [peek, setPeek] = useState<{ id: string; top: number } | null>(null);
  useEffect(() => {
    if (drag || props.reading) setPeek(null);
  }, [!!drag, props.reading]);
  const edge = (label: string) => (
    <div
      className="side-resize"
      onPointerDown={props.onResize}
      onDoubleClick={props.onResetWidth}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
    />
  );
  const settings = (
    <Settings
      themePref={props.themePref}
      lang={props.lang}
      onTheme={props.onTheme}
      onLang={props.onLang}
    />
  );
  if (!open) {
    return (
      <nav className={`sidebar is-rail${drag ? " is-dragging" : ""}`} aria-label={t.side.nav}>
        <button
          type="button"
          className="icon-btn rail-open"
          onClick={onToggle}
          aria-label={t.side.expand}
          data-tip={t.side.expand}
          data-key={"Ctrl \\"}
        >
          <Icon name="sidebar" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onSearch}
          aria-label={t.side.search}
          data-tip={t.side.search}
          data-key="Ctrl K"
        >
          <Icon name="search" size={16} />
        </button>
        <span className="rail-fill" />
        {settings}
        {edge(t.app.openSide)}
      </nav>
    );
  }

  const latest = graph.snapshot.commits[0];
  return (
    <nav className={`sidebar${drag ? " is-dragging" : ""}`} aria-label={t.side.nav}>
      <div className="side-head">
        <Workspaces name={graph.snapshot.workspace.name} />
        <button
          type="button"
          className="icon-btn"
          onClick={onSearch}
          aria-label={t.side.search}
          data-tip={t.side.search}
          data-key="Ctrl K"
        >
          <Icon name="search" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-label={t.side.collapse}
          data-tip={t.side.collapse}
          data-key={"Ctrl \\"}
        >
          <Icon name="sidebar" size={16} />
        </button>
      </div>

      {graph.snapshot.nodes.length ? (
        <Tree {...props} hotLane={hotLane} onPeek={setPeek} peeking={peek?.id ?? null} />
      ) : (
        <p className="side-empty">{t.side.noNodes}</p>
      )}

      <div className="side-foot">
        {settings}
        {latest && (
          <span className="muted" title={latest.hash}>
            {t.side.lastCommit(when(latest.date))}
          </span>
        )}
      </div>
      {peek && !drag && !props.reading && (
        <Peek graph={graph} work={work} id={peek.id} top={peek.top} />
      )}
      {edge(t.app.resizeSide)}
    </nav>
  );
}

/** The Node tree. Marks at the end of a row tie it to the draft being written, the open Card or a Role. */
function Tree({
  graph,
  selected,
  collapsed,
  work,
  hotLane,
  pinnedLane,
  peeking,
  onPeek,
  onFold,
  onOpen,
  onLocate,
  onMarkAllSeen,
  onUnpin,
  onToast,
}: Props & {
  hotLane: string | null;
  peeking: string | null;
  onPeek: (p: { id: string; top: number } | null) => void;
}) {
  const drag = useDragState();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // The row a right click opened a menu on; its dialogs stay after the menu closes.
  const [acting, setActing] = useState<{ id: string; at: { x: number; y: number } | null } | null>(
    null,
  );
  // Rows whose names hold the filter, with the Nodes they hang from opened to show them.
  const [filter, setFilter] = useState<string | null>(null);
  const q = filter?.trim().toLowerCase() ?? "";
  const shown = useMemo(() => {
    if (!q) return null;
    const matches = new Set<string>();
    for (const n of graph.snapshot.nodes)
      if (n.name.toLowerCase().includes(q)) {
        matches.add(n.id);
        for (const a of graph.ancestors(n.id)) matches.add(a.id);
      }
    return matches;
  }, [graph, q]);
  const outline = useMemo(() => treeRows(graph, collapsed, shown), [graph, collapsed, shown]);
  const rowIndex = useMemo(() => new Map(outline.map((r, i) => [r.node.id, i])), [outline]);
  const scroller = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);
  const pendingReveal = useRef<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const readViewport = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const top = box.scrollTop;
    const height = box.clientHeight;
    setViewport((v) => (v.top === top && v.height === height ? v : { top, height }));
  }, []);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    readViewport();
    const observer = new ResizeObserver(readViewport);
    observer.observe(box);
    return () => observer.disconnect();
  }, [readViewport]);
  const reveal = (index: number) => {
    const box = scroller.current;
    if (!box) return;
    box.scrollTop = treeScrollTop(index, box.scrollTop, box.clientHeight);
    readViewport();
  };
  const focusRow = (id: string | undefined) => {
    if (id === undefined) return;
    const index = rowIndex.get(id);
    if (index === undefined) return;
    pendingFocus.current = id;
    setFocused(id);
    reveal(index);
    const element = elements.current.get(id);
    if (element) {
      element.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  };
  // App opens a selected Node's ancestors. Keep the reveal pending until that outline arrives;
  // selection scrolls the tree without taking focus away from the map, search or page.
  useLayoutEffect(() => {
    pendingReveal.current = selected?.kind === "node" ? selected.id : null;
  }, [selected?.kind, selected?.id, graph.snapshot.workspace.id]);
  useLayoutEffect(() => {
    if (pendingReveal.current !== null) {
      const index = rowIndex.get(pendingReveal.current);
      if (index !== undefined) {
        reveal(index);
        pendingReveal.current = null;
      }
    }
    if (pendingFocus.current !== null) {
      const element = elements.current.get(pendingFocus.current);
      if (element) {
        element.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    }
  });
  const mounted = treeWindow(
    outline.length,
    viewport.top,
    viewport.height,
    focused === null ? -1 : (rowIndex.get(focused) ?? -1),
  );
  const openCard = work.openDraft ? graph.cards.get(work.openDraft) : undefined;
  const inDraft = work.openDraft ? sourceIds(graph, openCard, work.draft) : [];
  // The published Card on the page: its sources in order, and which changed after it was sent.
  const card =
    selected?.kind === "card" &&
    graph.cards.get(selected.id) &&
    !isDraft(graph.cards.get(selected.id)!)
      ? graph.cards.get(selected.id)!
      : undefined;
  const refs = new Map(
    (card?.sources ?? []).flatMap((s, i) =>
      s.id ? [[s.id, { n: i + 1, changed: s.changedSince }]] : [],
    ),
  );
  // Hovering a lane: the Nodes its Cards carried (the Role's received Cards included).
  const used = hotLane === null ? null : carried(graph, work.laneOf, hotLane);
  const path = new Set(
    selected?.kind === "node"
      ? [...graph.ancestors(selected.id).map((a) => a.id), selected.id]
      : [],
  );
  const fresh = graph.snapshot.nodes.filter((n) => graph.states.get(n.id)?.recent).length;
  const hides = (n: SnapshotNode, set: Set<string>): boolean =>
    graph.childrenOf(n.id).some((k) => set.has(k.id) || hides(k, set));

  /**
   * The usual tree keys: up, down, Home and End move; right opens a row or steps into it, left closes it or
   * steps up to its parent; * opens the row and its siblings; Enter opens the Node.
   */
  const onRowKey = (
    e: React.KeyboardEvent<HTMLElement>,
    n: SnapshotNode,
    parent: string | null,
    open: boolean | null,
  ) => {
    const at = rowIndex.get(n.id)!;
    const go = (key: string) => focusRow(treeKeyTarget(outline, at, key));
    const keys: Record<string, () => void> = {
      ArrowDown: () => go("ArrowDown"),
      ArrowUp: () => go("ArrowUp"),
      Home: () => go("Home"),
      End: () => go("End"),
      ArrowRight: () => (open === false ? onFold(n.id, true) : open && go("ArrowRight")),
      ArrowLeft: () => (open ? onFold(n.id, false) : go("ArrowLeft")),
      "*": () =>
        graph
          .childrenOf(parent)
          .filter((k) => graph.childrenOf(k.id).length)
          .forEach((k) => onFold(k.id, true)),
      Enter: () => onOpen({ kind: "node", id: n.id }),
    };
    if (!keys[e.key] || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    keys[e.key]();
  };

  const rows = mounted.map((index) => {
    const { node: n, depth, parent, folded, children, position, siblings } = outline[index]!;
    const state = graph.states.get(n.id)!;
    const at = inDraft.indexOf(n.id);
    const ref = refs.get(n.id);
    const marks: ReactNode[] = [];
    if (at >= 0)
      marks.push(
        <span key="draft" className="num" title={t.side.draftSource(at + 1)}>
          {at + 1}
        </span>,
      );
    if (ref) {
      if (ref.changed)
        marks.push(
          <span key="changed" className="changed" title={t.side.changedSince}>
            <Icon name="clock" size={12} />
            {t.side.changed}
          </span>,
        );
      marks.push(
        <span key="ref" className="num ref" title={t.side.cardSource(ref.n)}>
          {ref.n}
        </span>,
      );
    }
    const carries = used?.has(n.id);
    const inside = !!used && !carries && folded && hides(n, used);
    if (hotLane && (carries || inside))
      marks.push(
        hotLane === PUBLIC ? (
          <Tray key="face" size={14} />
        ) : (
          <Pet key="face" id={hotLane} size={14} className={inside ? "faint" : undefined} />
        ),
      );
    const active = selected?.kind === "node" && selected.id === n.id;
    const lifted = drag?.item.kind === "node" && drag.item.id === n.id;
    // Where a Node dragged here would land: just above this row, inside it, or just below.
    const landing = drag?.over?.startsWith(`tree:${n.id}:`)
      ? drag.over.slice(n.id.length + 6)
      : null;
    const cls = [
      "row",
      depth ? "" : "is-top",
      active ? "is-active" : path.has(n.id) ? "is-trail" : "",
      state.deprecated ? "is-deprecated" : "",
      used && !carries && !inside ? "is-dim" : "",
      lifted ? "is-lifted" : "",
      peeking === n.id ? "is-peek" : "",
      landing ? `is-drop-${landing}` : "",
      shown && n.name.toLowerCase().includes(q) ? "is-match" : "",
      acting?.id === n.id && acting.at ? "is-menu" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        key={n.id}
        ref={(el) => {
          if (el) elements.current.set(n.id, el);
          else elements.current.delete(n.id);
        }}
        className={cls}
        style={
          {
            "--d": depth,
            position: "absolute",
            top: index * TREE_ROW_HEIGHT,
            width: "100%",
          } as React.CSSProperties
        }
        role="treeitem"
        tabIndex={0}
        aria-selected={active}
        aria-expanded={children ? !folded : undefined}
        aria-level={depth + 1}
        aria-posinset={position}
        aria-setsize={siblings}
        data-id={n.id}
        data-drop={`tree:${n.id}`}
        data-drop-label={n.name}
        data-drop-zones=""
        onClick={() => onOpen({ kind: "node", id: n.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          clearTimeout(timer.current);
          onPeek(null);
          setActing({ id: n.id, at: { x: e.clientX, y: e.clientY } });
        }}
        onKeyDown={(e) => {
          // The menu key, or Shift+F10, opens the row's menu where the row is.
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            return setActing({ id: n.id, at: { x: r.left + 24, y: r.bottom } });
          }
          onRowKey(e, n, parent, children ? !folded : null);
        }}
        onPointerDown={(e) => beginDrag(e, { kind: "node", id: n.id })}
        onPointerEnter={(e) => {
          clearTimeout(timer.current);
          const top = e.currentTarget.getBoundingClientRect().top;
          timer.current = setTimeout(() => onPeek({ id: n.id, top }), PEEK_DELAY);
        }}
        onPointerLeave={() => {
          clearTimeout(timer.current);
          onPeek(null);
        }}
      >
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="guide" style={{ left: 14.5 + i * 14 }} />
        ))}
        {children > 0 && (
          <button
            type="button"
            className="chev"
            aria-label={t.side.fold(n.name)}
            onClick={(e) => {
              e.stopPropagation();
              onFold(n.id, undefined, e.altKey);
            }}
          >
            <Icon name="chevron" size={13} />
          </button>
        )}
        <span className="row-type">
          <TypeGlyph type={n.type} size={12} />
        </span>
        <span className="t">{n.name}</span>
        {state.deprecated && <span className="row-mark">{t.map.status.archived}</span>}
        <FileMark node={n} size={12} />
        {state.recent && !marks.length && !active && (
          <i className="new-dot" title={t.node.recent} />
        )}
        {folded && !marks.length && <span className="more">{descendants(graph, n.id)}</span>}
        {marks.length > 0 && <span className="marks">{marks}</span>}
        <span className="acts">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLocate({ kind: "node", id: n.id });
            }}
            aria-label={t.side.locate}
            data-tip={t.side.locate}
            data-tip-end=""
          >
            <Icon name="locate" size={14} />
          </button>
          <button
            type="button"
            className={at >= 0 ? "is-in" : ""}
            disabled={!!work.openDraft && work.publishing === work.openDraft}
            onClick={(e) => {
              e.stopPropagation();
              work.attach(n.id);
            }}
            aria-label={at >= 0 ? t.side.inDraft : t.side.attach}
            data-tip={at >= 0 ? t.side.inDraft : t.side.attach}
            data-tip-end=""
          >
            <Icon name={at >= 0 ? "check" : "addToCard"} size={14} />
          </button>
        </span>
      </div>
    );
  });

  const context = card
    ? t.side.cardSources(refs.size)
    : hotLane !== null
      ? t.side.carriedBy(work.laneName(hotLane))
      : null;
  const roots = graph.childrenOf(null);
  const tools = (
    <span className="tree-tools">
      <button
        type="button"
        className={filter !== null ? "is-on" : ""}
        aria-pressed={filter !== null}
        aria-label={t.side.filter}
        data-tip={t.side.filter}
        onClick={() => setFilter((f) => (f === null ? "" : null))}
      >
        <Icon name="search" size={13} />
      </button>
      <button
        type="button"
        aria-label={t.side.foldAll}
        data-tip={t.side.foldAll}
        onClick={() => roots.forEach((r) => onFold(r.id, false, true))}
      >
        <Icon name="shrink" size={13} />
      </button>
      <button
        type="button"
        aria-label={t.side.openAll}
        data-tip={t.side.openAll}
        data-tip-end=""
        onClick={() => roots.forEach((r) => onFold(r.id, true, true))}
      >
        <Icon name="expand" size={13} />
      </button>
    </span>
  );
  return (
    <div className="tree" role="tree" aria-label={t.side.tree}>
      <div className="tree-label">
        {t.side.tree}
        {context ? (
          <span className="ctx">
            {card && <Icon name="mail" size={12} />}
            <span className="ctx-text">{context}</span>
            {!card && pinnedLane !== null && hotLane === pinnedLane && (
              <button
                type="button"
                className="ctx-x"
                onClick={onUnpin}
                aria-label={t.side.unpin}
                title={t.side.unpin}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </span>
        ) : (
          fresh > 0 && (
            <button
              type="button"
              className="ctx fresh"
              onClick={onMarkAllSeen}
              title={t.side.freshTitle(fresh)}
            >
              <i className="new-dot" />
              {fresh} {t.side.markAllRead}
            </button>
          )
        )}
        {!context && tools}
      </div>
      {filter !== null && (
        <input
          className="tree-filter"
          autoFocus
          value={filter}
          placeholder={t.side.filterHint}
          aria-label={t.side.filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setFilter(null);
            }
          }}
        />
      )}
      <div
        className="tree-rows"
        ref={scroller}
        onScroll={() => {
          clearTimeout(timer.current);
          onPeek(null);
          readViewport();
        }}
        onFocusCapture={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
          if (row) setFocused(row.dataset.id ?? null);
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
        }}
      >
        <div style={{ position: "relative", height: outline.length * TREE_ROW_HEIGHT }}>{rows}</div>
        {shown && !shown.size && <p className="tree-none">{t.side.filterNone}</p>}
      </div>
      {acting && graph.nodes.get(acting.id) && (
        <TreeMenu
          key={acting.id}
          graph={graph}
          node={graph.nodes.get(acting.id)!}
          at={acting.at}
          onClose={() => setActing((a) => (a ? { ...a, at: null } : a))}
          onToast={onToast}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

/** A row's right-click menu and the dialogs it opens. */
function TreeMenu({
  graph,
  node,
  at,
  onClose,
  onToast,
  onOpen,
}: {
  graph: Graph;
  node: SnapshotNode;
  at: { x: number; y: number } | null;
  onClose: () => void;
  onToast: (text: string) => void;
  onOpen: (ref: SnapshotRef) => void;
}) {
  // Deleting counts what it breaks, which comes with the snapshot: ask for it while the menu is open.
  useWantDetails(!!at && !graph.detailed);
  const { items, dialogs } = useNodeActions({
    graph,
    node,
    onGone: () => {},
    onToast,
    onMade: (id) => onOpen({ kind: "node", id }),
    tree: true,
  });
  const close = useCallback(onClose, [onClose]);
  return (
    <>
      {at && <ContextMenu at={at} items={items} onClose={close} />}
      {dialogs}
    </>
  );
}

function descendants(graph: Graph, id: string): number {
  return graph.childrenOf(id).reduce((sum, k) => sum + 1 + descendants(graph, k.id), 0);
}

/** A Node's preview beside the sidebar after a short rest on its row. */
function Peek({ graph, work, id, top }: { graph: Graph; work: Work; id: string; top: number }) {
  const n = graph.nodes.get(id);
  const box = useRef<HTMLDivElement>(null);
  const [y, setY] = useState(top - 12);
  useEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    setY(Math.max(8, Math.min(top - 12, window.innerHeight - h - 8)));
  }, [id, top]);
  if (!n) return null;
  const latest = n.history[0] ? graph.commits.get(n.history[0]) : undefined;
  const cards = graph.snapshot.cards.filter(
    (c) => !isDraft(c) && c.sources.some((s) => s.id === n.id),
  );
  const holders = [...new Set(cards.map(work.laneOf).filter((l) => l !== PUBLIC))];
  const primary = primaryOf(n.type);
  return (
    <div className="peek" ref={box} style={{ top: y }} role="tooltip">
      <div className="peek-head">
        <TypeTile kind={n.type} size={30} />
        <div>
          <div className="peek-name">{n.name}</div>
          <div className="peek-type">
            <b className={`p-${primary}`}>{primary}</b>
            {n.tags.length > 0 && ` · ${n.tags.join(", ")}`}
          </div>
        </div>
      </div>
      {n.description && <p>{n.description}</p>}
      <div className="peek-meta">
        {latest && (
          <span>
            <Icon name="clock" size={13} />
            {t.side.versions(n.history.length, ago(latest.date))}
          </span>
        )}
        {cards.length > 0 && (
          <span>
            <Icon name="mail" size={13} />
            {t.side.carried(cards.length)}
            {holders.map((r) => (
              <Pet key={r} id={r} size={14} />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/** The workspace name at the top: it lists the workspaces opened on this computer and opens others. */
function Workspaces({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<KnownWorkspace[] | null>(null);
  const [typing, setTyping] = useState(false);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ url: string; port: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setTyping(false);
    setFolder("");
    setProblem(null);
    setTaken(null);
    let live = true;
    api.workspaces().then(
      (r) => live && setList(r.workspaces),
      (error) => live && setProblem(describe(error)),
    );
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      live = false;
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const visit = async (url: string) => {
    setBusy(url);
    setProblem(null);
    try {
      if (hasUnsavedNodeDrafts()) throw new Error(t.side.unsavedNodes);
      location.assign(url);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(null);
    }
  };

  // The other workspace has its own address and token; save pending Cards before leaving.
  const go = async (target: string) => {
    setBusy(target);
    setProblem(null);
    setTaken(null);
    try {
      const { url, portTaken } = await api.openWorkspace(target);
      if (portTaken === undefined) return await visit(url);
      setTaken({ url, port: portTaken });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      setProblem(
        code === "NOT_A_WORKSPACE"
          ? t.side.notWorkspace
          : code === "INVALID_INPUT"
            ? t.side.fullPath
            : describe(error),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ws-switch" ref={box}>
      <button
        type="button"
        className="side-ws"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tip={open ? undefined : t.side.workspaces}
      >
        <span>{name}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="ws-pop" role="dialog" aria-label={t.side.workspaces}>
          {list?.map((w) => (
            <button
              key={w.root}
              type="button"
              className={`ws-item${w.current ? " is-current" : ""}`}
              onClick={() => (w.current ? setOpen(false) : void go(w.root))}
              disabled={busy !== null}
              title={w.root}
            >
              <span className="ws-text">
                <b>{w.name}</b>
                <span>{busy === w.root ? t.side.opening : pathTail(w.root)}</span>
              </span>
              {w.current && <Icon name="check" size={15} />}
            </button>
          ))}
          {list && <div className="ws-sep" />}
          {typing ? (
            <form
              className="ws-path"
              onSubmit={(e) => {
                e.preventDefault();
                if (folder.trim()) void go(folder.trim());
              }}
            >
              <Icon name="folder" size={15} />
              <input
                autoFocus
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={busy ? t.side.opening : t.side.folderPath}
                aria-label={t.side.folderPath}
                spellCheck={false}
                disabled={busy !== null}
              />
            </form>
          ) : (
            <button type="button" className="ws-item ws-open" onClick={() => setTyping(true)}>
              <Icon name="folder" size={15} />
              <span>{t.side.openFolder}</span>
            </button>
          )}
          {problem && <p className="ws-problem">{problem}</p>}
          {taken && (
            <div className="ws-taken">
              <p>{t.side.portBusy(taken.port)}</p>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void visit(taken.url)}
              >
                {t.side.openAnyway}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The gear at the foot: appearance and language. */
function Settings({
  themePref,
  lang,
  onTheme,
  onLang,
}: {
  themePref: ThemePref;
  lang: Lang;
  onTheme: (pref: ThemePref) => void;
  onLang: (lang: Lang) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const choice = <T extends string>(value: T, current: T, label: string, pick: (v: T) => void) => (
    <button type="button" role="radio" aria-checked={value === current} onClick={() => pick(value)}>
      {label}
    </button>
  );
  return (
    <div className="settings" ref={box}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.side.settings}
        aria-expanded={open}
        data-tip={open ? undefined : t.side.settings}
      >
        <Icon name="settings" size={16} />
      </button>
      {open && (
        <div className="settings-pop" role="dialog" aria-label={t.side.settings}>
          <div className="settings-row">
            <span>{t.side.appearance}</span>
            <div className="seg" role="radiogroup" aria-label={t.side.appearance}>
              {choice("system", themePref, t.side.system, onTheme)}
              {choice("light", themePref, t.side.light, onTheme)}
              {choice("dark", themePref, t.side.dark, onTheme)}
            </div>
          </div>
          <div className="settings-row">
            <span>{t.side.language}</span>
            <div className="seg" role="radiogroup" aria-label={t.side.language}>
              {choice<Lang>("zh", lang, "中文", onLang)}
              {choice<Lang>("en", lang, "English", onLang)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
