import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ApiError, api, changes } from "./api.js";
import type { Snapshot, SyncFlags } from "./types.js";

const NONE: SyncFlags = {};
/** How often a visible page compares materials again. */
export const SYNC_EVERY = 30_000;
/** Before the first read: no flags yet, but not known to be in sync either. */
export const UNREAD: SyncFlags = {};

/** The page's current flags, for panels below the App. */
export const FlagsContext = createContext<SyncFlags>(NONE);
export const useFlags = () => useContext(FlagsContext);

/**
 * Ahead and behind Nodes. Reread when the page opens, regains focus, saves, or the workspace revision
 * moves, and every `SYNC_EVERY` while visible: a material edited outside Tent leaves the revision as it
 * was. Each read compares every material (seconds on a large workspace), so the timer is slower than
 * the revision check and never queues behind a read in flight. A service without the endpoint leaves
 * the map unmarked.
 */
export function useSyncFlags(revision: string | undefined): SyncFlags {
  const [flags, setFlags] = useState<SyncFlags>(UNREAD);
  const reader = useRef<ReturnType<typeof watchSyncFlags> | null>(null);
  useEffect(() => {
    const watching = watchSyncFlags(setFlags);
    reader.current = watching;
    return () => watching.stop();
  }, []);
  useEffect(() => {
    if (revision) reader.current?.atRevision(revision);
  }, [revision]);
  return flags;
}

/** Keep one read in flight, including the read started before the first snapshot arrives. */
export function watchSyncFlags(publish: (flags: SyncFlags) => void) {
  let stopped = false,
    busy = false,
    again = false,
    first = true,
    ready = false;
  let revision: string | undefined;
  let initial: Awaited<ReturnType<typeof api.sync>> | undefined;
  const publishInitial = () => {
    if (!initial || initial.revision !== revision) return;
    publish(initial.nodes);
    initial = undefined;
    ready = true;
  };
  const read = async () => {
    if (stopped || document.hidden) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const result = await api.sync();
      if (!stopped) {
        if (ready) publish(result.nodes);
        else {
          initial = result;
          publishInitial();
          // A write between the two startup reads still needs a fresh material comparison.
          if (first && revision && !ready) again = true;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 401))
        stopped = true;
    } finally {
      first = false;
      busy = false;
      if (again) {
        again = false;
        void read();
      }
    }
  };
  void read();
  const timer = setInterval(() => {
    if (!busy) void read();
  }, SYNC_EVERY);
  window.addEventListener("focus", read);
  document.addEventListener("visibilitychange", read);
  changes.addEventListener("change", read);
  return {
    atRevision(next: string) {
      if (stopped || next === revision) return;
      const previous = revision;
      revision = next;
      publishInitial();
      if (previous || (!first && !ready)) void read();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
      changes.removeEventListener("change", read);
    },
  };
}

/**
 * The snapshot's Card progress and completions were derived from materials as they stood when it was
 * built; a later material change outside Tent does not move the revision. Returns a key for the
 * disagreement, so each one asks for one rebuild, or null when the snapshot agrees with the flags.
 */
export function snapshotDisagrees(snapshot: Snapshot, flags: SyncFlags): string | null {
  if (flags === UNREAD) return null;
  const behind = (id: string) => !!flags[id]?.behind;
  const stale =
    snapshot.cards.some(
      (c) =>
        c.outputNodeIds.some(behind) || (c.reviewOutputNodeIds ?? []).some((id) => !behind(id)),
    ) || snapshot.nodes.some((n) => n.outputAt && behind(n.id));
  if (!stale) return null;
  const marked = Object.keys(flags).filter(behind).sort();
  return `${snapshot.workspace.revision}:${marked.join(",")}`;
}

/**
 * Follows `snapshotDisagrees`: asks for one rebuilt snapshot per disagreement and applies it only while
 * the page still shows that revision; a newer revision brings its own snapshot.
 */
export function snapshotRebuilder(
  apply: (update: (current: Snapshot | null) => Snapshot | null) => void,
) {
  let asked: string | null = null;
  return (snapshot: Snapshot | null, flags: SyncFlags) => {
    const key = snapshot && snapshotDisagrees(snapshot, flags);
    if (!key || key === asked) return;
    asked = key;
    api
      .freshSnapshot()
      .then((fresh) =>
        apply((current) =>
          current?.workspace.revision === fresh.workspace.revision ? fresh : current,
        ),
      )
      .catch(() => {});
  };
}
