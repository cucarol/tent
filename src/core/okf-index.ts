import { nodeNotePath } from "./paths.js";
import type { Node } from "./types.js";

/** Browser-safe Node identity used by Markdown link resolution. */
export interface OkfNode {
  id: string;
  nodeId: string;
  path: string;
  notePath: string;
  name: string;
  type?: string;
}

export function buildNodeIndex(nodes: Iterable<Node>): Map<string, OkfNode[]> {
  return buildOkfNodeIndex([...nodes].map(toOkfNode));
}

export function buildOkfNodeIndex(nodes: Iterable<OkfNode>): Map<string, OkfNode[]> {
  const index = new Map<string, OkfNode[]>();
  for (const node of nodes) {
    addIndex(index, node.nodeId, node);
    addIndex(index, node.id, node);
    addIndex(index, node.path, node);
    addIndex(index, node.notePath, node);
    addIndex(index, node.name, node);
  }
  return index;
}

export function resolveNode(index: Map<string, OkfNode[]>, target: string): OkfNode | undefined {
  const clean = target.trim().replace(/^\.\//, "").replace(/\.md$/i, "");
  const matches = index.get(clean) ?? index.get(`${clean}.md`);
  return matches?.length === 1 ? matches[0] : undefined;
}

function toOkfNode(node: Node): OkfNode {
  const notePath = nodeNotePath(node.path);
  return {
    id: notePath.replace(/\.md$/i, ""),
    nodeId: node.id,
    path: node.path,
    notePath,
    name: node.name,
    ...(node.type ? { type: node.type } : {}),
  };
}

function addIndex(index: Map<string, OkfNode[]>, key: string, node: OkfNode): void {
  const clean = key.trim();
  if (!clean) return;
  addRawIndex(index, clean, node);
}

function addRawIndex(index: Map<string, OkfNode[]>, key: string, node: OkfNode): void {
  if (!key) return;
  const list = index.get(key) ?? [];
  if (!list.some((item) => item.id === node.id)) list.push(node);
  index.set(key, list);
}
