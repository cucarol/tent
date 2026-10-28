import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { buildGraph, loadMap, mapSnapshot, primaryOf, withMap, type Visits } from "./data/store.js";
import { workspaceRefresh } from "./data/workspace-refresh.js";
import { followChangeHints } from "./data/change-hints.js";
import { NodeDetailsProvider } from "./data/node-details.js";
import type { WorkspaceMap } from "../core/read/workspace-map.js";
import { api, ApiError, changes, describe, openChanges } from "./data/api.js";
import type { Snapshot, SnapshotRef } from "./data/types.js";
import { Icon } from "./components/Glyph.js";
import { Pet } from "./components/Pet.js";
import { Loader } from "./components/Loader.js";
import { Boundary } from "./components/Boundary.js";
import { FirstRun } from "./shell/FirstRun.js";
import { Sidebar, type ThemePref } from "./shell/Sidebar.js";
import { StageBar } from "./shell/StageBar.js";
import { Dock } from "./shell/Dock.js";
import { AGENTS_PAGE, Reader } from "./panel/Reader.js";
import { Palette } from "./panel/Overlays.js";
import { loadLocalDrafts, useDraftCards } from "./data/drafts.js";
import { FilesContext, useFileInfo } from "./data/files.js";
import { carried, sourceIds, useWork, type Work } from "./shell/work.js";
import { HandlingContext, handlingOf } from "./data/handling.js";
import { readCanvas, type CanvasInitial } from "./map/canvas.js";
import type { Graph } from "./data/store.js";
import type { HistoricalSelection } from "./data/history-tree.js";
import { readStored, writeStored } from "./util.js";
import { currentLang, setLang, t, type Lang } from "./i18n.js";

type Overlay = { kind: "palette" } | null;
// Fetch and compile the map while its topology is being read, rather than after that read renders.
const mapView = import("./map/MapView.js").then((view) => ({ default: view.MapView }));
const MapView = lazy(() => mapView);

const VISITS_KEY = "tent-visits-v1";
/**
 * Pane widths. Each edge holds at its limits; pulled `fold` or `fill` pixels past one and let go, the pane
 * folds (the sidebar to its rail, the details closed) or the details fill the page. The map keeps `map`;
 * under the filled page it stays a `strip`, pulled `open` out to come back, so two edges never meet.
 */
const SIDE = { min: 220, max: 400, initial: 280, rail: 52, fold: 60, open: 68 };
const DETAIL = { min: 360, initial: 460, map: 320, fill: 60, fold: 80, strip: 36, open: 40 };

const darkQuery =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function useSystemDark() {
  return useSyncExternalStore(
    (cb) => {
      darkQuery?.addEventListener("change", cb);
      return () => darkQuery?.removeEventListener("change", cb);
    },
    () => !!darkQuery?.matches,
  );
}

/** The first visit sets the baseline, so only later changes show as new. */
function loadVisits(snapshot: Snapshot): Visits {
  const stored = readStored<Visits | null>(VISITS_KEY, null);
  if (stored && typeof stored.baseline === "number" && stored.seen) return stored;
  const latest = snapshot.commits[0]?.date ? Date.parse(snapshot.commits[0].date) : Date.now();
  const fresh = { baseline: latest, seen: {} };
  writeStored(VISITS_KEY, fresh);
  return fresh;
}

/** ?mode=doc opens the selected object expanded for reading. */
const startsExpanded = () => new URLSearchParams(location.search).get("mode") === "doc";

export function App() {
  // The map read draws the first screen; the full snapshot is read only when a view asks for details.
  const [map, setMap] = useState<WorkspaceMap | null>(null);
  const [initialCanvas, setInitialCanvas] = useState<CanvasInitial | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const firstLayout = useCallback(() => setLayoutReady(true), []);
  // A failed canvas cannot finish layout; let a restored open Dock retain its detail-read recovery.
  const detailsReady = layoutReady || (initialCanvas !== null && "error" in initialCanvas);
  const [full, setFull] = useState<Snapshot | null>(null);
  const [liveRevision, setLiveRevision] = useState<string | undefined>(undefined);
  const [factsEpoch, setFactsEpoch] = useState(0);
  const snapshot = useMemo(
    () => (map ? (full ? withMap(full, map) : mapSnapshot(map)) : null),
    [map, full],
  );
  const detailed = !!full;
  const [visits, setVisits] = useState<Visits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initiallyExpanded] = useState(startsExpanded);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [editOnExpand, setEditOnExpand] = useState(false);
  const [sideOpen, setSideOpen] = useState(() =>
    readStored("tent-side-open", window.innerWidth > 900),
  );
  const [detailWidth, setDetailWidth] = useState(() =>
    readStored("tent-detail-width", DETAIL.initial),
  );
  const [sideWidth, setSideWidth] = useState(() =>
    Math.min(SIDE.max, Math.max(SIDE.min, readStored("tent-side-width", SIDE.initial))),
  );
  const [themePref, setThemePref] = useState<ThemePref>(() =>
    readStored("tent-theme-pref", "system"),
  );
  const [selected, setSelected] = useState<SnapshotRef | null>(null);
  // AGENTS.md is no object of the graph: it opens in the same place, instead of a selection.
  const [agents, setAgents] = useState(false);
  const [historical, setHistorical] = useState<HistoricalSelection | undefined>();
  // The tree folds on its own (cuca 2026-10-21); it starts from what the map had folded.
  const [treeFolded, setTreeFolded] = useState<Set<string>>(
    () =>
      new Set(
        readStored<string[]>("tent-tree-folded-v1", readStored<string[]>("tent-collapsed-v1", [])),
      ),
  );
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lang, setLangState] = useState<Lang>(currentLang);
  const systemDark = useSystemDark();
  const theme = themePref === "system" ? (systemDark ? "dark" : "light") : themePref;
  const localCards = useDraftCards();
  const graph = useMemo(
    () =>
      snapshot
        ? buildGraph({ ...snapshot, cards: [...snapshot.cards, ...localCards] }, visits, detailed)
        : null,
    [snapshot, visits, localCards, detailed],
  );
  const showToast = useCallback((text: string) => setToast(text), []);
  const work = useWork(graph, showToast);
  // The robot the pointer rests on in the dock, or the one clicked to keep it lit; the tree and the map
  // mark what the Cards on its desk carry.
  const [hoverLane, setHoverLane] = useState<string | null>(null);
  const [pinnedLane, setPinnedLane] = useState<string | null>(null);
  const hotLane = hoverLane ?? pinnedLane;
  const carriedBy = useCallback(
    (lane: string) => (graph ? carried(graph, work.laneOf, lane) : new Set<string>()),
    [graph, work.laneOf],
  );
  // The Cards waiting or being done for each Node: the dock's lanes read back from the Nodes they carry.
  const handling = useMemo(
    () =>
      graph
        ? handlingOf(graph.snapshot.cards, work.laneOf, (id) => graph.nodes.has(id))
        : new Map(),
    [graph, work.laneOf],
  );
  // The open draft's sources in order, numbered on the map as in the tree.
  const draftIds = useMemo(
    () =>
      graph && work.openDraft ? sourceIds(graph, graph.cards.get(work.openDraft), work.draft) : [],
    [graph, work.openDraft, work.draft],
  );
  // The first screen: the map read alone.
  useEffect(() => {
    let live = true;
    const canvas = api
      .canvas()
      .then((r): CanvasInitial => ({ file: readCanvas(r.canvas), etag: r.etag }))
      .catch((error): CanvasInitial => ({ error: describe(error) }));
    loadMap().then(
      async (m) => {
        const opened = await canvas;
        if (!live) return;
        loadLocalDrafts(m.workspace.id);
        setInitialCanvas(opened);
        setMap(m);
      },
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const [lost, setLost] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  // The first requested details and later refreshes share one snapshot read. Map reads have their own
  // queue, so slower details never hold back topology received after another hint.
  const loader = useMemo(
    () =>
      workspaceRefresh({
        map: api.map,
        snapshot: api.snapshot,
        revision: api.revision,
        applyMap: (next) => {
          // A successful fresh observation also wakes selected facts when topology did not change.
          setFactsEpoch((epoch) => epoch + 1);
          setMap((current) =>
            current?.workspace.id === next.workspace.id &&
            current.workspace.revision === next.workspace.revision
              ? current
              : next,
          );
        },
        applySnapshot: (s) => {
          loadLocalDrafts(s.workspace.id);
          setFull(s);
          setVisits(loadVisits(s));
        },
        applyRevision: setLiveRevision,
        recovered: () => setLost(null),
        failed: (e) => {
          setLost(describe(e));
          return e instanceof ApiError && e.status === 401;
        },
      }),
    [],
  );
  const wantDetails = useCallback(() => {
    loader.want();
    setFollowing(true);
  }, [loader]);
  useEffect(() => () => loader.stop(), [loader]);

  // Watcher setup waits for the first map layout, including when a deep link asks for details sooner.
  // Hints only wake Core reads. Focus rereads and revision polling still recover changes when watching
  // is unavailable. The map's own revision is never compared with the full one.
  const hasMap = !!map;
  useEffect(() => {
    if (!hasMap || !following) return;
    const refresh = () => {
      if (!document.hidden) loader.hint();
    };
    const timer = window.setInterval(() => {
      if (!document.hidden) loader.poll();
    }, 5000);
    // Each connected frame rereads across the subscription gap, including reconnection. Hidden tabs
    // defer to visibilitychange rather than spending the service's idle time on background reads.
    const stop = layoutReady
      ? followChangeHints(openChanges, refresh, (e) => {
          if (!(e instanceof ApiError && e.status === 401)) return false;
          setLost(describe(e));
          loader.stop();
          return true;
        })
      : () => {};
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    changes.addEventListener("change", refresh);
    return () => {
      stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      changes.removeEventListener("change", refresh);
    };
  }, [hasMap, following, layoutReady, loader]);
  const files = useFileInfo(full ? snapshot : null);
  useEffect(() => {
    if (lost) setToast(lost);
  }, [lost]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStored("tent-theme-pref", themePref);
    try {
      localStorage.setItem("tent-theme", themePref === "system" ? "" : themePref);
    } catch {
      /* ignore */
    }
  }, [theme, themePref]);
  useEffect(() => writeStored("tent-side-open", sideOpen), [sideOpen]);
  useEffect(() => writeStored("tent-detail-width", detailWidth), [detailWidth]);
  useEffect(() => writeStored("tent-side-width", sideWidth), [sideWidth]);
  useEffect(() => writeStored("tent-tree-folded-v1", [...treeFolded]), [treeFolded]);

  // Keep the path to the selected Node open in the tree; the map opens its own.
  useEffect(() => {
    if (!graph || selected?.kind !== "node" || historical) return;
    const path = graph.ancestors(selected.id).map((a) => a.id);
    const unfold = (c: Set<string>) =>
      path.some((id) => c.has(id)) ? new Set([...c].filter((id) => !path.includes(id))) : c;
    setTreeFolded(unfold);
  }, [graph, selected?.id, historical]);

  const open = useCallback(
    (ref: SnapshotRef | null, historical?: HistoricalSelection) => {
      if (ref && ref.kind !== "node") wantDetails();
      setSelected(ref);
      setAgents(false);
      setHistorical(historical);
      setEditOnExpand(false);
      if (!ref) setExpanded(false);
      try {
        history.replaceState(
          null,
          "",
          `${location.search}${ref ? `#${ref.id}` : ""}` || location.pathname,
        );
      } catch {
        /* ignore */
      }
    },
    [wantDetails],
  );

  // A Node counts as read once you move on from it, so its "new" mark stays visible while it is open.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const markSeen = useCallback((ids: string[]) => {
    const nodes = snapshotRef.current?.nodes;
    if (!nodes) return;
    setVisits((v) => {
      if (!v) return v;
      const seen = { ...v.seen };
      let changed = false;
      for (const id of ids) {
        const head = nodes.find((n) => n.id === id)?.history[0];
        if (head && seen[id] !== head) {
          seen[id] = head;
          changed = true;
        }
      }
      if (!changed) return v;
      const next = { ...v, seen };
      writeStored(VISITS_KEY, next);
      return next;
    });
  }, []);
  useEffect(() => {
    if (selected?.kind !== "node" || historical) return;
    const id = selected.id;
    return () => markSeen([id]);
  }, [selected?.id, markSeen, historical]);

  // Deep links select an object; ?mode=doc opens it expanded, falling back to the first goal.
  useEffect(() => {
    if (!graph || selected || agents) return;
    const id = decodeURIComponent(location.hash.slice(1));
    if (id === AGENTS_PAGE.id) {
      setAgents(true);
      setExpanded(true);
      return;
    }
    // A Role or Card named in the link is known once the snapshot is in.
    if (!graph.detailed && id && !graph.nodes.has(id)) {
      // The id names the page before its slower details arrive, so the Reader can say it is loading.
      if (id.startsWith("card-")) setSelected({ kind: "card", id });
      else if (id.startsWith("role-")) setSelected({ kind: "role", id });
      return wantDetails();
    }
    // An empty link names nothing, though a Node whose header has no readable id is listed under "".
    const ref: SnapshotRef | null = !id
      ? null
      : graph.nodes.has(id)
        ? { kind: "node", id }
        : graph.roles.has(id)
          ? { kind: "role", id }
          : graph.cards.has(id)
            ? { kind: "card", id }
            : null;
    const fallback = initiallyExpanded
      ? (graph.snapshot.nodes.find((n) => primaryOf(n.type) === "goal") ?? graph.snapshot.nodes[0])
      : undefined;
    if (ref) setSelected(ref);
    else if (fallback) setSelected({ kind: "node", id: fallback.id });
  }, [graph]);
  // An object deleted elsewhere closes its details.
  useEffect(() => {
    if (
      graph &&
      selected &&
      !historical &&
      (selected.kind === "node" || graph.detailed) &&
      !graph.exists(selected)
    )
      open(null);
  }, [graph]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOverlay({ kind: "palette" });
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSideOpen((o) => !o);
      } else if (e.key === "Escape" && !typing) {
        setHoverLane(null);
        setPinnedLane(null);
        if (overlay) setOverlay(null);
        else if (expanded) setExpanded(false);
        else if (selected || agents) open(null);
      } else if (e.key === "Escape" && overlay) setOverlay(null);
      else if (!typing && e.key === "/") {
        e.preventDefault();
        setOverlay({ kind: "palette" });
      } else if (!typing && !mod && !e.altKey && !overlay) {
        // Single letters: C starts a Card in the public area, E edits the selected Node's text.
        const key = e.key.toLowerCase();
        if (key === "c") {
          e.preventDefault();
          void work.newCard(null);
        } else if (key === "e" && selected?.kind === "node" && !expanded && !historical) {
          e.preventDefault();
          setEditOnExpand(true);
          setExpanded(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, expanded, selected, agents, open, work, historical]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Drags a pane edge. The width follows the pointer between min and max and holds there; once pulled
   * `fold` below min or `fill` above max it is done at once, without letting go (cuca 2026-10-17: "拖不动
   * 然后继续拖就触发"). No line follows the pointer past the edge (cuca 2026-10-21).
   */
  const dragEdge = (
    e: React.PointerEvent,
    o: {
      width: number;
      /** 1 when the pane grows to the right (the sidebar), -1 when it grows to the left (the details). */
      sign: 1 | -1;
      min: number;
      max: number;
      fold?: number;
      fill?: number;
      onWidth?: (width: number) => void;
      onDone: (zone: "fold" | "fill" | null, width: number) => void;
    },
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    let width = o.width;
    const move = (ev: PointerEvent) => {
      const raw = o.width + o.sign * (ev.clientX - x0);
      width = Math.round(Math.min(o.max, Math.max(o.min, raw)));
      o.onWidth?.(width);
      const zone =
        o.fold && raw < o.min - o.fold ? "fold" : o.fill && raw > o.max + o.fill ? "fill" : null;
      if (zone) {
        end(zone);
        // The press that folded or filled is not also a click on what is now under it.
        const swallow = (c: Event) => c.stopPropagation();
        window.addEventListener("click", swallow, { capture: true });
        window.addEventListener(
          "pointerup",
          () => setTimeout(() => window.removeEventListener("click", swallow, { capture: true })),
          { once: true },
        );
      }
    };
    const end = (zone: "fold" | "fill" | null) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing");
      o.onDone(zone, width);
    };
    const up = () => end(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("is-resizing");
  };
  /** The sidebar's edge: resize it, or pull it past its narrowest to fold it to the rail (and back out). */
  const resizeSide = (e: React.PointerEvent) =>
    sideOpen
      ? dragEdge(e, {
          width: sideWidth,
          sign: 1,
          min: SIDE.min,
          max: SIDE.max,
          fold: SIDE.fold,
          onWidth: setSideWidth,
          onDone: (zone) => {
            if (zone === "fold") {
              setSideWidth(sideWidth);
              setSideOpen(false);
            }
          },
        })
      : dragEdge(e, {
          width: SIDE.rail,
          sign: 1,
          min: SIDE.rail,
          max: SIDE.rail,
          fill: SIDE.open,
          onDone: (zone) => zone === "fill" && setSideOpen(true),
        });
  /** The details' edge: resize them, pull past the widest to fill the page, or past the narrowest to close. */
  const resizeDetail = (e: React.PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const surface = handle.closest(".surface");
    const width = handle.parentElement!.getBoundingClientRect().width;
    dragEdge(e, {
      width,
      sign: -1,
      min: DETAIL.min,
      max: Math.max(DETAIL.min, (surface?.clientWidth ?? 1200) - DETAIL.map),
      fold: DETAIL.fold,
      fill: DETAIL.fill,
      onWidth: setDetailWidth,
      onDone: (zone) => {
        if (!zone) return;
        setDetailWidth(detailWidth);
        if (zone === "fold") open(null);
        else {
          setEditOnExpand(false);
          setExpanded(true);
        }
      },
    });
  };

  if (error)
    return (
      <div className="boot">
        <Pet id="tent" size={64} mood="off" />
        <p>{error}</p>
      </div>
    );
  if (!graph || !initialCanvas) return <Loader label={t.app.loading} />;

  const switchLang = (next: Lang) => {
    setLang(next);
    setLangState(next);
  };
  const locate = (ref: SnapshotRef) => {
    setExpanded(false);
    open(ref);
  };
  /** Roles and Cards open as pages; they are not places on the map. */
  const openPage = (ref: SnapshotRef) => {
    open(ref);
    setEditOnExpand(false);
    setExpanded(true);
  };
  /** AGENTS.md opens as a page too, with its name in the address like an object's id. */
  const openAgents = () => {
    open(null);
    setAgents(true);
    setExpanded(true);
    try {
      history.replaceState(null, "", `${location.search}#${AGENTS_PAGE.id}`);
    } catch {
      /* ignore */
    }
  };
  const opened = agents ? AGENTS_PAGE : selected;
  const reading = expanded && !!opened;
  // One set of robots: in the map's bar, or in a page's bar while the page covers the map.
  const dock = (
    <Dock
      graph={graph}
      detailsReady={detailsReady}
      selected={selected}
      work={work}
      draftOnPage={selected?.kind === "card" && selected.id === work.openDraft}
      hotLane={hotLane}
      pinned={pinnedLane}
      onHot={setHoverLane}
      onPin={setPinnedLane}
      onOpen={open}
      onPage={openPage}
      agentsOpen={agents}
      onAgents={openAgents}
    />
  );
  /** Fold or unfold a Node's children in the tree only; `deep` takes every Node under it along. */
  const foldTree = (id: string, expand?: boolean, deep?: boolean) => {
    const under = (n: string): string[] =>
      graph.childrenOf(n).flatMap((k) => [k.id, ...under(k.id)]);
    setTreeFolded((c) => {
      const folding = !(expand ?? c.has(id));
      const next = new Set(c);
      for (const n of deep ? [id, ...under(id)] : [id]) {
        if (folding) next.add(n);
        else next.delete(n);
      }
      return next;
    });
  };
  return (
    // Views read the messages while rendering; remounting them on a language change redraws every string.
    <NodeDetailsProvider revision={liveRevision} wantDetails={wantDetails}>
      <FilesContext.Provider value={files}>
        <HandlingContext.Provider value={handling}>
          <div
            key={lang}
            className={`app${sideOpen ? "" : " side-collapsed"}${reading ? " is-reading" : ""}`}
            style={{ "--side-w": `${sideWidth}px` } as CSSProperties}
          >
            <Sidebar
              graph={graph}
              selected={selected}
              open={sideOpen}
              collapsed={treeFolded}
              work={work}
              draftOnPage={selected?.kind === "card" && selected.id === work.openDraft}
              themePref={themePref}
              lang={lang}
              onTheme={setThemePref}
              onLang={switchLang}
              onFold={foldTree}
              onOpen={open}
              onPage={openPage}
              onLocate={locate}
              onSearch={() => setOverlay({ kind: "palette" })}
              onToggle={() => setSideOpen((o) => !o)}
              onResize={resizeSide}
              onResetWidth={() => setSideWidth(SIDE.initial)}
              onMarkAllSeen={() => markSeen(graph.snapshot.nodes.map((n) => n.id))}
              hotLane={hotLane}
              pinnedLane={pinnedLane}
              onUnpin={() => setPinnedLane(null)}
              reading={reading}
              onToast={showToast}
            />

            <div
              className={`surface${opened && !reading ? " has-detail" : ""}${reading ? " is-reading" : ""}`}
              style={{ "--detail-w": `${detailWidth}px` } as CSSProperties}
            >
              <main className="stage" aria-hidden={reading || undefined}>
                <StageBar
                  graph={graph}
                  selected={historical ? null : selected}
                  roles={!reading && dock}
                  onOpen={open}
                />
                <div className={`stage-body${graph.snapshot.nodes.length ? "" : " is-empty"}`}>
                  <Boundary label={t.app.map}>
                    <Suspense fallback={<Loader label={t.app.loading} />}>
                      <MapView
                        graph={graph}
                        factsEpoch={factsEpoch}
                        onFirstLayout={firstLayout}
                        initialCanvas={initialCanvas}
                        selected={selected}
                        draft={draftIds}
                        hotLane={hotLane}
                        carriedBy={carriedBy}
                        keys={!reading && !overlay}
                        onNotice={setToast}
                        onSelect={open}
                        onExpand={() => {
                          setEditOnExpand(false);
                          setExpanded(true);
                        }}
                      />
                    </Suspense>
                  </Boundary>
                  <FirstRun empty={!graph.snapshot.nodes.length} onToast={showToast} />
                </div>
              </main>

              {opened && !reading && (
                <aside className="detail">
                  <div
                    className="detail-resize"
                    onPointerDown={resizeDetail}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t.app.resizeDetail}
                  />
                  <Reader
                    mode="panel"
                    historical={historical}
                    graph={graph}
                    target={opened}
                    startEditing={false}
                    onOpen={open}
                    onClose={() => open(null)}
                    onExpand={(edit) => {
                      setEditOnExpand(!!edit);
                      setExpanded(true);
                    }}
                    work={work}
                    onLocate={locate}
                    onToast={showToast}
                  />
                </aside>
              )}

              {reading && (
                <button
                  type="button"
                  className="map-strip"
                  onPointerDown={(e) =>
                    dragEdge(e, {
                      width: DETAIL.strip,
                      sign: 1,
                      min: DETAIL.strip,
                      max: DETAIL.strip,
                      fill: DETAIL.open,
                      onDone: (zone) => zone === "fill" && setExpanded(false),
                    })
                  }
                  onClick={() => setExpanded(false)}
                  aria-label={t.reader.back}
                  data-tip={t.app.mapStrip}
                >
                  <Icon name="map" size={16} />
                  <span>{t.app.map}</span>
                </button>
              )}
              {reading && (
                <Reader
                  historical={historical}
                  roles={dock}
                  graph={graph}
                  target={opened!}
                  startEditing={editOnExpand}
                  onOpen={open}
                  onClose={() => open(null)}
                  onCollapse={() => setExpanded(false)}
                  work={work}
                  onLocate={locate}
                  onToast={showToast}
                />
              )}
            </div>

            {overlay?.kind === "palette" && (
              <Palette
                graph={graph}
                onOpen={(ref) => (ref.kind === "node" ? open(ref) : openPage(ref))}
                onClose={() => setOverlay(null)}
              />
            )}
            {toast && (
              <div className={`toast${toast === t.app.offline ? " has-face" : ""}`} role="status">
                {toast === t.app.offline && <Pet id="tent" size={28} mood="off" />}
                {toast}
              </div>
            )}
          </div>
        </HandlingContext.Provider>
      </FilesContext.Provider>
    </NodeDetailsProvider>
  );
}
