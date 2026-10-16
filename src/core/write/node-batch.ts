import type { FsAdapter } from "../store/adapter.js";
import { ContextReader, ReaderError } from "../graph/context-reader.js";
import { loadNodeCatalog, readCatalogDocument } from "../graph/node-catalog.js";
import { nodeNotePath } from "../base/paths.js";
import { uncapturedChecker } from "../graph/retained-read.js";
import { isOutputNode } from "../graph/node-sync-record.js";
import { readOutputChanges } from "../graph/node-sync.js";

/** One header scan; each requested body is read exactly once. */
export async function prepareNodeBatch(
  fs: FsAdapter,
  workspaceId: string,
  options: { uncaptured?: boolean } = {},
) {
  const source = { kind: "live" as const, workspaceId };
  const catalog = await loadNodeCatalog(fs);
  const uncaptured = options.uncaptured ? await uncapturedChecker(fs) : undefined;
  const read = async (nodeId: string, view: "body" | "raw") => {
    const node = catalog.byId.get(nodeId);
    if (!node) throw new ReaderError("NOT_FOUND", `Node is not readable in this source: ${nodeId}`);
    const document = await readCatalogDocument(fs, node);
    const item = new ContextReader(source, [document], [nodeId]).read({ nodeId, view });
    if (!("text" in item)) throw new Error("Body/raw selection was not delivered");
    const changedSince = isOutputNode(item) ? await readOutputChanges(fs, nodeId) : undefined;
    return {
      document,
      view,
      item: {
        ...item,
        ...(changedSince ? { changedSince } : {}),
        ...(uncaptured?.(nodeNotePath(document.path), document.raw)
          ? { uncaptured: true as const }
          : {}),
      },
    };
  };
  return { source, read };
}
