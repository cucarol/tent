import path from "node:path";
import type { NodeCatalog } from "../graph/node-catalog.js";
import { nodeNotePath } from "../base/paths.js";
import {
  isTentWorkspacePath,
  structureMaterialCoverage,
  type MaterialCoverage,
} from "../base/material-coverage.js";
import {
  isDirectoryMaterial,
  isPrefixMaterial,
  localMaterialPath,
  materialLocator,
  materialOccurrences,
} from "../base/material.js";
import { markdownMaterialHeading } from "../base/material-section.js";
import { isUsableNode } from "../store/tree.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { canonicalSha256 } from "../base/canonical-digest.js";
import { turnReviewHeaderDigest } from "./turn-review-document.js";

/** A whole file, or one Markdown section of it, that the Node's content rests on. */
export type StopMaterialFile = { path: string; heading?: string };
export type StopIndexedNode = {
  nodeId: string;
  path: string;
  names: string[];
  type?: string;
  /** Direct prompts of this Node, then of each ancestor goal, nearest first. */
  ruleNodeIds?: string[];
  headerDigest?: string;
  moduleCoverage: MaterialCoverage[];
  materialFiles: StopMaterialFile[];
  /** A module owns every directory and prefix it names, tracked or not; empty for other Nodes. */
  moduleMaterials: MaterialCoverage[];
};
export type StopMaterialIndex = { nodes: StopIndexedNode[] };

/** Untracked directories and prefixes only supply coverage, so editing a member is not a material change. */
function workspaceMaterialFile(
  resource: string,
  owner: string,
  workspaceRoot: string,
  source: boolean,
): StopMaterialFile | undefined {
  try {
    const locator = materialLocator(resource, owner, source);
    if (isDirectoryMaterial(locator) || isPrefixMaterial(locator)) return;
    const filename = localMaterialPath(locator, workspaceRoot);
    if (filename === undefined) return;
    const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/");
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative) ||
      isTentWorkspacePath(relative)
    )
      return;
    const heading = markdownMaterialHeading(locator);
    return heading === undefined ? { path: relative } : { path: relative, heading };
  } catch {
    return undefined;
  }
}

/** Provenance stamps do not change Stop membership, names, types or material coverage. */
export function sameStopMaterialHeader(before: string, after: string): boolean {
  if (before === after) return true;
  try {
    const { generated: _before, ...left } = parseFrontmatter(before).data;
    const { generated: _after, ...right } = parseFrontmatter(after).data;
    return canonicalSha256(left) === canonicalSha256(right);
  } catch {
    // A changed malformed header still goes through the tree's quarantine rules.
    return false;
  }
}

/** Metadata only; no content comparison, retained history, capture or material observation. */
export function buildStopMaterialIndex(
  catalog: NodeCatalog,
  workspaceRoot: string,
  invalidNodePaths: readonly string[] = [],
): StopMaterialIndex {
  const nodes = [...catalog.byId.values()].filter(
    (node) =>
      isUsableNode(catalog.tree.byPath.get(node.path)!) &&
      catalog.tree.byPath.get(node.path)!.status !== "draft" &&
      !invalidNodePaths.includes(`.tent/${nodeNotePath(node.path)}`),
  );
  const active = new Set(nodes.map((node) => node.nodeId));
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
        const materialFiles = new Map<string, StopMaterialFile>();
        const moduleMaterials: MaterialCoverage[] = [];
        for (const { field, resource } of materialOccurrences(data)) {
          const file = workspaceMaterialFile(resource, owner, workspaceRoot, field === "sources");
          if (file) materialFiles.set(JSON.stringify([file.path, file.heading]), file);
          const coverage = structureMaterialCoverage(resource, owner, workspaceRoot);
          if (coverage && moduleCoverage.length) moduleMaterials.push(coverage);
        }
        const ruleNodeIds = new Set<string>();
        let governing: typeof node | undefined = node;
        while (governing) {
          if (governing.nodeId === node.nodeId || governing.type === "goal")
            for (const id of governing.childNodeIds)
              if (id !== node.nodeId && active.has(id) && catalog.byId.get(id)?.type === "prompt")
                ruleNodeIds.add(id);
          governing = governing.parentNodeId ? catalog.byId.get(governing.parentNodeId) : undefined;
        }
        return {
          nodeId: node.nodeId,
          path: `.tent/${owner}`,
          names,
          ...(node.type ? { type: node.type } : {}),
          ruleNodeIds: [...ruleNodeIds],
          headerDigest: turnReviewHeaderDigest(node.header),
          moduleCoverage,
          materialFiles: [...materialFiles.values()],
          moduleMaterials,
        };
      }),
  };
}
