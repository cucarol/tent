// Keeps the map's canvas file: read from the workspace through the service, changed here, and written back
// whole with its ETag. Every write takes the workspace lock and records a Tent version, so changes gather
// and go in one write once the page has been quiet for SAVE_AFTER, or when it is hidden. A save from
// another page meanwhile is read back and this page's unsaved changes are laid over it, entry by entry.
// Undo and redo cover everything arranged by hand here: drawings, card places and regions. They live in
// this page, and each step turns back only the entries it changed, so what another page saved meanwhile
// stays. A step also keeps which drawings were picked on either side of it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describe } from "../data/api.js";
import {
  afterSave,
  emptyCanvas,
  inverseOf,
  laidOver,
  hasPending,
  noPending,
  readCanvas,
  withPending,
  type CanvasFile,
  type Pending,
  type Region,
} from "./canvas.js";
import { inkChanges, inkOf, type Ink, type Pt } from "./drawings.js";

/** The drawings picked before and after a step, given back when it is undone or redone. */
export type Picks = { before: string[]; after: string[] };

export type InkStore = {
  ink: Ink[];
  /** False until the file has been read; nothing can be drawn before then. */
  ready: boolean;
  /** Replace the drawings, as one step of undo; a function gets the drawings as they are now. */
  commit: (next: Ink[] | ((current: Ink[]) => Ink[]), picks?: Picks) => void;
  /** Keep drawings as they now show, outside undo: a held line end where its card has gone. */
  keep: (changes: Map<string, Ink | null>) => void;
};

export type CanvasStore = InkStore & {
  /** Each returns what was picked on the side it steps to, or null when there is nothing to step. */
  undo: () => string[] | null;
  redo: () => string[] | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Each hand-placed card's top-left corner. */
  positions: Record<string, Pt>;
  regions: Region[];
  /** Change card places and regions; null puts a card back in the tree or takes a region away. */
  arrange: (change: {
    positions?: Record<string, Pt | null>;
    regions?: Record<string, Region | null>;
  }) => void;
};

/** Quiet time before changes are written. */
export const SAVE_AFTER = 2000;
/** Steps of undo kept per page. */
const DEPTH = 100;
/** Saves from elsewhere met in a row before giving up until the next change. */
const RETRIES = 3;

type Held = { workspace: string; file: CanvasFile; pending: Pending; ready: boolean };

export function useCanvas(
  workspace: string,
  revision: string,
  onNotice: (message: string) => void,
): CanvasStore {
  const blank = (): Held => ({
    workspace,
    file: emptyCanvas(),
    pending: noPending(),
    ready: false,
  });
  const [held, setHeld] = useState<Held>(blank);
  // Another workspace's canvas is never shown or written here: until this one is read, it is empty.
  const state = held.workspace === workspace ? held : blank();
  const live = useRef(state);
  live.current = state;
  const etag = useRef<string | null>(null);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const [steps, setSteps] = useState<{ past: Step[]; future: Step[] }>({ past: [], future: [] });

  const hold = useCallback((next: Held) => {
    live.current = next;
    setHeld(next);
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // A write on its way picks up whatever changed meanwhile before it finishes.
    if (saving.current) return;
    if (!live.current.ready || !hasPending(live.current.pending)) return;
    saving.current = true;
    let tries = 0;
    try {
      while (hasPending(live.current.pending) && tries < RETRIES) {
        const sent = live.current.pending;
        const file = withPending(live.current.file, sent);
        try {
          etag.current = (await api.saveCanvas(etag.current, file)).etag;
          hold({ ...live.current, file, pending: afterSave(live.current.pending, sent) });
          tries = 0;
        } catch (error) {
          const current = error instanceof ApiError ? error.details?.current : undefined;
          if (error instanceof ApiError && error.code === "ETAG_CONFLICT" && current) {
            // Saved from elsewhere: theirs is the new base, and what this page changed goes over it.
            const theirs = current as { etag?: string | null; canvas?: unknown };
            etag.current = theirs.etag ?? null;
            hold({ ...live.current, file: readCanvas(theirs.canvas) });
            tries++;
          } else {
            notice.current(describe(error));
            break;
          }
        }
      }
    } finally {
      saving.current = false;
    }
  }, [hold]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_AFTER);
  }, [flush]);

  // A page going out of sight writes what it holds at once.
  useEffect(() => {
    const now = () => document.visibilityState === "hidden" && void flush();
    document.addEventListener("visibilitychange", now);
    window.addEventListener("pagehide", now);
    return () => {
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("pagehide", now);
      void flush();
    };
  }, [flush]);

  useEffect(() => setSteps({ past: [], future: [] }), [workspace]);
  // Read on open and whenever the workspace moves on, unless our own write is on its way.
  useEffect(() => {
    if (saving.current) return;
    let current = true;
    api
      .canvas()
      .then((r) => {
        if (!current || saving.current) return;
        if (live.current.ready && r.etag === etag.current) return;
        etag.current = r.etag;
        hold({ ...live.current, workspace, file: readCanvas(r.canvas), ready: true });
        if (hasPending(live.current.pending)) schedule();
      })
      .catch((error: unknown) => current && notice.current(describe(error)));
    return () => {
      current = false;
    };
  }, [workspace, revision, hold, schedule]);

  const shown = useMemo(() => withPending(state.file, state.pending), [state.file, state.pending]);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const ink = useMemo(() => inkOf(shown.drawings), [shown.drawings]);
  const inkNow = useRef(ink);
  inkNow.current = ink;
  /** A change made here, kept with what turns it back. */
  const step = useCallback((redo: Pending, picks?: Picks) => {
    const undo = inverseOf(shownNow.current, redo);
    setSteps((s) => ({ past: [...s.past.slice(-(DEPTH - 1)), { undo, redo, picks }], future: [] }));
  }, []);

  const change = useCallback(
    (update: (p: Pending) => Pending) => {
      hold({ ...live.current, pending: update(live.current.pending) });
      schedule();
    },
    [hold, schedule],
  );
  const commit = useCallback(
    (next: Ink[] | ((current: Ink[]) => Ink[]), picks?: Picks) => {
      if (!live.current.ready) return;
      const before = inkNow.current;
      const after = typeof next === "function" ? next(before) : next;
      if (after === before) return;
      const redo = onlyDrawings(inkChanges(before, after));
      if (!hasPending(redo)) return;
      step(redo, picks);
      change((p) => laidOver(p, redo));
    },
    [change, step],
  );
  const keep = useCallback(
    (changes: Map<string, Ink | null>) => {
      if (live.current.ready && changes.size) change((p) => laidOver(p, onlyDrawings(changes)));
    },
    [change],
  );
  const undo = useCallback(() => {
    const last = steps.past.at(-1);
    if (!live.current.ready || !last) return null;
    setSteps({ past: steps.past.slice(0, -1), future: [last, ...steps.future] });
    change((p) => laidOver(p, last.undo));
    return last.picks?.before ?? [];
  }, [change, steps]);
  const redo = useCallback(() => {
    const next = steps.future[0];
    if (!live.current.ready || !next) return null;
    setSteps({ past: [...steps.past, next], future: steps.future.slice(1) });
    change((p) => laidOver(p, next.redo));
    return next.picks?.after ?? [];
  }, [change, steps]);

  const arrange = useCallback<CanvasStore["arrange"]>(
    ({ positions = {}, regions = {} }) => {
      const redo: Pending = {
        ...noPending(),
        positions: new Map(Object.entries(positions)),
        regions: new Map(Object.entries(regions)),
      };
      step(redo);
      change((p) => laidOver(p, redo));
    },
    [change, step],
  );

  return {
    ink,
    ready: state.ready,
    commit,
    keep,
    undo,
    redo,
    canUndo: steps.past.length > 0,
    canRedo: steps.future.length > 0,
    positions: shown.positions,
    regions: shown.regions,
    arrange,
  };
}

type Step = { undo: Pending; redo: Pending; picks?: Picks };
const onlyDrawings = (changes: Map<string, Ink | null>): Pending => ({
  ...noPending(),
  drawings: changes,
});
