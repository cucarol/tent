import type { WorkspaceMap } from "../../core/read/workspace-map.js";
import type { Snapshot } from "./types.js";

/** One read per resource; hints during it collapse into one immediate follow-up. */
function readQueue<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  fail: (e: unknown) => void,
) {
  let stopped = false,
    running = false,
    pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    timer = undefined;
    if (stopped) return;
    pending = false;
    running = true;
    try {
      const value = await read();
      if (!stopped) apply(value);
    } catch (error) {
      if (!stopped) fail(error);
    } finally {
      running = false;
      if (pending && !stopped) void run();
    }
  };
  return {
    request(immediate = false) {
      if (stopped) return;
      pending = true;
      if (running || timer !== undefined) return;
      // Merge an idle burst without postponing follow-up reads behind a debounce window.
      if (immediate) void run();
      else timer = setTimeout(run, 20);
    },
    busy: () => running || timer !== undefined,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** The map never waits for revision or document details, including the first requested snapshot. */
export function workspaceRefresh(o: {
  map: () => Promise<WorkspaceMap>;
  snapshot: (revision?: string) => Promise<Snapshot | null>;
  revision: () => Promise<{ revision: string }>;
  applyMap: (map: WorkspaceMap) => void;
  applySnapshot: (snapshot: Snapshot) => void;
  applyRevision: (revision: string) => void;
  recovered: () => void;
  failed: (error: unknown) => boolean;
}) {
  let stopped = false,
    wanted = false,
    loaded = false;
  let fullRevision: string | undefined;
  let pollRequested = false;
  const failed = (error: unknown) => {
    if (o.failed(error)) stop();
  };
  const maps = readQueue(
    o.map,
    (m) => {
      o.applyMap(m);
      o.recovered();
    },
    (error) => {
      failed(error);
    },
  );
  const details = readQueue(
    () => o.snapshot(fullRevision),
    (s) => {
      if (s) {
        fullRevision = s.workspace.revision;
        loaded = true;
        o.applySnapshot(s);
      }
      o.recovered();
    },
    failed,
  );
  const revisions = readQueue(
    async () => {
      const poll = pollRequested;
      pollRequested = false;
      return { ...(await o.revision()), poll };
    },
    ({ revision, poll }) => {
      o.applyRevision(revision);
      // A hint has already queued map/details; its parallel revision only invalidates open sections.
      // Expiry and Workspace materials can change while the document revision stays the same.
      if (poll) maps.request();
      if (poll && wanted && revision !== fullRevision) details.request();
      o.recovered();
    },
    failed,
  );
  const stop = () => {
    stopped = true;
    maps.stop();
    details.stop();
    revisions.stop();
  };
  return {
    hint() {
      if (stopped) return;
      maps.request();
      if (wanted) details.request();
      revisions.request();
    },
    poll() {
      if (stopped) return;
      pollRequested = true;
      revisions.request(true);
    },
    want() {
      wanted = true;
      if (!loaded && !details.busy()) details.request(true);
    },
    stop,
  };
}
