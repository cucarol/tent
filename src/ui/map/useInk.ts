// Keeps the map's drawings: read from the workspace's canvas file through the service, and written back
// whole with its ETag, one write at a time. Undo and redo cover the drawings only, and only this page's
// own steps; a change saved from elsewhere replaces them and starts undo over.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, describe } from "../data/api.js";
import { t } from "../i18n.js";
import { emptyCanvas, inkOf, readCanvas, withInk, type CanvasFile, type Ink } from "./drawings.js";

export type InkStore = {
  ink: Ink[];
  /** False until the file has been read; nothing can be drawn before then. */
  ready: boolean;
  /** Replace the drawings, as one step of undo; a function gets the drawings as they are now. */
  commit: (next: Ink[] | ((current: Ink[]) => Ink[])) => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
};

/** Steps of undo kept per page. */
const DEPTH = 100;

type Held = { workspace: string; file: CanvasFile; ink: Ink[]; ready: boolean };

export function useInk(
  workspace: string,
  revision: string,
  onNotice: (message: string) => void,
): InkStore {
  const blank = (): Held => ({ workspace, file: emptyCanvas(), ink: [], ready: false });
  const [held, setHeld] = useState<Held>(blank);
  // Another workspace's drawings are never shown or written here: until this one is read, it is empty.
  const state = held.workspace === workspace ? held : blank();
  const live = useRef(state);
  live.current = state;
  const etag = useRef<string | null>(null);
  const [steps, setSteps] = useState<{ past: Ink[][]; future: Ink[][] }>({ past: [], future: [] });
  const saving = useRef(false);
  const queued = useRef<CanvasFile | null>(null);
  const notice = useRef(onNotice);
  notice.current = onNotice;

  const adopt = useCallback(
    (file: CanvasFile, tag: string | null) => {
      etag.current = tag;
      const next = { workspace, file, ink: inkOf(file), ready: true };
      live.current = next;
      setHeld(next);
    },
    [workspace],
  );

  useEffect(() => setSteps({ past: [], future: [] }), [workspace]);
  // Read on open and whenever the workspace moves on, unless our own write is still on its way.
  useEffect(() => {
    if (saving.current) return;
    let current = true;
    api
      .canvas()
      .then((r) => {
        if (!current || saving.current) return;
        if (live.current.ready && r.etag === etag.current) return;
        if (live.current.ready) setSteps({ past: [], future: [] });
        adopt(readCanvas(r.canvas), r.etag);
      })
      .catch((error: unknown) => current && notice.current(describe(error)));
    return () => {
      current = false;
    };
  }, [workspace, revision, adopt]);

  const persist = useCallback(
    (file: CanvasFile) => {
      queued.current = file;
      if (saving.current) return;
      saving.current = true;
      void (async () => {
        while (queued.current) {
          const next = queued.current;
          queued.current = null;
          try {
            etag.current = (await api.saveCanvas(etag.current, next)).etag;
          } catch (error) {
            const current = error instanceof ApiError ? error.details?.current : undefined;
            if (error instanceof ApiError && error.code === "ETAG_CONFLICT" && current) {
              // Saved from elsewhere in the meantime: theirs stands, and undo starts over from it.
              const theirs = current as { etag?: string | null; canvas?: unknown };
              queued.current = null;
              setSteps({ past: [], future: [] });
              adopt(readCanvas(theirs.canvas), theirs.etag ?? null);
              notice.current(t.ink.conflict);
            } else notice.current(describe(error));
          }
        }
        saving.current = false;
      })();
    },
    [adopt],
  );

  const show = useCallback(
    (ink: Ink[]) => {
      const file = withInk(live.current.file, ink);
      const next = { ...live.current, file, ink };
      live.current = next;
      setHeld(next);
      persist(file);
    },
    [persist],
  );

  const commit = useCallback(
    (next: Ink[] | ((current: Ink[]) => Ink[])) => {
      if (!live.current.ready) return;
      const before = live.current.ink;
      const after = typeof next === "function" ? next(before) : next;
      if (after === before) return;
      setSteps((s) => ({ past: [...s.past.slice(-(DEPTH - 1)), before], future: [] }));
      show(after);
    },
    [show],
  );
  const undo = useCallback(() => {
    const prev = steps.past.at(-1);
    if (!live.current.ready || !prev) return false;
    setSteps({ past: steps.past.slice(0, -1), future: [live.current.ink, ...steps.future] });
    show(prev);
    return true;
  }, [show, steps]);
  const redo = useCallback(() => {
    const next = steps.future[0];
    if (!live.current.ready || !next) return false;
    setSteps({ past: [...steps.past, live.current.ink], future: steps.future.slice(1) });
    show(next);
    return true;
  }, [show, steps]);

  return {
    ink: state.ink,
    ready: state.ready,
    commit,
    undo,
    redo,
    canUndo: steps.past.length > 0,
    canRedo: steps.future.length > 0,
  };
}
