import { createContext, useContext, useEffect, useState } from "react";
import { ApiError, api, changes } from "./api.js";
import type { SyncFlags } from "./types.js";

const NONE: SyncFlags = {};

/** The page's current flags, for panels below the App. */
export const FlagsContext = createContext<SyncFlags>(NONE);
export const useFlags = () => useContext(FlagsContext);

/**
 * Ahead and behind Nodes. Reread when the page opens, regains focus, saves, or the workspace revision
 * moves; not on a timer, because each read compares every material. A service without the endpoint
 * leaves the map unmarked.
 */
export function useSyncFlags(revision: string | undefined): SyncFlags {
  const [flags, setFlags] = useState<SyncFlags>(NONE);
  useEffect(() => {
    if (!revision) return;
    let stopped = false,
      busy = false,
      again = false;
    const read = async () => {
      if (stopped || document.hidden) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const { nodes } = await api.sync();
        if (!stopped) setFlags(nodes);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 401))
          stopped = true;
      } finally {
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
    return () => {
      stopped = true;
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
      changes.removeEventListener("change", read);
    };
  }, [revision]);
  return flags;
}
