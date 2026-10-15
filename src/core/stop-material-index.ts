import type { NodeCatalog } from "./node-catalog.js";
import { nodeNotePath } from "./paths.js";
import { structureMaterialCoverage, type MaterialCoverage } from "./material-coverage.js";
import { isUsableNode } from "./tree.js";

export type StopIndexedNode = {
  nodeId: string;
  path: string;
  names: string[];
  type?: string;
  moduleCoverage: MaterialCoverage[];
};
export type StopMaterialIndex = { nodes: StopIndexedNode[] };

/** Metadata only; no content comparison, retained history, capture or material observation. */
export function buildStopMaterialIndex(
  catalog: NodeCatalog,
  workspaceRoot: string,
  invalidNodePaths: readonly string[] = [],
): StopMaterialIndex {
  const nodes = [...catalog.byId.values()].filter(
    (node) =>
      isUsableNode(catalog.tree.byPath.get(node.path)!) &&
      !invalidNodePaths.includes(`.tent/${nodeNotePath(node.path)}`),
  );
  return {
    nodes: nodes
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node) => {
        const data = catalog.tree.byPath.get(node.path)!.fm;
        const owner = nodeNotePath(node.path);
        const names: string[] = [];
        let ancestor: typeof node | undefined = node;
        while (ancestor) {
          names.unshift(ancestor.name);
          ancestor = ancestor.parentNodeId ? catalog.byId.get(ancestor.parentNodeId) : undefined;
        }
        const moduleCoverage = (data.sources ?? []).flatMap((source) => {
          if (source.track !== "structure") return [];
          const coverage = structureMaterialCoverage(source.resource, owner, workspaceRoot);
          return coverage ? [coverage] : [];
        });
        return {
          nodeId: node.nodeId,
          path: `.tent/${owner}`,
          names,
          ...(node.type ? { type: node.type } : {}),
          moduleCoverage,
        };
      }),
  };
}
