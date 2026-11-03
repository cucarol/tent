import path from "node:path";
import type { CatalogNode, NodeCatalog } from "../graph/node-catalog.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { nodeNotePath } from "../base/paths.js";
import { isUsableNode } from "../store/tree.js";
import { selectStopCoverage, type StopCoverageIndex } from "../return/stop-coverage.js";

export type LoadedNode = {
  nodeId: string;
  name: string;
  path: string;
  type?: string;
  description?: string;
};

function loaded(node: CatalogNode, systemRoot: string): LoadedNode {
  let description: unknown;
  try {
    description = parseFrontmatter(node.header).data.description;
  } catch {
    // The catalog already marks an unreadable header; a pointer needs no description.
  }
  return {
    nodeId: node.nodeId,
    name: node.name,
    path: path.resolve(systemRoot, nodeNotePath(node.path)),
    ...(node.type ? { type: node.type } : {}),
    ...(typeof description === "string" && description.trim()
      ? { description: description.trim() }
      : {}),
  };
}

/** Nodes covering the files, whole or by any section, then the direct prompts of each and of every goal above it, nearest first. */
export function selectLoadNodes(
  catalog: NodeCatalog,
  index: StopCoverageIndex,
  systemRoot: string,
  files: readonly string[],
): { covering: LoadedNode[]; prompts: LoadedNode[] } {
  const covering = selectStopCoverage(index, files, "all").flatMap((pointer) => {
    const node = catalog.byId.get(pointer.nodeId);
    return node ? [node] : [];
  });
  const seen = new Set(covering.map((node) => node.nodeId));
  const prompts: CatalogNode[] = [];
  for (const node of covering) {
    let governing: CatalogNode | undefined = node;
    while (governing) {
      if (governing === node || governing.type === "goal")
        for (const id of governing.childNodeIds) {
          const child = catalog.byId.get(id);
          if (
            !child ||
            seen.has(id) ||
            child.type !== "prompt" ||
            !isUsableNode(catalog.tree.byPath.get(child.path)!)
          )
            continue;
          seen.add(id);
          prompts.push(child);
        }
      governing = governing.parentNodeId ? catalog.byId.get(governing.parentNodeId) : undefined;
    }
  }
  return {
    covering: covering.map((node) => loaded(node, systemRoot)),
    prompts: prompts.map((node) => loaded(node, systemRoot)),
  };
}

const line = (node: LoadedNode) =>
  `- ${node.name}${node.type ? ` (${node.type})` : ""}: ${node.path}${node.description ? ` — ${node.description}` : ""}`;

export function formatLoadNodes(
  files: readonly string[],
  result: { covering: readonly LoadedNode[]; prompts: readonly LoadedNode[] },
): string {
  if (!result.covering.length) return `No Tent Node covers ${files.join(", ")}.`;
  return [
    `These Tent Nodes cover ${files.join(", ")}:\n` + result.covering.map(line).join("\n"),
    ...(result.prompts.length
      ? ["Prompts above them, nearest first:\n" + result.prompts.map(line).join("\n")]
      : []),
  ].join("\n\n");
}
