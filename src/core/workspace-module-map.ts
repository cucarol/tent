import path from "node:path";
import { readOnlyFs, type FsAdapter } from "./adapter.js";
import { loadTent } from "./tree.js";
import { nodeNotePath } from "./paths.js";
import { buildNodeIndex } from "./okf-index.js";
import { extractOutLinksDetailed, resolveOutLink } from "../markdown/links.js";
import {
  isDirectoryMaterial,
  localMaterialPath,
  materialFields,
  resolvedMaterialOccurrences,
} from "./material.js";
import { structureMaterialCoverage } from "./material-coverage.js";
import {
  checkModuleMap,
  MODULE_MAP_THRESHOLDS,
  type ModuleMapCommit,
  type ModuleMapNode,
  type ModuleMapCode,
  isModuleMapNode,
  allowsModuleMapRule,
} from "./module-map.js";
import { extractRepositoryImports, comparePaths } from "./repository-imports.js";
import type { WorkspaceScanRepository } from "./workspace-scan.js";

export type WorkspaceModuleMapRepository = WorkspaceScanRepository & { commits: ModuleMapCommit[] };

const pairCodes: ModuleMapCode[] = [
  "deps.cycle",
  "history.always-together",
  "history.generated-apart",
];

/** Read current declarations without observations, capture, repair or derived cache writes. */
export async function checkWorkspaceModules(
  fs: FsAdapter,
  workspaceRoot: string,
  repository: WorkspaceModuleMapRepository,
) {
  const tent = await loadTent(readOnlyFs(fs));
  const inspectionErrors: Array<{ node: string; resource?: string; reason: string }> =
    repository.sources.errors.map((error) => ({ node: error.file, reason: error.reason }));
  const current = [...tent.byPath.values()].filter(
    (node) => !node.invalid && !node.archived && node.status !== "deprecated",
  );
  for (const node of tent.byPath.values())
    if (node.invalid)
      inspectionErrors.push({
        node: node.path,
        reason: node.invalidReason ?? "Invalid Node document",
      });
  const index = buildNodeIndex(current);
  const nodes: ModuleMapNode[] = current
    .map((node) => {
      const owner = nodeNotePath(node.path);
      const materials: ModuleMapNode["materials"][number][] = [];
      const sources = materialFields(node.fm).sources;
      for (const occurrence of resolvedMaterialOccurrences(node.fm, owner)) {
        try {
          if (occurrence.error) throw new Error(occurrence.error);
          const structure =
            occurrence.field === "sources" && sources?.[occurrence.index!]?.track === "structure";
          const locator = occurrence.locator!;
          const filename = localMaterialPath(locator, workspaceRoot);
          if (filename === undefined) {
            if (structure)
              throw new Error("Structure material must name a local Workspace directory or prefix");
            continue;
          }
          const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/") || ".";
          if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
            if (structure) throw new Error("Structure material must be inside the Workspace");
            continue;
          }
          if (relative.includes("*") || isDirectoryMaterial(locator) || structure) {
            // Legacy resource paths may be bare; sources and the shared authority require an explicit address.
            const address =
              locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(occurrence.resource.trim())
                ? "./" + occurrence.resource.trim()
                : occurrence.resource;
            const coverage = structureMaterialCoverage(address, owner, workspaceRoot);
            if (!coverage)
              throw new Error(
                "Directory or prefix material requires a local Workspace address, one trailing * for a prefix, and no query or fragment",
              );
            materials.push({
              path:
                coverage.kind === "directory"
                  ? coverage.prefix.slice(0, -1) || "."
                  : coverage.prefix,
              kind: coverage.kind,
              ...(structure ? { track: "structure" as const } : {}),
            });
          } else
            materials.push({
              path: relative.replace(/\/$/, ""),
              kind: isDirectoryMaterial(locator) ? "directory" : "file",
            });
        } catch (error) {
          inspectionErrors.push({
            node: node.path,
            resource: occurrence.resource,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const exceptions: NonNullable<ModuleMapNode["exceptions"]>[number][] = [];
      for (const link of extractOutLinksDetailed(node.body, true)) {
        const resolved = resolveOutLink(index, link, owner);
        if (!resolved.targetNodeId || !link.range) continue;
        const start = node.body.lastIndexOf("\n", link.range.start - 1) + 1;
        const next = node.body.indexOf("\n", link.range.end);
        const line = node.body.slice(start, next < 0 ? undefined : next);
        // A multiline link is not a single-line declaration.
        if (line.includes("\n")) continue;
        for (const code of pairCodes)
          if (allowsModuleMapRule(line, code))
            exceptions.push({ code, targetId: resolved.targetNodeId });
      }
      return {
        id: node.id,
        path: node.path,
        name: node.name,
        body: node.body,
        materials,
        exceptions,
      };
    })
    .sort((a, b) => comparePaths(a.path, b.path));
  const modules = new Set(nodes.filter(isModuleMapNode).map((node) => node.id));
  for (const node of nodes) {
    let parent = tent.byId.get(node.id)?.parent;
    while (parent && !modules.has(parent.id)) parent = parent.parent;
    if (parent) node.parentId = parent.id;
  }
  const imports = extractRepositoryImports(repository.sources.files);
  return {
    head: repository.head,
    commitLimit: MODULE_MAP_THRESHOLDS.historyCommitLimit,
    ...checkModuleMap({
      trackedFiles: repository.trackedFiles,
      imports: imports.edges,
      commits: repository.commits,
      nodes,
    }),
    importIssues: imports.issues,
    inspectionErrors: inspectionErrors.sort((a, b) =>
      comparePaths(JSON.stringify(a), JSON.stringify(b)),
    ),
  };
}

export type WorkspaceModuleMapResult = Awaited<ReturnType<typeof checkWorkspaceModules>>;

/** A clean map produces no text, including no success banner. */
export function formatWorkspaceModules(result: WorkspaceModuleMapResult) {
  return result.issues
    .map(
      (issue) =>
        `${issue.code} ${JSON.stringify(issue.object)}\n  facts: ${JSON.stringify(issue.facts)}\n  fix: ${issue.fix}\n`,
    )
    .join("");
}
