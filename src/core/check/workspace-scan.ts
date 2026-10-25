import path from "node:path";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { loadTent } from "../store/tree.js";
import { nodeNotePath } from "../base/paths.js";
import {
  isDirectoryMaterial,
  localMaterialPath,
  materialLocator,
  resolvedMaterialOccurrences,
} from "../base/material.js";
import { markdownMaterialHeading } from "../base/material-section.js";
import { repositoryFacts } from "../base/repository-facts.js";
import type { RepositorySource } from "../base/repository-imports.js";
import {
  structureMaterialCoverage,
  materialCoverageContains,
  type MaterialCoverage,
  isTentWorkspacePath,
} from "../base/material-coverage.js";

export type WorkspaceScanRepository = {
  head: string | null;
  trackedFiles: string[];
  sources: { files: RepositorySource[]; errors: Array<{ file: string; reason: string }> };
};
export type ScanFileKind = (
  filename: string,
  heading?: string,
) => Promise<"file" | "directory" | undefined>;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const directory = (file: string) => path.posix.dirname(file);
const ordered = (items: Iterable<string>) => [...new Set(items)].sort(compare);

function countDirectories(files: Iterable<string>) {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = directory(file);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .map(([directory, count]) => ({ directory, count }))
    .sort((a, b) => b.count - a.count || compare(a.directory, b.directory));
}

/** Query only: no history capture, material observation cache, repair or model execution. */
export async function scanWorkspace(
  fs: FsAdapter,
  workspaceRoot: string,
  repository: WorkspaceScanRepository,
  fileKind: ScanFileKind,
) {
  const tent = await loadTent(readOnlyFs(fs));
  const trackedFiles = ordered(
    repository.trackedFiles.filter((file) => !isTentWorkspacePath(file)),
  );
  const covered = new Set<string>();
  const inspectionErrors: Array<{ node: string; resource?: string; reason: string }> =
    repository.sources.errors
      .filter((error) => !isTentWorkspacePath(error.file))
      .map((error) => ({ node: error.file, reason: error.reason }));
  const kinds = new Map<string, Promise<"file" | "directory" | undefined>>();
  async function target(resource: string, owner: string, source = false) {
    const locator = materialLocator(resource, owner, source);
    const filename = localMaterialPath(locator, workspaceRoot);
    if (filename === undefined) return;
    const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/") || ".";
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return;
    if (isTentWorkspacePath(relative)) return;
    let coverage: MaterialCoverage | undefined;
    if (isDirectoryMaterial(locator) || relative.includes("*")) {
      const address =
        locator.kind === "path" && !/^(?:\.{1,2}\/|\/)/.test(resource.trim())
          ? "./" + resource.trim()
          : resource;
      coverage = structureMaterialCoverage(address, owner, workspaceRoot);
      if (!coverage)
        throw new Error(
          "Directory or prefix material requires a local Workspace address, one trailing * for a prefix, and no query or fragment",
        );
      if (coverage.kind === "prefix") return { relative, coverage };
    }
    const heading = markdownMaterialHeading(locator);
    const key = JSON.stringify([filename, heading]);
    let kind = kinds.get(key);
    if (!kind) {
      kind = fileKind(filename, heading);
      kinds.set(key, kind);
    }
    const observedKind = await kind;
    if (isDirectoryMaterial(locator) && observedKind === "file")
      throw new Error("Directory material points at a regular file");
    if (!isDirectoryMaterial(locator) && observedKind === "directory")
      throw new Error("Directory materials require a trailing /");
    return { relative, coverage };
  }
  function mark(
    files: string[],
    destinations: Set<string>,
    resolved: { relative: string; coverage?: MaterialCoverage },
  ) {
    const target =
      process.platform === "win32" ? resolved.relative.toLowerCase() : resolved.relative;
    for (const file of files) {
      const candidate = process.platform === "win32" ? file.toLowerCase() : file;
      if (
        resolved.coverage ? materialCoverageContains(resolved.coverage, file) : candidate === target
      )
        destinations.add(file);
    }
  }
  for (const node of [...tent.byPath.values()].sort((a, b) => compare(a.path, b.path))) {
    if (node.invalid) {
      inspectionErrors.push({
        node: node.path,
        reason: node.invalidReason ?? "Invalid Node document",
      });
      continue;
    }
    if (node.archived || node.status === "deprecated" || node.status === "draft") continue;
    const owner = nodeNotePath(node.path);
    for (const occurrence of resolvedMaterialOccurrences(node.fm, owner)) {
      if (occurrence.error) {
        inspectionErrors.push({
          node: node.path,
          resource: occurrence.resource,
          reason: occurrence.error,
        });
        continue;
      }
      try {
        const resolved = await target(occurrence.resource, owner, occurrence.field === "sources");
        if (resolved) mark(trackedFiles, covered, resolved);
      } catch (error) {
        inspectionErrors.push({
          node: node.path,
          resource: occurrence.resource,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const uncoveredFiles = trackedFiles.filter((file) => !covered.has(file));
  return {
    head: repository.head,
    coverage: {
      trackedFiles: trackedFiles.length,
      coveredFiles: covered.size,
      uncoveredFiles,
      directories: countDirectories(uncoveredFiles),
    },
    inspectionErrors,
    ...repositoryFacts(repository.sources.files.filter((file) => !isTentWorkspacePath(file.path))),
  };
}

export type WorkspaceScanResult = Awaited<ReturnType<typeof scanWorkspace>>;

/** A bounded overview; complete facts and file lists are available in JSON. */
export function formatWorkspaceScan(result: WorkspaceScanResult): string {
  const shown = (file: string) =>
    /[\r\n\t\u2028\u2029]/.test(file)
      ? JSON.stringify(file)
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029")
      : file;
  const sample = (items: string[], limit: number) =>
    items.slice(0, limit).join("; ") +
    (items.length > limit ? `; +${items.length - limit} more` : "");
  const graph = result.dependencies[1]!;
  const lines = [
    `coverage ${result.coverage.coveredFiles}/${result.coverage.trackedFiles}; uncovered ${result.coverage.uncoveredFiles.length}`,
    ...result.coverage.directories
      .slice(0, 3)
      .map((item) => `uncovered ${item.count} ${shown(item.directory)}`),
    `dependencies depth=2; ${graph.edges.length} edges; ${result.imports.issues.length} unresolved/config issues`,
    `entries ${sample(graph.entries.map(shown), 5) || "none"}`,
    `cycles ${
      sample(
        graph.cycles.map((cycle) => cycle.map(shown).join(" <-> ")),
        2,
      ) || "none"
    }`,
    `guidance ${sample(result.guidanceFiles.map(shown), 5) || "none"}`,
    `generated ${
      sample(
        result.generatedDirectories.map(
          (item) => `${shown(item.directory)}/ (${item.files.length})`,
        ),
        3,
      ) || "none"
    }; keep with its source`,
    ...result.flatDirectories.slice(0, 3).map(
      (item) =>
        `flat ${shown(item.directory)}/ ${item.codeFiles} code files; ${
          sample(
            item.groups.map((group) => `${shown(group.prefix)}* (${group.count})`),
            4,
          ) || "no repeated prefixes"
        }`,
    ),
    "all-facts tent workspace scan --json",
  ];
  return lines.join("\n");
}
