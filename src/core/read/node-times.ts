import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { isNodeId } from "../base/id.js";
import { nodeNotePath } from "../base/paths.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { ReaderError } from "../graph/context-reader.js";
import { loadNodeCatalog, readCatalogDocument } from "../graph/node-catalog.js";
import { nodeDeclaredContent, readNodeBodyHistory } from "./node-body-history.js";

export type NodeTimes = {
  nodeId: string;
  /** Time of the latest retained body or material-address change; null when unknown. */
  contentChangedAt: string | null;
};

/** On-demand prose times; never capture documents or observe material content. */
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
  const history = await readNodeBodyHistory(fs);
  const times = new Map<string, string | null>();
  for (const event of history?.events ?? [])
    for (const change of event.changes) {
      const { before, after } = change;
      if (!after || before === undefined) times.set(change.nodeId, null);
      else if (before === null || before.declaredContent !== after.declaredContent)
        times.set(change.nodeId, event.time);
    }
  return documents.map((document) => {
    const saved = history?.latest.get(document.nodeId);
    const at = times.get(document.nodeId);
    const { data, body } = parseFrontmatter(document.raw);
    return {
      nodeId: document.nodeId,
      contentChangedAt:
        at &&
        saved &&
        nodeDeclaredContent(
          data,
          body,
          nodeNotePath(document.path),
          catalog.byId,
          fs.workspaceRoot,
        ) === saved.declaredContent
          ? at
          : null,
    };
  });
}
