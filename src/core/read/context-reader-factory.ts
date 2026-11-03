import {
  ContextReader,
  ReaderError,
  type ReaderDocument,
  type ReaderSource,
} from "../graph/context-reader.js";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { loadTent, type LoadedTent } from "../store/tree.js";
import { contentEtag } from "../base/etag.js";
import { nodeNotePath } from "../base/paths.js";
import { canonicalSha256 } from "../base/canonical-digest.js";
import { listWorkspaceRelations } from "../graph/workspace-relations.js";

function treeRevision(tent: LoadedTent) {
  return canonicalSha256({
    roots: tent.roots.map((n) => n.id),
    documents: [...tent.byPath.values()].map((n) => ({
      id: n.id,
      path: n.path,
      etag: n.etag,
      parent: n.parent?.id,
      children: n.children.map((c) => c.id),
      status: n.status,
      invalid: n.invalid,
    })),
  });
}

/** 查询不能触发 loader 的损坏恢复写入；正式恢复仍由原入口负责。 */
export async function liveContextReader(
  fs: FsAdapter,
  source: Extract<ReaderSource, { kind: "live" }>,
  options: { relations?: boolean } = {},
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
      status: node.status,
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
    options.relations ? await listWorkspaceRelations(readonlyFs) : undefined,
  );
}
