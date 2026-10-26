import { hasDocumentHistory } from "../store/history-port.js";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import type { DocumentVersion, HistoryCommit } from "../store/history-port.js";
import { isNodeId } from "../base/id.js";
import { nodeNotePath } from "../base/paths.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { nodeVerifications, okfTimestampSchema } from "../base/node-provenance.js";
import { ReaderError } from "../graph/context-reader.js";
import { loadNodeCatalog, readCatalogDocument } from "../graph/node-catalog.js";
import { nodeSemanticFingerprint } from "../graph/node-sync-record.js";

export type NodeTimes = {
  nodeId: string;
  /** Time of the latest retained body/material-address change; null when it cannot be established. */
  contentChangedAt: string | null;
  /** Latest declared generation or confirmation of a current output; not its completion time. */
  recordedAt: string | null;
};

function recordedAt(data: Record<string, unknown>): string | null {
  if (data.type !== "output") return null;
  const times: number[] = [];
  const generated = okfTimestampSchema.safeParse((data.generated as { at?: unknown })?.at);
  if (generated.success) times.push(Date.parse(generated.data));
  for (const entry of Array.isArray(data.verified) ? data.verified : [data.verified]) {
    try {
      times.push(...nodeVerifications({ verified: [entry] }).map(({ at }) => Date.parse(at)));
    } catch {
      // One invalid declaration cannot erase another valid confirmation time.
    }
  }
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** On-demand times for selected Nodes; no capture, acknowledgement or material observation. */
export async function readNodeTimes(
  fs: FsAdapter,
  nodeIds: readonly string[],
): Promise<NodeTimes[]> {
  if (!Array.isArray(nodeIds) || nodeIds.some((id) => !isNodeId(id)))
    throw new ReaderError("INVALID_INPUT", "Expected canonical Node ids");
  if (!nodeIds.length) return [];
  fs = readOnlyFs(fs);
  const catalog = await loadNodeCatalog(fs);
  const selected = [...new Set(nodeIds)].map((nodeId) => {
    const node = catalog.byId.get(nodeId);
    if (!node) throw new ReaderError("NOT_FOUND", `Node not found: ${nodeId}`);
    return node;
  });
  const documents = await Promise.all(selected.map((node) => readCatalogDocument(fs, node)));
  const result = documents.map(({ nodeId, raw }) => ({
    nodeId,
    contentChangedAt: null as string | null,
    recordedAt: recordedAt(parseFrontmatter(raw).data),
  }));
  if (!fs.history || !(await hasDocumentHistory(fs))) return result;
  let events: HistoryCommit[];
  try {
    events = await fs.history.changesInRange();
  } catch {
    return result;
  }
  const wanted = new Set(nodeIds);
  const key = (v: DocumentVersion) => `${v.commit}:${v.path}`;
  const versions = [
    ...new Map(
      events.flatMap((event) =>
        event.changes.flatMap((change) =>
          change.objectId && wanted.has(change.objectId)
            ? [change.before, change.after].flatMap((v) => (v ? [[key(v), v] as const] : []))
            : [],
        ),
      ),
    ).values(),
  ];
  let bytes: Map<string, string | Error>;
  try {
    const reads = await fs.history.readVersions(versions);
    bytes = new Map(
      versions.map((v, i) => [key(v), reads[i] instanceof Error ? reads[i] : reads[i]!.raw]),
    );
  } catch {
    return result;
  }
  // Identity paths on both sides of each commit keep move-induced link rewrites semantic no-ops.
  const paths = new Map<string, { nodeId: string; path: string }>();
  const latest = new Map<string, { fingerprint: string | null; time: string | null }>();
  const fingerprint = (id: string, version: DocumentVersion | undefined, at: typeof paths) => {
    if (!version) return null;
    const raw = bytes.get(key(version));
    if (typeof raw !== "string") return null;
    try {
      const { data, body } = parseFrontmatter(raw);
      if (data.id !== id) return null;
      return nodeSemanticFingerprint(data, body, version.path, at, fs.workspaceRoot);
    } catch {
      return null;
    }
  };
  for (const event of events) {
    const changes = event.changes.filter(
      (change) => change.objectId && wanted.has(change.objectId),
    );
    const before = new Map(
      changes.map((change) => [
        change.objectId!,
        fingerprint(change.objectId!, change.before, paths),
      ]),
    );
    for (const change of event.changes) {
      const id = change.objectId;
      if (!id || !isNodeId(id)) continue;
      if (change.after)
        paths.set(id, {
          nodeId: id,
          path: change.after.path.slice(0, change.after.path.lastIndexOf("/")),
        });
      else paths.delete(id);
    }
    for (const change of changes) {
      const id = change.objectId!;
      const previous = before.get(id)!;
      const next = fingerprint(id, change.after, paths);
      const knownChange =
        next !== null && (!change.before || (previous !== null && previous !== next));
      latest.set(id, {
        fingerprint: next,
        time: knownChange
          ? event.time
          : next !== null && previous === next
            ? (latest.get(id)?.time ?? null)
            : null,
      });
    }
  }
  for (const [i, document] of documents.entries()) {
    const saved = latest.get(document.nodeId);
    if (!saved?.time) continue;
    const { data, body } = parseFrontmatter(document.raw);
    // Native edits have no trustworthy edit time until an explicit capture boundary retains them.
    if (
      nodeSemanticFingerprint(
        data,
        body,
        nodeNotePath(document.path),
        catalog.byId,
        fs.workspaceRoot,
      ) === saved.fingerprint
    )
      result[i]!.contentChangedAt = saved.time;
  }
  return result;
}
