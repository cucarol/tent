import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { ApiError, api as server, describe, type SavedAnnotations } from "../data/api.js";
import type { Graph } from "../data/store.js";
import { t } from "../i18n.js";
import { readStored, writeStored } from "../util.js";
import {
  mergeElements,
  signature,
  versionsOf,
  type AnnotationDocument,
  type Anchor,
  type Stored,
} from "./annotations.js";

/** A card's box in map coordinates. */
export type Rect = { x: number; y: number; w: number; h: number };
export type Viewport = { x: number; y: number; zoom: number };

const STORE_KEY = "tent-map-sketch-v1";
const UI_OPTIONS = {
  // Pictures would need their bytes stored beside the annotations, which this version does not do.
  tools: { image: false },
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
    export: false,
    changeViewBackgroundColor: false,
  },
} as const;
// A mark within this distance of a card follows that card when the layout moves.
const ANCHOR_REACH = 200;
// The workspace copy is saved once drawing pauses this long; the browser copy right away.
const SAVE_AFTER = 3000;
// A request sent while the page closes may carry at most 64 KB.
const KEEPALIVE_LIMIT = 60_000;

type Scene = Stored<ExcalidrawElement>;
type Suggestion = { arrowId: string; from: string; to: string };

function bounds(el: ExcalidrawElement) {
  if ("points" in el && el.points.length) {
    const xs = el.points.map((p) => p[0]),
      ys = el.points.map((p) => p[1]);
    return {
      x1: el.x + Math.min(...xs),
      y1: el.y + Math.min(...ys),
      x2: el.x + Math.max(...xs),
      y2: el.y + Math.max(...ys),
    };
  }
  return { x1: el.x, y1: el.y, x2: el.x + el.width, y2: el.y + el.height };
}
const distance = (px: number, py: number, r: Rect) =>
  Math.hypot(Math.max(r.x - px, 0, px - (r.x + r.w)), Math.max(r.y - py, 0, py - (r.y + r.h)));

function nearest(rects: Map<string, Rect>, px: number, py: number, reach: number): string | null {
  let best: string | null = null,
    bestD = reach;
  for (const [id, r] of rects) {
    const d = distance(px, py, r);
    if (d <= bestD) {
      best = id;
      bestD = d;
    }
  }
  return best;
}

/** Move each saved mark by however far its anchor card has moved since it was drawn. */
function reanchor(saved: Pick<Scene, "elements" | "anchors">, rects: Map<string, Rect>) {
  const moved = saved.elements.map((el) => {
    const a = saved.anchors[el.id],
      r = a && rects.get(a.node);
    return r && (r.x !== a.x || r.y !== a.y)
      ? ({ ...el, x: el.x + r.x - a.x, y: el.y + r.y - a.y } as ExcalidrawElement)
      : el;
  });
  return restoreElements(moved, null);
}

/** Each mark's nearest card within reach, and where that card is now. */
function anchorsOf(elements: readonly ExcalidrawElement[], rects: Map<string, Rect>) {
  const anchors: Record<string, Anchor> = {};
  for (const el of elements) {
    const b = bounds(el),
      node = nearest(rects, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, ANCHOR_REACH);
    const r = node ? rects.get(node) : undefined;
    if (node && r) anchors[el.id] = { node, x: r.x, y: r.y };
  }
  return anchors;
}

const fromSaved = (saved: SavedAnnotations | null) =>
  saved?.document
    ? {
        elements: saved.document.map.elements as unknown as ExcalidrawElement[],
        anchors: saved.document.map.anchors,
      }
    : null;

type Props = {
  graph: Graph;
  rects: Map<string, Rect>;
  drawing: boolean;
  theme: "light" | "dark";
  initial: Viewport;
  onReady: (api: ExcalidrawImperativeAPI) => void;
  onViewport: (v: Viewport) => void;
  onToast: (text: string) => void;
};

/**
 * Free drawing on top of the map. Both layers share one coordinate space: the map's world
 * coordinates are the scene coordinates, and the two viewports are kept in step.
 */
export default function SketchLayer({
  graph,
  rects,
  drawing,
  theme,
  initial,
  onReady,
  onViewport,
  onToast,
}: Props) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  apiRef.current = api;
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  // Offered once for marks drawn before annotations were saved in the workspace.
  const [offer, setOffer] = useState(false);
  const localTimer = useRef<number | undefined>(undefined);
  const serverTimer = useRef<number | undefined>(undefined);
  const rectsRef = useRef(rects);
  rectsRef.current = rects;
  // The saved annotations this scene builds on: their ETag, their element versions, and the
  // signature of what the workspace has, so an unchanged scene is not saved again.
  const etag = useRef<string | null>(null);
  const base = useRef(new Map<string, number>());
  const saved = useRef("");
  // The signature of a save still on its way, so changes arriving meanwhile are not sent twice.
  const sending = useRef("");
  const saving = useRef(false);
  // Only ask about arrows drawn or edited here, not ones the layer opened with.
  const openedArrows = useRef(new Map<string, number>());
  const remember = (elements: readonly ExcalidrawElement[]) => {
    for (const e of elements) if (e.type === "arrow") openedArrows.current.set(e.id, e.version);
  };

  /** The browser copy; `unsaved` marks changes the workspace does not have yet. */
  const keepLocal = (elements: readonly ExcalidrawElement[], unsaved: boolean) =>
    writeStored(STORE_KEY, {
      elements: [...elements],
      anchors: anchorsOf(elements, rectsRef.current),
      unsaved,
      baseEtag: etag.current,
      base: Object.fromEntries(base.current),
    } satisfies Scene);

  const initialData = useMemo(
    () =>
      (async () => {
        const local = readStored<Scene | null>(STORE_KEY, null);
        let remote: SavedAnnotations | null = null;
        try {
          remote = await server.annotations();
        } catch (error) {
          onToast(describe(error));
        }
        let scene: Pick<Scene, "elements" | "anchors"> | null = fromSaved(remote);
        etag.current = remote?.etag ?? null;
        base.current = versionsOf(scene?.elements ?? []);
        if (local?.unsaved) {
          // Changes that never reached the workspace carry on from where they were made.
          scene = local;
          etag.current = local.baseEtag ?? null;
          base.current = new Map(Object.entries(local.base ?? {}));
        } else if (!remote && local) scene = local;
        else if (!scene && local?.elements?.length) {
          scene = local;
          setOffer(true);
        }
        const elements = scene?.elements?.length ? reanchor(scene, rectsRef.current) : [];
        remember(elements);
        // Pending changes differ from anything saved, so the first change event sends them.
        saved.current = local?.unsaved ? "" : signature(elements);
        return {
          elements,
          appState: {
            viewBackgroundColor: "transparent",
            currentItemStrokeColor: "#DF5D2A",
            currentItemFontFamily: 5,
            currentItemRoughness: 1,
            scrollX: initial.x / initial.zoom,
            scrollY: initial.y / initial.zoom,
            zoom: { value: initial.zoom },
          },
        };
      })(),
    [],
  );

  /** Send the scene to the workspace, merging in anything saved meanwhile from elsewhere. */
  const save = useCallback(async (closing = false) => {
    window.clearTimeout(serverTimer.current);
    const excalidraw = apiRef.current;
    if (!excalidraw) return;
    if (saving.current) {
      serverTimer.current = window.setTimeout(() => void save(), 500);
      return;
    }
    let elements = excalidraw.getSceneElements();
    if (signature(elements) === saved.current) return;
    const documentOf = (
      els: readonly ExcalidrawElement[],
    ): AnnotationDocument<ExcalidrawElement> => ({
      schemaVersion: 1,
      map: { elements: [...els], anchors: anchorsOf(els, rectsRef.current) },
    });
    // What does not fit in a closing request stays in the browser copy until the next visit.
    if (closing && JSON.stringify(documentOf(elements)).length > KEEPALIVE_LIMIT) return;
    saving.current = true;
    try {
      for (let attempt = 0; ; attempt++) {
        sending.current = signature(elements);
        try {
          const result = await server.saveAnnotations(etag.current, documentOf(elements), closing);
          etag.current = result.etag;
          base.current = versionsOf(elements);
          saved.current = signature(elements);
          keepLocal(elements, false);
          setOffer(false);
          return;
        } catch (error) {
          const current =
            error instanceof ApiError && error.code === "ETAG_CONFLICT"
              ? (error.details?.current as SavedAnnotations | undefined)
              : undefined;
          if (!current || attempt > 0) throw error;
          const theirs = reanchor(
            fromSaved(current) ?? { elements: [], anchors: {} },
            rectsRef.current,
          );
          elements = mergeElements(base.current, excalidraw.getSceneElements(), theirs);
          remember(theirs);
          excalidraw.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
          etag.current = current.etag;
          base.current = versionsOf(theirs);
        }
      }
    } catch (error) {
      onToast(describe(error));
    } finally {
      saving.current = false;
      sending.current = "";
    }
  }, []);

  useEffect(() => {
    if (api) onReady(api);
  }, [api]);
  // Save when drawing ends, when the page goes to the background or closes, and on the way out.
  useEffect(() => {
    if (!drawing) void save();
  }, [drawing]);
  useEffect(() => {
    const hidden = () => document.hidden && void save();
    const closing = () => void save(true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", closing);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", closing);
      window.clearTimeout(localTimer.current);
      void save();
    };
  }, []);

  // Marks saved from another page arrive with the refreshed map; unsent changes here merge on save.
  const savedEtag = graph.snapshot.annotations.etag;
  useEffect(() => {
    const excalidraw = api;
    if (!excalidraw || savedEtag === etag.current || saving.current) return;
    if (signature(excalidraw.getSceneElements()) !== saved.current) return;
    let live = true;
    server.annotations().then(
      (current) => {
        if (!live || current.etag === etag.current) return;
        const theirs = reanchor(
          fromSaved(current) ?? { elements: [], anchors: {} },
          rectsRef.current,
        );
        remember(theirs);
        etag.current = current.etag;
        base.current = versionsOf(theirs);
        saved.current = signature(theirs);
        excalidraw.updateScene({ elements: theirs, captureUpdate: CaptureUpdateAction.NEVER });
        keepLocal(theirs, false);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [savedEtag, api]);

  const keepOld = () => {
    saved.current = "";
    setOffer(false);
    void save();
  };
  const dropOld = () => {
    saved.current = signature([]);
    apiRef.current?.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER });
    keepLocal([], false);
    setOffer(false);
  };

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      const live = elements.filter((e) => !e.isDeleted);
      const hit = (x: number, y: number) => nearest(rectsRef.current, x, y, 12);
      const arrow = live.find(
        (e) =>
          e.type === "arrow" &&
          !e.customData?.tentRelation &&
          openedArrows.current.get(e.id) !== e.version &&
          "points" in e &&
          e.points.length > 1,
      );
      let next: Suggestion | null = null;
      if (arrow && "points" in arrow) {
        const [s, t] = [arrow.points[0]!, arrow.points[arrow.points.length - 1]!];
        const from = hit(arrow.x + s[0], arrow.y + s[1]),
          to = hit(arrow.x + t[0], arrow.y + t[1]);
        if (from && to && from !== to && graph.nodes.has(from) && graph.nodes.has(to))
          next = { arrowId: arrow.id, from, to };
      }
      setSuggestion((prev) =>
        prev?.arrowId === next?.arrowId && prev?.from === next?.from && prev?.to === next?.to
          ? prev
          : next,
      );

      const current = signature(live);
      if (current === saved.current || current === sending.current) return;
      window.clearTimeout(localTimer.current);
      localTimer.current = window.setTimeout(
        () => keepLocal(live, signature(live) !== saved.current),
        500,
      );
      window.clearTimeout(serverTimer.current);
      serverTimer.current = window.setTimeout(() => void save(), SAVE_AFTER);
    },
    [graph, save],
  );

  const onScrollChange = useCallback(
    (scrollX: number, scrollY: number, zoom: AppState["zoom"]) => {
      onViewport({ x: scrollX * zoom.value, y: scrollY * zoom.value, zoom: zoom.value });
    },
    [onViewport],
  );

  const [recording, setRecording] = useState(false);
  /** Add the arrow's target to its source Node's sources; the arrow changes only once that is saved. */
  const record = async ({ from, to }: Suggestion) => {
    const already = graph.nodes
      .get(from)
      ?.materials.some((m) => m.field === "sources" && m.kind === "node" && m.id === to);
    if (already) return;
    const doc = await server.node(from);
    const sources = Array.isArray(doc.frontmatter.sources) ? doc.frontmatter.sources : [];
    await server.saveNode(from, {
      baseEtag: doc.etag,
      frontmatter: { sources: [...sources, { resource: `/${graph.nodes.get(to)!.notePath}` }] },
    });
  };

  const settle = async (kind: "reference" | "sketch") => {
    if (!api || !suggestion || recording) return;
    if (kind === "reference") {
      setRecording(true);
      try {
        await record(suggestion);
      } catch (error) {
        onToast(describe(error));
        return;
      } finally {
        setRecording(false);
      }
    }
    const prompt =
      getComputedStyle(document.documentElement).getPropertyValue("--prompt").trim() || "#1C6B66";
    const elements = api.getSceneElementsIncludingDeleted().map((e) =>
      e.id !== suggestion.arrowId
        ? e
        : newElementWith(
            e as never,
            kind === "reference"
              ? ({
                  customData: {
                    tentRelation: "reference",
                    from: suggestion.from,
                    to: suggestion.to,
                  },
                  strokeColor: prompt,
                  strokeStyle: "solid",
                  roughness: 0,
                } as never)
              : ({ customData: { tentRelation: "sketch" } } as never),
          ),
    );
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    if (kind === "reference")
      onToast(
        t.sketch.recorded(
          graph.name({ kind: "node", id: suggestion.to }),
          graph.name({ kind: "node", id: suggestion.from }),
        ),
      );
    setSuggestion(null);
  };

  return (
    <div className={`sketch${drawing ? " is-drawing" : ""}`}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData as never}
        theme={theme}
        langCode={t.sketch.excalidraw}
        viewModeEnabled={!drawing}
        onChange={onChange}
        onScrollChange={onScrollChange}
        UIOptions={UI_OPTIONS}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
      {drawing && suggestion && (
        <div className="floatbar suggest" role="status">
          <span>
            {t.sketch.suggest(
              <b>{graph.name({ kind: "node", id: suggestion.from })}</b>,
              <b>{graph.name({ kind: "node", id: suggestion.to })}</b>,
            )}
          </span>
          <button
            type="button"
            className="primary"
            onClick={() => settle("reference")}
            disabled={recording}
          >
            {t.sketch.asReference}
          </button>
          <button type="button" onClick={() => settle("sketch")}>
            {t.sketch.justDrawing}
          </button>
        </div>
      )}
      {offer && !(drawing && suggestion) && (
        <div className="floatbar suggest" role="status">
          <span>{t.sketch.migrate}</span>
          <button type="button" className="primary" onClick={keepOld}>
            {t.sketch.migrateKeep}
          </button>
          <button type="button" onClick={dropOld}>
            {t.sketch.migrateDrop}
          </button>
        </div>
      )}
    </div>
  );
}
