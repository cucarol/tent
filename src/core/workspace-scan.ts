import path from "node:path";
import { readOnlyFs, type FsAdapter } from "./adapter.js";
import { loadTent } from "./tree.js";
import { nodeNotePath } from "./paths.js";
import {
  isDirectoryMaterial,
  localMaterialPath,
  materialLocator,
  resolvedMaterialOccurrences,
} from "./material.js";
import { extractOutLinksDetailed } from "../markdown/links.js";
import { markdownMaterialHeading } from "./material-section.js";
import { repositoryFacts } from "./repository-facts.js";
import type { RepositorySource } from "./repository-imports.js";

export const WORKSPACE_SCAN_COMMIT_LIMIT = 300;
export const COCHANGE_BULK_FILE_LIMIT = 25;
export const COCHANGE_HUB_RATIO = 0.2;

export type ScanCommit = { commit: string; files: string[]; changedFiles: number };
export type WorkspaceScanRepository = {
  head: string | null;
  trackedFiles: string[];
  markdownFiles: string[];
  commits: ScanCommit[];
  sources: { files: RepositorySource[]; errors: Array<{ file: string; reason: string }> };
};
export type ScanFileKind = (
  filename: string,
  heading?: string,
) => Promise<"file" | "directory" | undefined>;
export type CochangeGroup = { files: string[]; count: number; commits: string[] };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const directory = (file: string) => path.posix.dirname(file);
const ordered = (items: Iterable<string>) => [...new Set(items)].sort(compare);

export function workspaceScanCommitLimit(value: number = WORKSPACE_SCAN_COMMIT_LIMIT): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("--commits must be a positive safe integer");
  return value;
}

function countDirectories(files: Iterable<string>, fileDirectory = directory) {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = fileDirectory(file);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .map(([directory, count]) => ({ directory, count }))
    .sort((a, b) => b.count - a.count || compare(a.directory, b.directory));
}

/** Closed groups supported by a pair; shared commits describe every file in the group. */
export function scanCochange(commits: ScanCommit[]) {
  const eligible = commits.filter((commit) => commit.changedFiles <= COCHANGE_BULK_FILE_LIMIT);
  const frequencies = new Map<string, number>();
  for (const commit of eligible)
    for (const file of new Set(commit.files))
      frequencies.set(file, (frequencies.get(file) ?? 0) + 1);
  const hubCommitThreshold = Math.max(3, Math.ceil(eligible.length * COCHANGE_HUB_RATIO));
  const hubs = [...frequencies]
    .filter(([, count]) => count >= hubCommitThreshold)
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || compare(a.file, b.file));
  const hubFiles = new Set(hubs.map((hub) => hub.file));
  const sets = eligible.map(
    (commit) => new Set(ordered(commit.files).filter((file) => !hubFiles.has(file))),
  );
  const supports = new Map<string, number[]>();
  sets.forEach((set, index) => {
    const files = [...set];
    for (let left = 0; left < files.length; left++)
      for (let right = left + 1; right < files.length; right++) {
        const key = JSON.stringify([files[left], files[right]]);
        const support = supports.get(key) ?? [];
        support.push(index);
        supports.set(key, support);
      }
  });
  const groups = new Map<string, CochangeGroup>();
  for (const support of supports.values()) {
    if (support.length < 2) continue;
    const files = [...sets[support[0]!]!].filter((file) =>
      support.every((index) => sets[index]!.has(file)),
    );
    groups.set(JSON.stringify(files), {
      files,
      count: support.length,
      commits: ordered(support.map((index) => eligible[index]!.commit)),
    });
  }
  return {
    bulkFileLimit: COCHANGE_BULK_FILE_LIMIT,
    hubCommitThreshold,
    excludedCommits: commits
      .filter((commit) => commit.changedFiles > COCHANGE_BULK_FILE_LIMIT)
      .map((commit) => ({ commit: commit.commit, changedFiles: commit.changedFiles })),
    groups: [...groups.values()].sort(
      (a, b) =>
        b.count - a.count ||
        b.files.length - a.files.length ||
        compare(JSON.stringify(a.files), JSON.stringify(b.files)),
    ),
    hubs,
  };
}

/** Query only: no history capture, material observation cache, repair or model execution. */
export async function scanWorkspace(
  fs: FsAdapter,
  workspaceRoot: string,
  repository: WorkspaceScanRepository,
  fileKind: ScanFileKind,
  commitLimit = WORKSPACE_SCAN_COMMIT_LIMIT,
) {
  workspaceScanCommitLimit(commitLimit);
  const tent = await loadTent(readOnlyFs(fs));
  const trackedFiles = ordered(repository.trackedFiles);
  const markdownFiles = ordered(repository.markdownFiles);
  const covered = new Set<string>();
  const pointed = new Set<string>();
  const inspectionErrors: Array<{ node: string; resource?: string; reason: string }> =
    repository.sources.errors.map((error) => ({ node: error.file, reason: error.reason }));
  const kinds = new Map<string, Promise<"file" | "directory" | undefined>>();
  async function target(resource: string, owner: string, source = false) {
    const locator = materialLocator(resource, owner, source);
    const filename = localMaterialPath(locator, workspaceRoot);
    if (filename === undefined) return;
    const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/") || ".";
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return;
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
    return {
      relative,
      present: observedKind !== undefined,
      kind: isDirectoryMaterial(locator) ? ("directory" as const) : observedKind,
    };
  }
  function mark(
    files: string[],
    destinations: Set<string>,
    resolved: { relative: string; kind?: "file" | "directory" },
  ) {
    const target =
      process.platform === "win32" ? resolved.relative.toLowerCase() : resolved.relative;
    for (const file of files) {
      const candidate = process.platform === "win32" ? file.toLowerCase() : file;
      if (
        candidate === target ||
        (resolved.kind === "directory" &&
          (target === "." || candidate.startsWith(`${target.replace(/\/$/, "")}/`)))
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
        if (resolved) {
          mark(trackedFiles, covered, resolved);
          if (resolved.present) mark(markdownFiles, pointed, resolved);
        }
      } catch (error) {
        inspectionErrors.push({
          node: node.path,
          resource: occurrence.resource,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const destinations = new Set(extractOutLinksDetailed(node.body).map((link) => link.raw));
    for (const destination of ordered(destinations)) {
      try {
        const resolved = await target(destination, owner);
        if (resolved?.kind === "file") mark(markdownFiles, pointed, resolved);
      } catch {
        // Broken links do not point at a local document; workspace check explains them.
      }
    }
  }
  const uncoveredFiles = trackedFiles.filter((file) => !covered.has(file));
  const hotspotCounts = new Map<string, number>();
  for (const commit of repository.commits)
    for (const dir of new Set(commit.files.map(directory)))
      hotspotCounts.set(dir, (hotspotCounts.get(dir) ?? 0) + 1);
  const recentChanges = new Map<string, number>();
  const tracked = new Set(trackedFiles);
  for (const file of markdownFiles) if (!tracked.has(file)) recentChanges.set(file, -1);
  repository.commits.forEach((commit, index) => {
    for (const file of commit.files) if (!recentChanges.has(file)) recentChanges.set(file, index);
  });
  const unpointedDocuments = markdownFiles
    .filter((file) => !pointed.has(file))
    .sort(
      (a, b) =>
        (recentChanges.get(a) ?? Infinity) - (recentChanges.get(b) ?? Infinity) || compare(a, b),
    );
  return {
    head: repository.head,
    commitLimit,
    commitsScanned: repository.commits.length,
    coverage: {
      trackedFiles: trackedFiles.length,
      coveredFiles: covered.size,
      uncoveredFiles,
      directories: countDirectories(uncoveredFiles),
    },
    cochange: scanCochange(repository.commits),
    hotspots: [...hotspotCounts]
      .map(([directory, count]) => ({ directory, count }))
      .sort((a, b) => b.count - a.count || compare(a.directory, b.directory)),
    unpointedDocuments,
    unpointedDirectories: countDirectories(unpointedDocuments, (file) =>
      file.includes("/") ? file.split("/")[0]! : ".",
    ),
    inspectionErrors,
    ...repositoryFacts(repository.sources.files),
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
    `cochange-groups ${result.cochange.groups.length}; hubs ${result.cochange.hubs.length}`,
    ...result.cochange.groups
      .slice(0, 3)
      .map((group) => `cochange ${group.count} ${sample(group.files.map(shown), 3)}`),
    `hotspots ${
      sample(
        result.hotspots.map((item) => `${shown(item.directory)} (${item.count})`),
        3,
      ) || "none"
    }`,
    `dependencies depth=2; ${graph.edges.length} edges; ${result.imports.issues.length} unresolved/config issues`,
    `entries ${sample(graph.entries.map(shown), 5) || "none"}`,
    `cycles ${
      sample(
        graph.cycles.map((cycle) => cycle.map(shown).join(" <-> ")),
        2,
      ) || "none"
    }`,
    `layers ${
      sample(
        [...new Set(graph.layers.map((item) => item.layer))].map(
          (layer) =>
            `${layer}: ${sample(
              graph.layers
                .filter((item) => item.layer === layer)
                .map((item) => shown(item.directory)),
              4,
            )}`,
        ),
        4,
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
    `unpointed-total ${result.unpointedDocuments.length}`,
    ...result.unpointedDocuments.slice(0, 2).map((file) => `unpointed ${shown(file)}`),
    "all-facts tent workspace scan --json",
  ];
  return lines.join("\n");
}
