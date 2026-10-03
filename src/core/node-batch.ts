import type { FsAdapter } from "./adapter.js";
import { ContextReader, ReaderError, type ReaderDocument } from "./context-reader.js";
import { captureReadDocuments } from "./document-history.js";
import { loadNodeCatalog, readCatalogDocument } from "./node-catalog.js";
import { nodeNotePath } from "./paths.js";
import { readerBatchSchema, type ReaderBatch } from "./reader-batch.js";

export type SelectedBatchDocument = { document: ReaderDocument; view: "body" | "raw" };

/** One header scan; each requested body is read exactly once. */
export async function prepareNodeBatch(fs: FsAdapter, workspaceId: string) {
  const source = { kind: "live" as const, workspaceId };
  const catalog = await loadNodeCatalog(fs);
  const read = async (nodeId: string, view: "body" | "raw") => {
    const node = catalog.byId.get(nodeId);
    if (!node) throw new ReaderError("NOT_FOUND", `Node is not readable in this source: ${nodeId}`);
    const document = await readCatalogDocument(fs, node);
    const item = new ContextReader(source, [document], [nodeId]).read({ nodeId, view });
    if (!("text" in item)) throw new Error("Body/raw selection was not delivered");
    return { document, view, item };
  };
  const capture = async (selected: SelectedBatchDocument[]) => {
    const versions = await captureReadDocuments(
      fs,
      selected.map(({ document }) => ({ path: nodeNotePath(document.path), raw: document.raw })),
    );
    const byPath = new Map(versions.map((version) => [version.path, version]));
    return selected.map(({ document, view }) => {
      const version = byPath.get(nodeNotePath(document.path));
      const item = new ContextReader(source, [document], [document.nodeId]).read(
        { nodeId: document.nodeId, view },
        version,
      );
      if (!("text" in item)) throw new Error("Body/raw selection was not delivered");
      return item;
    });
  };
  return { source, read, capture };
}

/** Core returns all requested documents; CLI callers select their own page. */
export async function readNodeBatch(fs: FsAdapter, workspaceId: string, input: ReaderBatch) {
  const request = readerBatchSchema.parse(input);
  const prepared = await prepareNodeBatch(fs, workspaceId);
  const selected = [];
  for (const nodeId of request.nodeIds) selected.push(await prepared.read(nodeId, request.view));
  const items = request.capture
    ? await prepared.capture(selected)
    : selected.map((entry) => entry.item);
  return { workspaceId, source: prepared.source, items };
}
