import path from "node:path";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { isNodeId } from "../base/id.js";
import { nodeNotePath } from "../base/paths.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { documentLifecycle } from "../base/document-status.js";
import {
  isDirectoryMaterial,
  isCardResponseSource,
  isPrefixMaterial,
  localMaterialPath,
  resolvedMaterialOccurrences,
} from "../base/material.js";
import {
  isTentWorkspacePath,
  materialCoverageContains,
  structureMaterialCoverage,
  type MaterialCoverage,
} from "../base/material-coverage.js";
import { assertSystemMaterial, systemMaterialPath } from "../graph/material-target.js";
import { loadNodeCatalog } from "../graph/node-catalog.js";
import { ReaderError } from "../graph/context-reader.js";

type Declaration = {
  field: "resource" | "sources";
  index?: number;
  resource: string;
  track?: "structure";
};
export type MaterialIntersection =
  | { kind: "file" | "directory" | "prefix"; path: string }
  | { kind: "document"; path: string }
  | { kind: "uri"; uri: string };
export type MaterialOverlaps = {
  nodes: Array<{ nodeId: string; issues: Array<Declaration & { reason: string }> }>;
  pairs: Array<{
    left: string;
    right: string;
    shared: Array<{ left: Declaration; right: Declaration; intersection: MaterialIntersection }>;
  }>;
};
type Resolved = { declaration: Declaration; target: MaterialIntersection };
const localKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
const coverage = (target: MaterialIntersection): MaterialCoverage | undefined =>
  target.kind === "directory" || target.kind === "prefix"
    ? { kind: target.kind, prefix: target.path }
    : undefined;

function intersection(
  a: MaterialIntersection,
  b: MaterialIntersection,
): MaterialIntersection | undefined {
  if (a.kind === "uri" || b.kind === "uri")
    return a.kind === "uri" && b.kind === "uri" && a.uri === b.uri ? a : undefined;
  if (a.kind === "document" || b.kind === "document")
    return a.kind === "document" && b.kind === "document" && a.path === b.path ? a : undefined;
  const ac = coverage(a),
    bc = coverage(b);
  if (ac && bc) {
    // Both declarations describe prefix sets; the narrower shared prefix is their intersection.
    if (localKey(ac.prefix).startsWith(localKey(bc.prefix))) return a;
    if (localKey(bc.prefix).startsWith(localKey(ac.prefix))) return b;
    return;
  }
  if (ac) return materialCoverageContains(ac, b.path) ? b : undefined;
  if (bc) return materialCoverageContains(bc, a.path) ? a : undefined;
  return localKey(a.path) === localKey(b.path) ? a : undefined;
}

/** Declared coverage, not a scan of today's files or evidence that the declarations are correct. */
export async function readMaterialOverlaps(
  fs: FsAdapter,
  workspaceRoot: string,
  nodeIds: readonly string[],
): Promise<MaterialOverlaps> {
  if (!Array.isArray(nodeIds) || nodeIds.some((id) => !isNodeId(id)))
    throw new ReaderError("INVALID_INPUT", "Expected canonical Node ids");
  if (!nodeIds.length) return { nodes: [], pairs: [] };
  fs = readOnlyFs(fs);
  const catalog = await loadNodeCatalog(fs);
  const selected = [...new Set(nodeIds)].map((nodeId) => {
    const node = catalog.byId.get(nodeId);
    if (!node) throw new ReaderError("NOT_FOUND", `Node not found: ${nodeId}`);
    return node;
  });
  const nodePaths = new Set([...catalog.byId.values()].map((node) => nodeNotePath(node.path)));
  const result: MaterialOverlaps = { nodes: [], pairs: [] };
  const declarations = new Map<string, Resolved[]>();
  const internal = new Map<string, Promise<void>>();
  for (const node of selected) {
    const entry: MaterialOverlaps["nodes"][number] = { nodeId: node.nodeId, issues: [] };
    const resolved: Resolved[] = [];
    result.nodes.push(entry);
    declarations.set(node.nodeId, resolved);
    const data = parseFrontmatter(node.header).data;
    const status = documentLifecycle(data).status;
    // The same usable-Node boundary as resource lookup: retired Nodes establish no coverage.
    if (node.archived || (status !== "draft" && status !== "stable")) continue;
    const documentPath = nodeNotePath(node.path);
    for (const { locator, error, ...declaration } of resolvedMaterialOccurrences(
      data,
      documentPath,
    )) {
      if (
        declaration.field === "sources" &&
        isCardResponseSource(declaration.resource, documentPath, workspaceRoot)
      )
        continue;
      try {
        if (!locator || locator.kind === "unresolved")
          throw new Error(error ?? "Material address is unresolved");
        if (declaration.track && !isDirectoryMaterial(locator) && !isPrefixMaterial(locator))
          throw new Error("track: structure requires a directory or prefix material");
        const systemPath = systemMaterialPath(locator, workspaceRoot);
        if (systemPath !== undefined) {
          const key = JSON.stringify(locator);
          let checked = internal.get(key);
          if (!checked) {
            checked = assertSystemMaterial(fs, locator, nodePaths);
            internal.set(key, checked);
          }
          await checked;
          resolved.push({ declaration, target: { kind: "document", path: systemPath } });
          continue;
        }
        const area = structureMaterialCoverage(declaration.resource, documentPath, workspaceRoot);
        if (area) {
          resolved.push({ declaration, target: { kind: area.kind, path: area.prefix } });
          continue;
        }
        const filename = localMaterialPath(locator, workspaceRoot);
        const relative =
          filename === undefined
            ? undefined
            : path.relative(workspaceRoot, filename).split(path.sep).join("/");
        const inside =
          relative !== undefined &&
          relative !== ".." &&
          !relative.startsWith("../") &&
          !path.isAbsolute(relative);
        if (inside) {
          if (
            !relative ||
            isTentWorkspacePath(relative) ||
            isDirectoryMaterial(locator) ||
            isPrefixMaterial(locator)
          )
            throw new Error("Material does not establish Workspace file coverage");
          resolved.push({ declaration, target: { kind: "file", path: relative } });
        } else if (locator.kind === "uri") {
          // External addresses only have exact reference equality; never fetch or extend coverage.
          resolved.push({ declaration, target: { kind: "uri", uri: locator.uri } });
        } else throw new Error("Material does not resolve to Workspace coverage");
      } catch (error) {
        entry.issues.push({
          ...declaration,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  for (const [i, left] of selected.entries())
    for (const right of selected.slice(i + 1)) {
      const shared: MaterialOverlaps["pairs"][number]["shared"] = [];
      for (const a of declarations.get(left.nodeId)!)
        for (const b of declarations.get(right.nodeId)!) {
          const common = intersection(a.target, b.target);
          if (common)
            shared.push({ left: a.declaration, right: b.declaration, intersection: common });
        }
      result.pairs.push({ left: left.nodeId, right: right.nodeId, shared });
    }
  return result;
}
