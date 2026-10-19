import { createContext, useContext, useEffect } from "react";

/**
 * Reads the full snapshot only once something on the page needs what it holds: a page opened, the Role
 * list, a region's relations, search, the lens or the timeline. Asks while a read is on its way share it;
 * after a read has arrived, asking does nothing. A failed read is told once and the details stay unread:
 * the next ask, or `retry` (on focus), tries again.
 */
export function detailLoader<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  fail: (error: unknown) => void,
) {
  let state: "idle" | "loading" | "done" = "idle";
  let wanted = false;
  let stopped = false;
  const start = () => {
    state = "loading";
    load().then(
      (value) => {
        if (stopped) return;
        state = "done";
        apply(value);
      },
      (error) => {
        if (stopped) return;
        state = "idle";
        fail(error);
      },
    );
  };
  return {
    want() {
      wanted = true;
      if (state === "idle" && !stopped) start();
    },
    /** Tries again after a failure, if something asked; nothing before the first ask. */
    retry() {
      if (wanted && state === "idle" && !stopped) start();
    },
    stop() {
      stopped = true;
    },
  };
}

/** Asks for the full snapshot; the page provides it, a view without one asks nothing. */
export const DetailsContext = createContext<() => void>(() => {});

/** Asks for the details while `need` holds, as when the view showing them is open. */
export function useWantDetails(need: boolean) {
  const want = useContext(DetailsContext);
  useEffect(() => {
    if (need) want();
  }, [need, want]);
  return want;
}
