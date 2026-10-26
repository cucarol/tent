import type { FsAdapter } from "../store/adapter.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { isNodeId } from "../base/id.js";
import { nodeNotePath, isOperationalPath } from "../base/paths.js";
import { normalizeOptionalNodeType } from "../base/node-type.js";
import { documentVersionSchema, type DocumentVersion } from "../store/history-port.js";

export type HistoryTreeNode = {
  id: string;
  name: string;
  type: string;
  path: string;
  parentId: string | null;
  version: DocumentVersion;
};
export type HistoryTree = { commit: string; nodes: HistoryTreeNode[] };

/** Immutable identity facts only. Sibling order is a drawing choice, never a historical claim. */
export async function readHistoryTree(fs: FsAdapter, commit: string): Promise<HistoryTree> {
  documentVersionSchema.shape.commit.parse(commit);
  const documents = await requireHistory(fs).readDirectory(commit);
  const nodes: HistoryTreeNode[] = [];
  const byPath = new Map<string, HistoryTreeNode>();
  const ids = new Set<string>();
  for (const [file, raw] of documents) {
    const path = file.slice(0, file.lastIndexOf("/"));
    if (isOperationalPath(file) || file !== nodeNotePath(path)) continue;
    const { data } = parseFrontmatter(raw);
    if (typeof data.id !== "string" || !isNodeId(data.id))
      throw new Error(`Invalid historical Node identity: ${file}`);
    if (ids.has(data.id)) throw new Error(`Duplicate historical identity: ${data.id}`);
    ids.add(data.id);
    const node: HistoryTreeNode = {
      id: data.id,
      name: path.slice(path.lastIndexOf("/") + 1),
      type: normalizeOptionalNodeType(data.type) ?? "",
      path,
      parentId: null,
      version: { commit, path: file },
    };
    nodes.push(node);
    byPath.set(path, node);
  }
  for (const node of nodes) {
    let parent = node.path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      const ancestor = byPath.get(parent);
      if (ancestor) {
        node.parentId = ancestor.id;
        break;
      }
    }
  }
  return { commit, nodes };
}

function requireHistory(fs: FsAdapter) {
  if (!fs.history) throw new Error("Tent history is unavailable");
  return fs.history;
}

/** A chronological, complete change range: from exclusive, to inclusive. */
export function listHistoryChanges(fs: FsAdapter, input: { from?: string; to?: string } = {}) {
  return requireHistory(fs).changesInRange(input);
}
