import type { FsAdapter } from "./adapter.js";

function requireHistory(fs: FsAdapter) {
  if (!fs.history) throw new Error("Tent Git history is unavailable");
  return fs.history;
}

/** A chronological, complete change range: from exclusive, to inclusive. */
export function listHistoryChanges(fs: FsAdapter, input: { from?: string; to?: string } = {}) {
  return requireHistory(fs).changesInRange(input);
}
