import type { Graph } from "./store.js";
import type { NodeRelationsDetails, SnapshotRef } from "./types.js";
import { resolveHref } from "../util.js";

/** Resolve a document from the map or the selected Node's checked outgoing references. */
export function documentRef(
  graph: Graph,
  fromPath: string,
  href: string,
  relations?: NodeRelationsDetails | null,
): SnapshotRef | null {
  const path = resolveHref(fromPath, href).tentPath;
  if (!path) return null;
  const mapped = graph.snapshot.paths[path];
  if (mapped && graph.exists(mapped)) return mapped;
  if (graph.detailed) return null;
  const ref = relations?.links.find(
    (link) => resolveHref(fromPath, link.href).tentPath === path,
  )?.ref;
  return ref &&
    ref.kind !== "node" &&
    relations?.refs.some((known) => known.kind === ref.kind && known.id === ref.id && known.exists)
    ? ref
    : null;
}
