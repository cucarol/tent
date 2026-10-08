import { readOnlyFs, type FsAdapter } from "./adapter.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isHistoryDocument } from "./document-history.js";
import { nodeNotePath } from "./paths.js";
import { loadTent } from "./tree.js";
import {
  ReaderError,
  nodeSummary,
  readerResult,
  navigationIds,
  type ReaderDocument,
  type ReaderSource,
  type ReaderRelations,
} from "./context-reader.js";
import { documentLifecycle } from "./document-status.js";
import { contentEtag } from "./etag.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { normalizeNodeTags } from "./tags.js";

/** A header observation is navigation data, never a full-document edit token. */
export type CatalogNode = {
  nodeId: string;
  name: string;
  path: string;
  type?: string;
  header: string;
  archived: boolean;
  invalid: boolean;
  parentNodeId: string | null;
  childNodeIds: string[];
};

export function documentHeader(raw: string): string {
  const { body } = parseFrontmatter(raw);
  return raw.slice(0, raw.length - body.length);
}

export async function readCatalogDocument(
  fs: FsAdapter,
  node: CatalogNode,
): Promise<ReaderDocument> {
  const raw = await fs.readFile(nodeNotePath(node.path));
  let matchesHeader = false;
  try {
    matchesHeader = documentHeader(raw) === node.header;
  } catch {
    /* This header was valid during lookup; a parse failure now is also a change. */
  }
  if (!matchesHeader)
    throw new ReaderError("SOURCE_CHANGED", "Node metadata changed during lookup; retry");
  const { header: _header, ...metadata } = node;
  return { ...metadata, raw, etag: contentEtag(raw) };
}

/** Fresh metadata scan; uses the same hierarchy, duplicate-ID and archive rules as mutations. */
export async function loadNodeCatalog(fs: FsAdapter) {
  const headers = new Map<string, string>();
  const readonly = readOnlyFs(fs);
  const headerFs = new Proxy(readonly, {
    get(target, key) {
      if (key === "readFile")
        return async (path: string) => {
          if (!isHistoryDocument(path)) return target.readFile(path);
          // Invalid YAML must still reach the tree loader for quarantine.
          let header: string;
          if (target.readFrontmatter) header = await target.readFrontmatter(path);
          else {
            header = await target.readFile(path);
            try {
              header = documentHeader(header);
            } catch {
              /* preserve malformed header */
            }
          }
          headers.set(path, header);
          return header;
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const tree = await loadTent(headerFs);
  const nodes: CatalogNode[] = [...tree.byPath.values()].map((node) => ({
    nodeId: node.id,
    name: node.name,
    path: node.path,
    type: node.type,
    header: headers.get(nodeNotePath(node.path))!,
    archived: node.archived,
    invalid: node.invalid,
    parentNodeId: node.parent?.id ?? null,
    childNodeIds: node.children.map((child) => child.id),
  }));
  const rootNodeIds = tree.roots.map((node) => node.id);
  return {
    tree,
    rootNodeIds,
    byPath: new Map(nodes.map((node) => [node.path, node])),
    byId: new Map(nodes.filter((node) => !node.invalid).map((node) => [node.nodeId, node])),
  };
}

type NodeCatalog = Awaited<ReturnType<typeof loadNodeCatalog>>;
function requireCatalogNode(catalog: NodeCatalog, nodeId: string) {
  const node = catalog.byId.get(nodeId);
  if (!node) throw new ReaderError("NOT_FOUND", `Node is not readable in this source: ${nodeId}`);
  return node;
}
function summarize(node: CatalogNode) {
  const { data } = parseFrontmatter(node.header);
  return {
    ...nodeSummary({
      ...node,
      type: typeof data.type === "string" ? data.type : node.type,
      // The same tag set that `node tags` counts, so every counted tag can be filtered.
      tags: normalizeNodeTags(data.tags),
      description: typeof data.description === "string" ? data.description : undefined,
    }),
    ...documentLifecycle(data),
  };
}

export function catalogSummary(catalog: NodeCatalog, source: ReaderSource, nodeId: string) {
  const node = requireCatalogNode(catalog, nodeId);
  return { source, ...summarize(node), view: "summary" as const, archived: node.archived };
}

/** Hierarchy navigation depends on headers and order, never on full-document ETags. */
export function catalogRelations(catalog: NodeCatalog, source: ReaderSource, p: ReaderRelations) {
  if (p.direction !== "parent" && p.direction !== "children")
    throw new Error("Catalog navigation only supports parent and children");
  const node = p.nodeId === null ? undefined : requireCatalogNode(catalog, p.nodeId);
  const ids =
    p.direction === "parent"
      ? node?.parentNodeId
        ? [node.parentNodeId]
        : []
      : node
        ? node.childNodeIds
        : catalog.rootNodeIds;
  const visible = navigationIds(catalog.byId.values());
  const items = ids.flatMap((id) => {
    const child = catalog.byId.get(id);
    return child && (p.direction === "parent" || visible.has(id) || p.includeArchived)
      ? [summarize(child)]
      : [];
  });
  const revision = canonicalSha256({
    rootNodeIds: catalog.rootNodeIds,
    nodes: [...catalog.byId.values()],
  });
  return readerResult(
    source,
    revision,
    { nodeId: p.nodeId, direction: p.direction, includeArchived: p.includeArchived ?? false },
    items,
  );
}

/**
 * Matching Nodes anywhere below a parent (default: the Workspace root), in
 * tree order. Every requested tag must be present; deprecated Nodes need
 * includeArchived.
 */
export function catalogMatches(
  catalog: NodeCatalog,
  source: ReaderSource,
  p: {
    parentNodeId?: string | null;
    includeArchived?: boolean;
    type?: string;
    tags?: readonly string[];
  },
) {
  const tags = p.tags ?? [];
  const items: ReturnType<typeof summarize>[] = [];
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      const node = catalog.byId.get(id);
      if (!node) continue;
      const summary = summarize(node);
      if (
        (p.includeArchived || !node.archived) &&
        (p.type === undefined || summary.type === p.type) &&
        tags.every((tag) => summary.tags.includes(tag))
      )
        items.push(summary);
      visit(node.childNodeIds);
    }
  };
  visit(
    p.parentNodeId ? requireCatalogNode(catalog, p.parentNodeId).childNodeIds : catalog.rootNodeIds,
  );
  const revision = canonicalSha256({
    rootNodeIds: catalog.rootNodeIds,
    nodes: [...catalog.byId.values()],
  });
  return readerResult(
    source,
    revision,
    {
      parentNodeId: p.parentNodeId ?? null,
      includeArchived: p.includeArchived ?? false,
      ...(p.type === undefined ? {} : { type: p.type }),
      ...(tags.length ? { tags: [...tags] } : {}),
    },
    items,
  );
}
