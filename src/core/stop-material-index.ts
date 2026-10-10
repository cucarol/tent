import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeCatalog } from "./node-catalog.js";
import { nodeNotePath } from "./paths.js";
import {
  localMaterialPath,
  materialLocator,
  materialOccurrences,
  isDirectoryMaterial,
} from "./material.js";
import { structureMaterialCoverage, type MaterialCoverage } from "./material-coverage.js";
import { isUsableNode } from "./tree.js";

export type StopIndexedNode = {
  nodeId: string;
  path: string;
  names: string[];
  type?: string;
  materials: Array<{ coverage: MaterialCoverage; scope?: string } | { file: string }>;
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
        const materials: StopIndexedNode["materials"] = [];
        for (const occurrence of materialOccurrences(data)) {
          try {
            const locator = materialLocator(
              occurrence.resource,
              owner,
              occurrence.field === "sources",
            );
            const filename = localMaterialPath(locator, workspaceRoot);
            if (filename === undefined) continue;
            const hasSelector =
              locator.kind === "path"
                ? !!locator.suffix
                : locator.kind === "uri" &&
                  !!(new URL(locator.uri).search || new URL(locator.uri).hash);
            if (filename.includes("*") && hasSelector) continue;
            const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/");
            const outside =
              relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
            const scope = outside ? path.dirname(filename) : workspaceRoot;
            const coverage = structureMaterialCoverage(
              pathToFileURL(filename).href + (isDirectoryMaterial(locator) ? "/" : ""),
              owner,
              scope,
            );
            if (coverage)
              materials.push({
                coverage,
                ...(outside ? { scope: pathToFileURL(scope).href } : {}),
              });
            else if (!relative.includes("*"))
              materials.push({
                file:
                  process.platform === "win32"
                    ? (outside ? pathToFileURL(filename).href : relative).toLowerCase()
                    : outside
                      ? pathToFileURL(filename).href
                      : relative,
              });
          } catch {
            /* An unresolved material supplies no guessed membership. */
          }
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
          materials,
          moduleCoverage,
        };
      }),
  };
}
