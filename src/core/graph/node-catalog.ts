import type { FsAdapter } from "../store/adapter.js";
import { isHistoryDocument } from "../store/document-history.js";
import { nodeNotePath } from "../base/paths.js";
import { loadTent } from "../store/tree.js";
import { type DocumentStatus } from "../base/document-status.js";

/** A header observation is navigation data, never a full-document edit token. */
export type CatalogNode = {
  nodeId: string;
  name: string;
  path: string;
  type?: string;
  header: string;
  status: DocumentStatus | null;
  invalid: boolean;
  parentNodeId: string | null;
  childNodeIds: string[];
};

export function documentHeader(raw: string): string {
  const opening = /^(\uFEFF)?---[\t ]*(\r?\n)/.exec(raw);
  if (!opening) return "";
  const fence = /^---[\t ]*(?:\r?\n|$)/gm;
  fence.lastIndex = opening[0].length;
  const closing = fence.exec(raw);
  if (!closing) throw new Error("Unterminated frontmatter fence");
  return raw.slice(0, closing.index + closing[0].length);
}

/** Fresh metadata scan; uses the same hierarchy, duplicate-ID and archive rules as mutations. */
export async function loadNodeCatalog(fs: FsAdapter) {
  const run = () => loadCatalogInScope(fs);
  return fs.observationScope(run);
}

async function loadCatalogInScope(fs: FsAdapter) {
  const headers = new Map<string, string>();
  const headerFs = new Proxy(fs, {
    get(target, key) {
      if (key === "readFile")
        return async (path: string) => {
          if (!isHistoryDocument(path)) return target.readFile(path);
          // Invalid YAML must still reach the tree loader for quarantine.
          const header = await target.readFrontmatter(path);
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
    status: node.status,
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

export type NodeCatalog = Awaited<ReturnType<typeof loadNodeCatalog>>;
