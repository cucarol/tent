import {
  ContextReader,
  ReaderError,
  type ReaderDocument,
  type ReaderSource,
} from "./context-reader.js";
import { readOnlyFs, type FsAdapter } from "./adapter.js";
import { loadTent, type LoadedTent } from "./tree.js";
import { contentEtag } from "./etag.js";
import { nodeNotePath } from "./paths.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { loadNodeCatalog, readCatalogDocument } from "./node-catalog.js";

/** Selected reads observe only headers elsewhere in the graph, never unrelated bodies. */
export async function selectedContextReader(
  fs: FsAdapter,
  source: Extract<ReaderSource, { kind: "live" }>,
  nodeIds: readonly string[],
) {
  const catalog = await loadNodeCatalog(fs);
  const documents: ReaderDocument[] = [];
  for (const nodeId of new Set(nodeIds)) {
    const node = catalog.byId.get(nodeId);
    if (!node) throw new ReaderError("NOT_FOUND", `Node is not readable in this source: ${nodeId}`);
    documents.push(await readCatalogDocument(fs, node));
  }
  return new ContextReader(source, documents, catalog.rootNodeIds);
}

function treeRevision(tent: LoadedTent) {
  return canonicalSha256({
    roots: tent.roots.map((n) => n.id),
    documents: [...tent.byPath.values()].map((n) => ({
      id: n.id,
      path: n.path,
      etag: n.etag,
      parent: n.parent?.id,
      children: n.children.map((c) => c.id),
      archived: n.archived,
      invalid: n.invalid,
    })),
  });
}

/** 查询不能触发 loader 的损坏恢复写入；正式恢复仍由原入口负责。 */
export async function liveContextReader(
  fs: FsAdapter,
  source: Extract<ReaderSource, { kind: "live" }>,
) {
  const readonlyFs = readOnlyFs(fs);
  const tent = await loadTent(readonlyFs);
  const documents: ReaderDocument[] = [];
  for (const node of tent.byPath.values()) {
    const raw = await readonlyFs.readFile(nodeNotePath(node.path));
    if (contentEtag(raw) !== node.etag)
      throw new ReaderError("SOURCE_CHANGED", "Node changed during reader materialization; retry");
    documents.push({
      nodeId: node.id,
      name: node.name,
      path: node.path,
      type: node.type,
      etag: node.etag,
      raw,
      archived: node.archived,
      invalid: node.invalid,
      parentNodeId: node.parent?.id ?? null,
      childNodeIds: node.children.map((n) => n.id),
    });
  }
  if (treeRevision(tent) !== treeRevision(await loadTent(readonlyFs)))
    throw new ReaderError("SOURCE_CHANGED", "Graph changed during reader materialization; retry");
  return new ContextReader(
    source,
    documents,
    tent.roots.map((n) => n.id),
  );
}
