import type { FsAdapter } from "./adapter.js";

function requireHistory(fs: FsAdapter) {
  if (!fs.history) throw new Error("Tent Git history is unavailable");
  return fs.history;
}

/** Stable identity, including prior locations and deletion records. */
export function listNodeVersions(fs: FsAdapter, nodeId: string) {
  return requireHistory(fs).nodeVersions(nodeId);
}

/** A chronological, complete change range: from exclusive, to inclusive. */
export function listHistoryChanges(fs: FsAdapter, input: { from?: string; to?: string } = {}) {
  return requireHistory(fs).changesInRange(input);
}
