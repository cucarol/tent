// Keeps the map's canvas file: read from the workspace through the service, changed here, and written back
// whole with its ETag. Every write takes the workspace lock and records a Tent version, so changes gather
// and go in one write once a drawing edit has been quiet for SAVE_AFTER, or when the page is hidden.
// Browsing folds and projected attachment positions stay in memory until the next drawing edit. A save from
// another page meanwhile is read back and this page's unsaved changes are laid over it, entry by entry.
// Undo and redo cover drawings and opened and closed topics. They live in
// this page, and each step turns back only the entries it changed, so what another page saved meanwhile
// stays. A step also keeps which drawings were picked on either side of it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describe } from "../data/api.js";
import {
  afterSave,
  canvasBase,
  emptyCanvas,
  inverseOf,
  laidOver,
  hasPending,
  foldEdit,
  noPending,
  withPending,
  type CanvasFile,
  type CanvasBase,
  type CanvasInitial,
  type Fold,
  type Pending,
} from "./canvas.js";
import { loadCanvas } from "./canvas-api.js";
import { inkChanges, inkOf, type Ink } from "./drawings.js";

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
  /** Cards opened past the default depth, and cards closed within it. */
  open: string[];
  shut: string[];
  /** The saved bytes were rejected; the current page began from the default view. */
  unreadable: boolean;
  /** Open or close topics as one step of undo; null restores the default fold. */
  arrange: (change: { folds?: Record<string, Fold | null> }, userAction?: boolean) => void;
};

/** Quiet time before changes are written. */
export const SAVE_AFTER = 2000;
/** Steps of undo kept per page. */
const DEPTH = 100;
/** Saves from elsewhere met in a row before giving up until the next change. */
const RETRIES = 3;

type Held = {
  workspace: string;
  file: CanvasFile;
  pending: Pending;
  ready: boolean;
  memory: Pending;
  unreadable: boolean;
};

export function useCanvas(
  workspace: string,
  revision: string,
  onNotice: (message: string) => void,
  initial: CanvasInitial,
): CanvasStore {
  const blank = (): Held => ({
    workspace,
    file: emptyCanvas(),
    pending: noPending(),
    ready: false,
    memory: noPending(),
    unreadable: false,
  });
  const [held, setHeld] = useState<Held>(() =>
    "file" in initial
      ? { ...blank(), file: initial.file, ready: true, unreadable: !!initial.unreadable }
      : blank(),
  );
  // Another workspace's canvas is never shown or written here: until this one is read, it is empty.
  const state = held.workspace === workspace ? held : blank();
  const live = useRef(state);
  live.current = state;
  const etag = useRef<string | null>("file" in initial ? initial.etag : null);
  const opening = useRef<{ workspace: string; revision: string } | null>({ workspace, revision });
  const openingErrorShown = useRef(false);
  const saving = useRef(false);
  // An unreadable concurrent file has no entries to merge. Only another real edit may replace it.
  const saveBlocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const [steps, setSteps] = useState<{ past: Step[]; future: Step[] }>({ past: [], future: [] });

  const hold = useCallback((next: Held) => {
    live.current = next;
    setHeld(next);
  }, []);

  const pause = useCallback(
    (base: CanvasBase) => {
      saveBlocked.current = true;
      etag.current = base.etag;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      hold({ ...live.current, file: base.file, unreadable: true });
    },
    [hold],
  );

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // A write on its way picks up whatever changed meanwhile before it finishes.
    if (saving.current || saveBlocked.current) return;
    if (!live.current.ready || !hasPending(live.current.pending)) return;
    saving.current = true;
    let tries = 0;
    try {
      while (!saveBlocked.current && hasPending(live.current.pending) && tries < RETRIES) {
        const sent = live.current.pending;
        const memory = live.current.memory;
        const file = withPending(live.current.file, laidOver(sent, memory));
        try {
          etag.current = (await api.saveCanvas(etag.current, file)).etag;
          hold({
            ...live.current,
            file,
            unreadable: false,
            pending: afterSave(live.current.pending, sent),
            memory: afterSave(live.current.memory, memory),
          });
          tries = 0;
        } catch (error) {
          const current = error instanceof ApiError ? error.details?.current : undefined;
          if (error instanceof ApiError && error.code === "ETAG_CONFLICT" && current) {
            // Saved from elsewhere: theirs is the new base, and what this page changed goes over it.
            const theirs = canvasBase(current as { etag: string | null; canvas?: unknown });
            if (theirs.unreadable) {
              pause(theirs);
              break;
            }
            etag.current = theirs.etag;
            hold({ ...live.current, file: theirs.file, unreadable: !!theirs.unreadable });
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
  }, [hold, pause]);

  const schedule = useCallback(() => {
    if (saveBlocked.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_AFTER);
  }, [flush]);

  // Keepalive also covers a save already in flight. A last edit must be sent on pagehide
  // even while that earlier request is running; a conflict merges over its result.
  useEffect(() => {
    const leave = () => {
      const state = live.current;
      if (saveBlocked.current || !state.ready || !hasPending(state.pending)) return;
      const pending = laidOver(state.pending, state.memory);
      const save = async () => {
        let file = state.file;
        let baseEtag = etag.current;
        for (let tries = 0; !saveBlocked.current && tries < RETRIES; tries++) {
          try {
            await api.saveCanvas(baseEtag, withPending(file, pending), true);
            return;
          } catch (error) {
            const current =
              error instanceof ApiError && error.code === "ETAG_CONFLICT"
                ? (error.details?.current as { etag: string | null; canvas?: unknown } | undefined)
                : undefined;
            if (!current) return;
            const theirs = canvasBase(current);
            if (theirs.unreadable) {
              pause(theirs);
              return;
            }
            baseEtag = current.etag;
            file = theirs.file;
          }
        }
      };
      void save();
    };
    const now = () => document.visibilityState === "hidden" && void flush();
    document.addEventListener("visibilitychange", now);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("pagehide", leave);
      void flush();
    };
  }, [flush, pause]);

  useEffect(() => {
    saveBlocked.current = false;
    setSteps({ past: [], future: [] });
  }, [workspace]);
  // Read on open and whenever the workspace moves on, unless our own write is on its way.
  useEffect(() => {
    if (saving.current) return;
    if (opening.current?.workspace === workspace && opening.current.revision === revision) {
      if ("error" in initial && !openingErrorShown.current) {
        openingErrorShown.current = true;
        notice.current(initial.error);
      }
      return;
    }
    opening.current = null;
    let current = true;
    loadCanvas()
      .then((r) => {
        if (!current || saving.current) return;
        if ("error" in r) {
          notice.current(r.error);
          return;
        }
        if (live.current.ready && r.etag === etag.current) return;
        // A refresh is no more consent to replace new unreadable bytes than a conflict is.
        if (r.unreadable && live.current.ready && hasPending(live.current.pending)) {
          pause(r);
          return;
        }
        etag.current = r.etag;
        hold({
          ...live.current,
          workspace,
          file: r.file,
          ready: true,
          unreadable: !!r.unreadable,
          memory: { folds: live.current.memory.folds, drawings: new Map() },
        });
        if (hasPending(live.current.pending)) schedule();
      })
      .catch((error: unknown) => current && notice.current(describe(error)));
    return () => {
      current = false;
    };
  }, [workspace, revision, hold, pause, schedule, initial]);

  const shown = useMemo(
    () => withPending(state.file, laidOver(state.pending, state.memory)),
    [state.file, state.pending, state.memory],
  );
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const ink = useMemo(() => inkOf(shown.drawings), [shown.drawings]);
  const inkNow = useRef(ink);
  inkNow.current = ink;
  /** A change made here, kept with what turns it back. */
  const step = useCallback((redo: Pending, picks?: Picks, persist = true) => {
    const undo = inverseOf(shownNow.current, redo);
    setSteps((s) => ({
      past: [...s.past.slice(-(DEPTH - 1)), { undo, redo, picks, persist }],
      future: [],
    }));
  }, []);

  const change = useCallback(
    (update: (p: Pending) => Pending, persist = true) => {
      hold(
        persist
          ? {
              ...live.current,
              pending: update(laidOver(live.current.pending, live.current.memory)),
              memory: noPending(),
            }
          : { ...live.current, memory: update(live.current.memory) },
      );
      if (persist) schedule();
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
      saveBlocked.current = false;
      step(redo, picks);
      change((p) => laidOver(p, redo));
    },
    [change, step],
  );
  const keep = useCallback(
    (changes: Map<string, Ink | null>) => {
      if (live.current.ready && changes.size)
        change((p) => laidOver(p, onlyDrawings(changes)), false);
    },
    [change],
  );
  const undo = useCallback(() => {
    const last = steps.past.at(-1);
    if (!live.current.ready || !last) return null;
    setSteps({ past: steps.past.slice(0, -1), future: [last, ...steps.future] });
    change((p) => laidOver(p, last.undo), last.persist);
    return last.picks?.before ?? [];
  }, [change, steps]);
  const redo = useCallback(() => {
    const next = steps.future[0];
    if (!live.current.ready || !next) return null;
    setSteps({ past: [...steps.past, next], future: steps.future.slice(1) });
    change((p) => laidOver(p, next.redo), next.persist);
    return next.picks?.after ?? [];
  }, [change, steps]);

  const arrange = useCallback<CanvasStore["arrange"]>(
    ({ folds = {} }, userAction = true) => {
      if (!live.current.ready) return;
      const { change: redo, persist: firstUnreadableEdit } = foldEdit(
        shownNow.current,
        folds,
        live.current.unreadable,
        userAction,
      );
      if (!hasPending(redo)) return;
      const persist = firstUnreadableEdit || (userAction && saveBlocked.current);
      if (userAction) saveBlocked.current = false;
      step(redo, undefined, persist);
      change((p) => laidOver(p, redo), persist);
    },
    [change, step],
  );

  return {
    ink,
    ready: state.ready,
    unreadable: state.unreadable,
    commit,
    keep,
    undo,
    redo,
    canUndo: steps.past.length > 0,
    canRedo: steps.future.length > 0,
    open: shown.open,
    shut: shown.shut,
    arrange,
  };
}

type Step = { undo: Pending; redo: Pending; picks?: Picks; persist: boolean };
const onlyDrawings = (changes: Map<string, Ink | null>): Pending => ({
  ...noPending(),
  drawings: changes,
});
