import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ApiError, api, changes } from "./api.js";
import type { SyncFlags } from "./types.js";

const NONE: SyncFlags = {};
/** Before the first read: no flags yet, but not known to be in sync either. */
export const UNREAD: SyncFlags = {};

/** The page's current flags, for panels below the App. */
export const FlagsContext = createContext<SyncFlags>(NONE);
export const useFlags = () => useContext(FlagsContext);

/**
 * Ahead and behind Nodes. Reread when the page opens, regains focus, saves, or the workspace revision
 * moves; not on a timer, because each read compares every material. A service without the endpoint
 * leaves the map unmarked.
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
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
      changes.removeEventListener("change", read);
    },
  };
}
