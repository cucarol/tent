import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { buildGraph, loadSnapshot, primaryOf, type Visits } from "./data/store.js";
import { api, ApiError, changes, describe } from "./data/api.js";
import type { Snapshot, SnapshotRef } from "./data/types.js";
import { Icon, TypeGlyph } from "./components/Glyph.js";
import { MapView } from "./map/MapView.js";
import { Boundary } from "./components/Boundary.js";
import { Sidebar, type ThemePref } from "./shell/Sidebar.js";
import { StageBar, type StageView } from "./shell/StageBar.js";
import { NowView } from "./now/NowView.js";
import { Reader } from "./panel/Reader.js";
import { Palette } from "./panel/Overlays.js";
import { isDraft, loadLocalDrafts, useDraftCards } from "./data/drafts.js";
import { FlagsContext, useSyncFlags } from "./data/flags.js";
import { useDragState } from "./shell/drag.js";
import { carried, sourceIds, useWork, type Work } from "./shell/work.js";
import type { Graph } from "./data/store.js";
import { readStored, writeStored } from "./util.js";
import { currentLang, setLang, t, type Lang } from "./i18n.js";

type Overlay = { kind: "palette" } | null;

const VISITS_KEY = "tent-visits-v1";
/**
 * Pane widths. Each edge holds at its limits; pulled `fold` or `fill` pixels past one and let go, the pane
 * folds (the sidebar to its rail, the details closed) or the details fill the page. The map keeps `map`.
 */
const SIDE = { min: 220, max: 400, initial: 280, rail: 52, fold: 60, open: 68 };
const DETAIL = { min: 360, initial: 460, map: 320, fill: 60, fold: 80 };
type Edge = { x: number; label: string | null };

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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
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
  const [edge, setEdge] = useState<Edge | null>(null);
  const [themePref, setThemePref] = useState<ThemePref>(() =>
    readStored("tent-theme-pref", "system"),
  );
  const [selected, setSelected] = useState<SnapshotRef | null>(null);
  const [view, setView] = useState<StageView>(() =>
    readStored<StageView>("tent-view", "now") === "map" ? "map" : "now",
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(readStored<string[]>("tent-collapsed-v1", [])),
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
        ? buildGraph({ ...snapshot, cards: [...snapshot.cards, ...localCards] }, visits)
        : null,
    [snapshot, visits, localCards],
  );
  const showToast = useCallback((text: string) => setToast(text), []);
  const work = useWork(graph, showToast);
  // The lane the pointer rests on in 分工; the tree and the map mark what its Cards carried.
  const [hotLane, setHotLane] = useState<string | null>(null);
  const carriedBy = useCallback(
    (lane: string) => (graph ? carried(graph, work.laneOf, lane) : new Set<string>()),
    [graph, work.laneOf],
  );
  // The open draft's sources in order, numbered on the map as in the tree.
  const draftIds = useMemo(
    () =>
      graph && work.openDraft ? sourceIds(graph, graph.cards.get(work.openDraft), work.draft) : [],
    [graph, work.openDraft, work.draft],
  );
  useEffect(() => {
    loadSnapshot()
      .then((s) => {
        loadLocalDrafts(s.workspace.id);
        setSnapshot(s);
        setVisits(loadVisits(s));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Follow changes made elsewhere: compare revisions on focus and every few seconds while visible.
  const revision = snapshot?.workspace.revision;
  const flags = useSyncFlags(revision);
  const [lost, setLost] = useState<string | null>(null);
  useEffect(() => {
    if (!revision) return;
    let stopped = false,
      busy = false,
      again = false;
    const check = async () => {
      if (stopped || document.hidden) return;
      // A write that lands during a check is looked at right after it, not at the next tick.
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        if ((await api.revision()).revision !== revision) {
          const fresh = await api.snapshot(revision);
          if (fresh && !stopped) setSnapshot(fresh);
        }
        setLost(null);
      } catch (error) {
        setLost(describe(error));
        if (error instanceof ApiError && error.status === 401) stopped = true;
      } finally {
        busy = false;
        if (again) {
          again = false;
          void check();
        }
      }
    };
    // Writes made while the previous snapshot was on its way are caught here.
    void check();
    const timer = window.setInterval(check, 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    changes.addEventListener("change", check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      changes.removeEventListener("change", check);
    };
  }, [revision]);
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
  useEffect(() => writeStored("tent-collapsed-v1", [...collapsed]), [collapsed]);

  // Keep the path to the selected Node open, in the tree and on the map.
  useEffect(() => {
    if (!graph || selected?.kind !== "node") return;
    const path = graph.ancestors(selected.id).map((a) => a.id);
    setCollapsed((c) =>
      path.some((id) => c.has(id)) ? new Set([...c].filter((id) => !path.includes(id))) : c,
    );
  }, [graph, selected?.id]);

  const open = useCallback((ref: SnapshotRef | null) => {
    setSelected(ref);
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
  }, []);

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
    if (selected?.kind !== "node") return;
    const id = selected.id;
    return () => markSeen([id]);
  }, [selected?.id, markSeen]);

  // Deep links select an object; ?mode=doc opens it expanded, falling back to the first goal.
  useEffect(() => {
    if (!graph || selected) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const ref: SnapshotRef | null = graph.nodes.has(id)
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
    if (graph && selected && !graph.exists(selected)) open(null);
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
        if (overlay) setOverlay(null);
        else if (expanded) setExpanded(false);
        else if (selected) open(null);
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
        } else if (key === "e" && selected?.kind === "node" && !expanded) {
          e.preventDefault();
          setEditOnExpand(true);
          setExpanded(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, expanded, selected, open, work]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Drags a pane edge. The width follows the pointer between min and max and holds there; a line keeps
   * following, and past `fold` below min or `fill` above max it names what letting go will do.
   */
  const dragEdge = (
    e: React.PointerEvent,
    o: {
      width: number;
      /** 1 when the pane grows to the right (the sidebar), -1 when it grows to the left (the details). */
      sign: 1 | -1;
      min: number;
      max: number;
      fold?: { by: number; label: string };
      fill?: { by: number; label: string };
      onWidth?: (width: number) => void;
      onDone: (zone: "fold" | "fill" | null, width: number) => void;
    },
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    let zone: "fold" | "fill" | null = null;
    let width = o.width;
    const move = (ev: PointerEvent) => {
      const raw = o.width + o.sign * (ev.clientX - x0);
      width = Math.round(Math.min(o.max, Math.max(o.min, raw)));
      o.onWidth?.(width);
      zone =
        o.fold && raw < o.min - o.fold.by
          ? "fold"
          : o.fill && raw > o.max + o.fill.by
            ? "fill"
            : null;
      const label = zone === "fold" ? o.fold!.label : zone === "fill" ? o.fill!.label : null;
      setEdge(raw < o.min || raw > o.max ? { x: ev.clientX, label } : null);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing");
      setEdge(null);
      o.onDone(zone, width);
    };
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
          fold: { by: SIDE.fold, label: t.app.edgeFoldSide },
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
          fill: { by: SIDE.open, label: t.app.edgeOpenSide },
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
      fold: { by: DETAIL.fold, label: t.app.edgeClose },
      fill: { by: DETAIL.fill, label: t.app.edgeFill },
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
        <p>{error}</p>
      </div>
    );
  if (!graph)
    return (
      <div className="boot">
        <p>{t.app.loading}</p>
      </div>
    );

  const switchLang = (next: Lang) => {
    setLang(next);
    setLangState(next);
  };
  const showView = (next: StageView) => {
    setView(next);
    writeStored("tent-view", next);
  };
  const locate = (ref: SnapshotRef) => {
    setExpanded(false);
    showView("map");
    open(ref);
  };
  /** Roles and Cards open as pages; they are not places on the map. */
  const openPage = (ref: SnapshotRef) => {
    open(ref);
    setEditOnExpand(false);
    setExpanded(true);
  };
  const reading = expanded && !!selected;
  /** Fold or unfold a Node's children in both the tree and the map; folding away the selection selects the folded Node. */
  const fold = (id: string, expand?: boolean) => {
    const folding = !(expand ?? collapsed.has(id));
    setCollapsed((c) => {
      const next = new Set(c);
      if (folding) next.add(id);
      else next.delete(id);
      return next;
    });
    if (
      folding &&
      selected?.kind === "node" &&
      graph.ancestors(selected.id).some((a) => a.id === id)
    )
      open({ kind: "node", id });
  };

  return (
    // Views read the messages while rendering; remounting them on a language change redraws every string.
    <FlagsContext.Provider value={flags}>
      <div
        key={lang}
        className={`app${sideOpen ? "" : " side-collapsed"}${reading ? " is-reading" : ""}`}
        style={{ "--side-w": `${sideWidth}px` } as CSSProperties}
      >
        <Sidebar
          graph={graph}
          selected={selected}
          open={sideOpen}
          collapsed={collapsed}
          work={work}
          draftOnPage={selected?.kind === "card" && selected.id === work.openDraft}
          themePref={themePref}
          lang={lang}
          onTheme={setThemePref}
          onLang={switchLang}
          onFold={fold}
          onOpen={open}
          onPage={openPage}
          onLocate={locate}
          onSearch={() => setOverlay({ kind: "palette" })}
          onToggle={() => setSideOpen((o) => !o)}
          onResize={resizeSide}
          onResetWidth={() => setSideWidth(SIDE.initial)}
          onMarkAllSeen={() => markSeen(graph.snapshot.nodes.map((n) => n.id))}
          hotLane={hotLane}
          onHotLane={setHotLane}
        />

        <div
          className={`surface${selected && !reading ? " has-detail" : ""}`}
          style={{ "--detail-w": `${detailWidth}px` } as CSSProperties}
        >
          <main className="stage" aria-hidden={reading || undefined}>
            <StageBar
              graph={graph}
              selected={selected}
              view={view}
              onView={showView}
              onOpen={open}
            />
            <div className="stage-body">
              {view === "now" ? (
                <Boundary label={t.now.tab}>
                  <NowView graph={graph} flags={flags} onOpen={open} onPage={openPage} />
                </Boundary>
              ) : (
                <Boundary label={t.app.map}>
                  <ReactFlowProvider>
                    <MapView
                      graph={graph}
                      flags={flags}
                      selected={selected}
                      collapsed={collapsed}
                      draft={draftIds}
                      hotLane={hotLane}
                      carriedBy={carriedBy}
                      keys={!reading && !overlay}
                      onSelect={open}
                      onFold={fold}
                      onExpand={() => {
                        setEditOnExpand(false);
                        setExpanded(true);
                      }}
                    />
                  </ReactFlowProvider>
                </Boundary>
              )}
            </div>
          </main>

          {selected && !reading && (
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
                graph={graph}
                target={selected}
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
            <Reader
              graph={graph}
              target={selected!}
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
        <DragGhost graph={graph} work={work} />
        {edge && (
          <div
            className={`edge-line${edge.label ? " is-armed" : ""}${edge.x > window.innerWidth - 240 ? " flip" : ""}`}
            style={{ left: edge.x }}
            aria-hidden="true"
          >
            {edge.label && <span>{edge.label}</span>}
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </FlagsContext.Provider>
  );
}

/** What is being dragged, following the pointer. */
function DragGhost({ graph, work }: { graph: Graph; work: Work }) {
  const drag = useDragState();
  if (!drag) return null;
  const node = drag.item.kind === "node" ? graph.nodes.get(drag.item.id) : undefined;
  const card = drag.item.kind === "card" ? graph.cards.get(drag.item.id) : undefined;
  if (!node && !card) return null;
  return (
    <div
      className={`drag-ghost${card && !isDraft(card) ? " is-pub" : ""}${drag.over ? " is-over" : ""}`}
      style={{ left: drag.x + 14, top: drag.y + 10 }}
    >
      {node ? (
        <TypeGlyph type={node.type} size={14} />
      ) : (
        <Icon name={isDraft(card!) ? "edit" : "mail"} size={14} />
      )}
      <span>{node?.name ?? work.title(card!)}</span>
    </div>
  );
}
