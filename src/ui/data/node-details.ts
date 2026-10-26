import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DetailsContext } from "./details.js";

/** The existing workspace revision check also refreshes open Node sections. */
export const LiveRevisionContext = createContext<string | undefined>(undefined);

export function NodeDetailsProvider({
  revision,
  wantDetails,
  children,
}: {
  revision: string | undefined;
  wantDetails: () => void;
  children: ReactNode;
}) {
  return createElement(
    LiveRevisionContext.Provider,
    { value: revision },
    createElement(DetailsContext.Provider, { value: wantDetails }, children),
  );
}

export type NodeSection<T> = {
  data: T | null;
  error: unknown;
  retry: () => void;
};

/** A replaced observation cannot publish a late success or failure. */
export function sectionObservation<T>(
  load: () => Promise<T>,
  accept: (value: T) => void,
  fail: (error: unknown) => void,
) {
  let live = true;
  load().then(
    (value) => live && accept(value),
    (error) => live && fail(error),
  );
  return () => {
    live = false;
  };
}

/** One mounted section, without a cache or another revision poller. */
export function useNodeSection<T>(
  nodeId: string,
  load: (id: string) => Promise<T>,
  active = true,
): NodeSection<T> {
  const revision = useContext(LiveRevisionContext);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([nodeId, revision, attempt, active]);
  const current = useRef(key);
  current.current = key;
  const [read, setRead] = useState<{ key: string; data: T | null; error: unknown } | null>(null);
  useEffect(() => {
    if (!active) return;
    return sectionObservation(
      () => load(nodeId),
      (data) => current.current === key && setRead({ key, data, error: null }),
      (error) => current.current === key && setRead({ key, data: null, error }),
    );
  }, [key, nodeId, load, active]);
  return {
    data: read?.key === key ? read.data : null,
    error: read?.key === key ? read.error : null,
    retry: () => setAttempt((a) => a + 1),
  };
}

/** The section's last settled read for the same Node while a newer read is still on its way. */
export function useHeldSection<T>(nodeId: string, section: NodeSection<T>): NodeSection<T> {
  const held = useRef<{ nodeId: string; section: NodeSection<T> } | null>(null);
  return heldSection(held, nodeId, section);
}

export function heldSection<T>(
  held: { current: { nodeId: string; section: NodeSection<T> } | null },
  nodeId: string,
  section: NodeSection<T>,
): NodeSection<T> {
  if (section.data !== null || section.error) held.current = { nodeId, section };
  else if (held.current?.nodeId === nodeId)
    return { ...held.current.section, retry: section.retry };
  return section;
}
