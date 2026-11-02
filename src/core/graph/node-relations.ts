import type { CatalogNode } from "./node-catalog.js";

export function isRequirementNode(data: { type?: unknown }): boolean {
  return data.type === "goal";
}
export function goalAncestors(node: CatalogNode, byId: Map<string, CatalogNode>): CatalogNode[] {
  const goals: CatalogNode[] = [];
  let parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
  while (parent) {
    if (!parent.invalid && isRequirementNode({ type: parent.type })) goals.push(parent);
    parent = parent.parentNodeId ? byId.get(parent.parentNodeId) : undefined;
  }
  return goals;
}
