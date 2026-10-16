import path from "node:path";
import type { FsAdapter } from "../store/adapter.js";
import { ReaderError } from "./context-reader.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { nodeNotePath } from "../base/paths.js";
import { isUsableNode } from "../store/tree.js";
import { materialCoverageContains, structureMaterialCoverage } from "../base/material-coverage.js";
import {
  comparePaths,
  extractRepositoryImports,
  isTestSource,
  type RepositorySource,
} from "../base/repository-imports.js";

export type ModuleDependencyRepository = {
  basis: { head: string | null; dirty: boolean };
  /** Current nonignored files; an unchanged reader result may reuse this immutable array. */
  sources: readonly RepositorySource[];
};
export type ModuleDependencies = {
  basis: ModuleDependencyRepository["basis"];
  modules: Array<{ nodeId: string; files: number }>;
  edges: Array<{ from: string; to: string; imports: number }>;
  uncovered: number;
  unresolved: number;
};

const parsedImports = new WeakMap<
  readonly RepositorySource[],
  ReturnType<typeof extractRepositoryImports>
>();

/** Separate read query: no material observation, history capture or snapshot work. */
export async function readModuleDependencies(
  fs: FsAdapter,
  workspaceRoot: string,
  input: ModuleDependencyRepository | Promise<ModuleDependencyRepository>,
): Promise<ModuleDependencies> {
  const [catalog, repository] = await Promise.all([loadNodeCatalog(fs), input]);
  const modules = [...catalog.tree.byId.values()]
    .filter(isUsableNode)
    .filter((node) => node.fm.sources?.some((source) => source.track === "structure"))
    .map((node) => ({
      nodeId: node.id,
      coverage: (node.fm.sources ?? []).flatMap((source) => {
        if (source.track !== "structure") return [];
        const coverage = structureMaterialCoverage(
          source.resource,
          nodeNotePath(node.path),
          workspaceRoot,
        );
        return coverage ? [coverage] : [];
      }),
      files: 0,
    }))
    .sort((a, b) => comparePaths(a.nodeId, b.nodeId));

  // Longest matching material wins; equally specific declarations retain shared ownership.
  const owners = new Map<string, string[]>();
  const goPackages = new Map<string, string[]>();
  for (const source of repository.sources) {
    let longest = -1;
    let matches: (typeof modules)[number][] = [];
    for (const module of modules) {
      const specificity = Math.max(
        -1,
        ...module.coverage
          .filter((coverage) => materialCoverageContains(coverage, source.path))
          .map((coverage) => coverage.prefix.length),
      );
      if (specificity < 0 || specificity < longest) continue;
      if (specificity > longest) {
        longest = specificity;
        matches = [];
      }
      matches.push(module);
    }
    owners.set(
      source.path,
      matches.map((module) => module.nodeId),
    );
    for (const module of matches) module.files++;
    if (source.path.endsWith(".go") && !isTestSource(source.path)) {
      const directory = path.posix.dirname(source.path);
      const files = goPackages.get(directory) ?? [];
      files.push(source.path);
      goPackages.set(directory, files);
    }
  }

  let imports = parsedImports.get(repository.sources);
  if (!imports) {
    imports = extractRepositoryImports(repository.sources);
    parsedImports.set(repository.sources, imports);
  }
  const configIssue = imports.issues.find((issue) => issue.specifier === undefined);
  if (configIssue)
    throw new ReaderError("INVALID_INPUT", `${configIssue.file}: ${configIssue.reason}`);

  const uncovered = new Set<string>();
  const participation = (file: string) => {
    const modules = owners.get(file) ?? [];
    if (!modules.length) uncovered.add(file);
    return modules;
  };
  const edges = new Map<string, ModuleDependencies["edges"][number]>();
  let unresolved = imports.issues.length;
  for (const edge of imports.edges) {
    const from = participation(edge.from);
    const targets = edge.kind === "file" ? [edge.to] : (goPackages.get(edge.to) ?? []);
    const targetOwners = targets.map(participation);
    // A package import can name only modules owning every production file in that package.
    const to = new Set(
      (targetOwners[0] ?? []).filter(
        (owner) => edge.kind === "file" || targetOwners.every((owners) => owners.includes(owner)),
      ),
    );
    if (edge.kind !== "file" && !to.size && targetOwners.some((owners) => owners.length))
      unresolved++;
    for (const source of from)
      for (const target of to) {
        if (source === target) continue;
        const key = JSON.stringify([source, target]);
        const aggregate = edges.get(key) ?? { from: source, to: target, imports: 0 };
        aggregate.imports++;
        edges.set(key, aggregate);
      }
  }
  for (const issue of imports.issues) participation(issue.file);
  return {
    basis: { ...repository.basis },
    modules: modules.map(({ nodeId, files }) => ({ nodeId, files })),
    edges: [...edges.values()].sort(
      (a, b) => comparePaths(a.from, b.from) || comparePaths(a.to, b.to),
    ),
    uncovered: uncovered.size,
    unresolved,
  };
}
