import path from "node:path";
import type { NodeCatalog } from "../graph/node-catalog.js";
import { nodeNotePath } from "../base/paths.js";
import { materialCoverage } from "../base/material-coverage.js";
import {
  normalizedMaterialWorkspacePath,
  normalizedMaterialCoverageContains,
  type MaterialCoverage,
} from "../base/material-coverage-match.js";
import { materialLocator, materialOccurrences } from "../base/material.js";
import { markdownMaterialHeading } from "../base/material-section.js";
import { isUsableNode } from "../store/tree.js";
import { sectionKey } from "./section-fingerprint.js";

export type StopNodePointer = { nodeId: string; name: string; path: string };
export type StopCoverageMaterial =
  | { kind: "file"; path: string; heading?: string }
  | { kind: "directory" | "prefix"; prefix: string };
export type StopCoverageIndex = {
  nodes: Array<StopNodePointer & { materials: StopCoverageMaterial[] }>;
};
export type StopNodeProblem = { path: string; problem: string };
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const fileKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

/** Metadata declarations only: Node types, description and track do not grant coverage. */
export function buildStopCoverageIndex(
  catalog: NodeCatalog,
  systemRoot: string,
  workspaceRoot: string,
): StopCoverageIndex {
  const roots = [workspaceRoot, path.dirname(systemRoot)];
  return {
    nodes: [...catalog.byId.values()]
      .filter((node) => isUsableNode(catalog.tree.byPath.get(node.path)!))
      .map((node) => {
        const owner = nodeNotePath(node.path);
        const materials = new Map<string, StopCoverageMaterial>();
        for (const occurrence of materialOccurrences(catalog.tree.byPath.get(node.path)!.fm)) {
          try {
            const locator = materialLocator(
              occurrence.resource,
              owner,
              occurrence.field === "sources",
            );
            const coverage = roots
              .map((root) =>
                materialCoverage(occurrence.resource, owner, root, occurrence.field === "sources"),
              )
              .find((value) => value !== undefined);
            if (!coverage) continue;
            let material: StopCoverageMaterial;
            if (coverage.kind === "file") {
              const heading = markdownMaterialHeading(locator);
              material = {
                kind: "file",
                path: coverage.prefix,
                ...(heading === undefined ? {} : { heading }),
              };
            } else material = { kind: coverage.kind, prefix: coverage.prefix };
            materials.set(JSON.stringify(material), material);
          } catch {
            // An unresolved material cannot supply local file coverage.
          }
        }
        return {
          nodeId: node.nodeId,
          name: node.name,
          path: path.resolve(systemRoot, owner),
          materials: [...materials.values()],
        };
      })
      .sort((a, b) => compare(a.path, b.path)),
  };
}

/** Only changed files with section declarations need an external Markdown read. */
export function stopCoverageSections(
  index: StopCoverageIndex,
  changedFiles: readonly string[],
): Map<string, { path: string; heading: string }> {
  const changed = new Set(changedFiles.map(fileKey));
  const sections = new Map<string, { path: string; heading: string }>();
  for (const node of index.nodes)
    for (const material of node.materials)
      if (
        material.kind === "file" &&
        material.heading !== undefined &&
        changed.has(fileKey(material.path))
      )
        sections.set(sectionKey(material.path, material.heading), {
          path: material.path,
          heading: material.heading,
        });
  return sections;
}

/** Most specific declarations win per changed path; equally specific Nodes all survive. */
export function selectStopCoverage(
  index: StopCoverageIndex,
  changedFiles: readonly string[],
  changedSectionKeys: ReadonlySet<string> = new Set(),
): StopNodePointer[] {
  if (!changedFiles.length) return [];
  const prepared = index.nodes.map((node) => ({
    node,
    materials: node.materials.flatMap((material) => {
      if (
        material.kind === "file" &&
        material.heading !== undefined &&
        !changedSectionKeys.has(sectionKey(material.path, material.heading))
      )
        return [];
      const coverage: MaterialCoverage = {
        kind: material.kind,
        prefix: fileKey(material.kind === "file" ? material.path : material.prefix),
      };
      return [{ coverage, rank: material.kind === "file" ? Infinity : material.prefix.length }];
    }),
  }));
  const selected = new Map<string, StopNodePointer>();
  for (const filename of changedFiles) {
    const normalized = normalizedMaterialWorkspacePath(filename);
    if (normalized === undefined) continue;
    let best = -1;
    let matches: StopNodePointer[] = [];
    for (const { node, materials } of prepared) {
      let rank = -1;
      for (const material of materials)
        if (
          material.rank > rank &&
          normalizedMaterialCoverageContains(material.coverage, normalized)
        )
          rank = material.rank;
      if (rank < 0 || rank < best) continue;
      if (rank > best) {
        best = rank;
        matches = [];
      }
      matches.push(node);
    }
    for (const { nodeId, name, path: filename } of matches)
      selected.set(filename, { nodeId, name, path: filename });
  }
  return [...selected.values()].sort((a, b) => compare(a.path, b.path));
}

/** Stop emits pointers and concrete document problems, with no body or output budget. */
export function formatStopCoverage(
  pointers: readonly StopNodePointer[],
  problems: readonly StopNodeProblem[] = [],
): string {
  const sections: string[] = [];
  if (pointers.length)
    sections.push(
      "Files changed this turn are covered by these Tent Nodes:\n" +
        [...pointers]
          .sort((a, b) => compare(a.path, b.path))
          .map((node) => `- ${node.name}: ${node.path}`)
          .join("\n") +
        "\nIf the change made a sentence in them wrong, fix it; if it settled something lasting, record it; otherwise say nothing about Tent.",
    );
  if (problems.length)
    sections.push(
      "These Tent Node files have problems:\n" +
        [...problems]
          .sort((a, b) => compare(a.path, b.path) || compare(a.problem, b.problem))
          .map((item) => `- ${item.path}: ${item.problem}`)
          .join("\n"),
    );
  return sections.join("\n\n");
}
