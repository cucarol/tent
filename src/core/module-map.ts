import path from "node:path";
import {
  comparePaths,
  isCodeSource,
  isGeneratedSource,
  isTestSource,
  type RepositoryImport,
} from "./repository-imports.js";
import type { ScanCommit } from "./workspace-scan.js";
import { materialCoverageContains } from "./material-coverage.js";

export const MODULE_MAP_THRESHOLDS = {
  historyCommitLimit: 300,
  minimumProductionFiles: 20,
  oversizedShare: 0.2,
  siblingMedianMultiplier: 3,
  minimumGroupFiles: 3,
  minimumGroups: 2,
  minimumReverseImports: 3,
  minimumReverseRatio: 0.1,
  maximumCommitFiles: 50,
  minimumSharedCommits: 5,
  minimumSharedRatio: 0.9,
  minimumLift: 2,
  generatedMajority: 0.5,
} as const;

export type ModuleMapCode =
  | "map.uncovered"
  | "module.oversized"
  | "module.skewed"
  | "deps.cycle"
  | "history.always-together"
  | "history.generated-apart";
export type ModuleMapMaterial = {
  path: string;
  kind: "file" | "directory" | "prefix";
  track?: "structure";
};
/** Valid, active Nodes; parentId names the nearest module ancestor, if any. */
export type ModuleMapNode = {
  id: string;
  path: string;
  name: string;
  parentId?: string;
  body: string;
  materials: readonly ModuleMapMaterial[];
  /** Pair links resolved from the same body line as their rule code by the caller. */
  exceptions?: readonly { code: ModuleMapCode; targetId?: string }[];
};
export type ModuleMapIssue = {
  code: ModuleMapCode;
  object: string;
  facts: Record<string, unknown>;
  fix: string;
};
export type ModuleMapModuleFacts = {
  id: string;
  path: string;
  name: string;
  files: string[];
  productionFiles: number;
  generatedFiles: number;
};
export type ModuleMapInput = {
  trackedFiles: readonly string[];
  imports: readonly RepositoryImport[];
  /** First-parent history, as collected by the caller. */
  commits: readonly ScanCommit[];
  nodes: readonly ModuleMapNode[];
};

const ordered = (items: Iterable<string>) => [...new Set(items)].sort(comparePaths);
const vendor = (file: string) => /(^|\/)(vendor|node_modules|third_party|third-party)\//.test(file);
const production = (file: string) =>
  isCodeSource(file) && !isTestSource(file) && !isGeneratedSource(file) && !vendor(file);
const barrel = (file: string) => /(^|\/)index\.[^/]+$/.test(file);

const comparable = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file);
function matches(material: ModuleMapMaterial, file: string): boolean {
  if (material.kind === "file") return comparable(material.path) === comparable(file);
  return materialCoverageContains(
    {
      kind: material.kind,
      prefix:
        material.kind === "directory"
          ? material.path === "."
            ? ""
            : material.path + "/"
          : material.path,
    },
    file,
  );
}

export const isModuleMapNode = (node: ModuleMapNode) =>
  node.materials.some((material) => material.track === "structure" && material.kind !== "file");

export const allowsModuleMapRule = (body: string, code: ModuleMapCode) =>
  new RegExp(`(?<![\\w:.-])allow:${code.replaceAll(".", "\\.")}(?![\\w.-])`).test(body);

type Ownership = { node: ModuleMapNode; material: ModuleMapMaterial };
function materialOrder(a: Ownership, b: Ownership): number {
  const specificity = (material: ModuleMapMaterial) =>
    material.path === "." ? 0 : material.path.length;
  const kind = { directory: 0, prefix: 1, file: 2 };
  return (
    specificity(b.material) - specificity(a.material) ||
    kind[b.material.kind] - kind[a.material.kind] ||
    comparePaths(a.node.path, b.node.path) ||
    comparePaths(a.node.id, b.node.id)
  );
}

function median(numbers: number[]): number {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Pure module-map rules: supplied repository facts only, with no I/O or model calls. */
export function checkModuleMap(input: ModuleMapInput) {
  const thresholds = MODULE_MAP_THRESHOLDS;
  const trackedFiles = ordered(input.trackedFiles);
  const nodes = [...input.nodes].sort(
    (a, b) => comparePaths(a.path, b.path) || comparePaths(a.id, b.id),
  );
  const modules = nodes.filter(isModuleMapNode);
  const byId = new Map(modules.map((node) => [node.id, node]));
  const ownership = modules
    .flatMap((node) => node.materials.map((material) => ({ node, material })))
    .sort(materialOrder);
  const owner = (file: string) => ownership.find((item) => matches(item.material, file));
  const directoryOwner = (directory: string) =>
    ownership.find(
      ({ material }) =>
        material.kind === "directory" &&
        (comparable(material.path) === comparable(directory) || matches(material, directory)),
    )?.node;
  const packageFiles = new Map<string, string[]>();
  for (const file of trackedFiles) {
    if (!file.endsWith(".go") || isTestSource(file)) continue;
    const directory = comparable(path.posix.dirname(file));
    const files = packageFiles.get(directory) ?? [];
    files.push(file);
    packageFiles.set(directory, files);
  }
  const packageOwner = (directory: string) => {
    const direct = directoryOwner(directory);
    if (direct) return direct;
    const files = packageFiles.get(comparable(directory)) ?? [];
    const first = files.length ? owner(files[0]!)?.node : undefined;
    return first && files.every((file) => owner(file)?.node.id === first.id) ? first : undefined;
  };
  const members = new Map(modules.map((node) => [node.id, [] as string[]]));
  const uncovered = new Map<string, string[]>();
  for (const file of trackedFiles) {
    const module = owner(file)?.node;
    if (module) members.get(module.id)!.push(file);
    if (!nodes.some((node) => node.materials.some((material) => matches(material, file)))) {
      const directory = path.posix.dirname(file);
      const files = uncovered.get(directory) ?? [];
      files.push(file);
      uncovered.set(directory, files);
    }
  }
  const moduleFacts: ModuleMapModuleFacts[] = modules.map((node) => {
    const files = members.get(node.id)!;
    return {
      id: node.id,
      path: node.path,
      name: node.name,
      files,
      productionFiles: files.filter(production).length,
      generatedFiles: files.filter(isGeneratedSource).length,
    };
  });
  const factsById = new Map(moduleFacts.map((facts) => [facts.id, facts]));
  const issues: ModuleMapIssue[] = [];
  const pairExcepted = (code: ModuleMapCode, a: ModuleMapNode, b: ModuleMapNode) =>
    [a, b].some((node) =>
      node.exceptions?.some(
        (exception) => exception.code === code && exception.targetId === (node === a ? b.id : a.id),
      ),
    );
  for (const [directory, files] of [...uncovered].sort(([a], [b]) => comparePaths(a, b)))
    issues.push({
      code: "map.uncovered",
      object: directory,
      facts: { directory, count: files.length, files },
      fix: "Assign the listed files to a Node's file, directory or prefix materials.",
    });

  const totalProduction = trackedFiles.filter(production).length;
  for (const node of modules) {
    if (modules.some((other) => other.parentId === node.id)) continue;
    const facts = factsById.get(node.id)!;
    if (facts.productionFiles < thresholds.minimumProductionFiles) continue;
    const siblingMedian = median(
      modules
        .filter((other) => other.id !== node.id && other.parentId === node.parentId)
        .map((other) => factsById.get(other.id)!.productionFiles)
        .filter((count) => count > 0),
    );
    const share = facts.productionFiles / totalProduction;
    const oversized = share > thresholds.oversizedShare;
    const skewed =
      siblingMedian > 0 &&
      facts.productionFiles > thresholds.siblingMedianMultiplier * siblingMedian;
    if (!oversized && !skewed) continue;
    const groups = new Map<string, number>();
    for (const file of facts.files.filter(production)) {
      const material = owner(file)!.material;
      const base =
        material.kind === "directory"
          ? material.path === "."
            ? ""
            : file.slice(0, material.path.length + 1)
          : material.kind === "prefix"
            ? file.slice(0, material.path.length)
            : path.posix.dirname(file) === "."
              ? ""
              : path.posix.dirname(file) + "/";
      const rest = file.slice(base.length);
      const separator = rest.search(/[-_.]/);
      const key = rest.includes("/")
        ? base + rest.slice(0, rest.indexOf("/")) + "/"
        : base +
          (separator < 0 ? rest : rest.slice(0, separator)) +
          (separator >= 0 && /[-_]/.test(rest[separator]!) ? rest[separator] : "");
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const candidates = [...groups]
      .filter(([, count]) => count >= thresholds.minimumGroupFiles)
      .map(([path, files]) => ({ path, files }))
      .sort((a, b) => b.files - a.files || comparePaths(a.path, b.path));
    if (candidates.length < thresholds.minimumGroups) continue;
    const code = oversized ? "module.oversized" : "module.skewed";
    if (allowsModuleMapRule(node.body, code)) continue;
    issues.push({
      code,
      object: node.path,
      facts: {
        nodeIds: [node.id],
        productionFiles: facts.productionFiles,
        totalProductionFiles: totalProduction,
        share,
        siblingMedian,
        groups: candidates,
      },
      fix: "Split this module into child modules along the listed directory or filename groups.",
    });
  }

  const edgeCounts = new Map<string, number>();
  const unassignedImports: Array<{ from: string; to: string; reason: string }> = [];
  const imports = [
    ...new Map(input.imports.map((edge) => [JSON.stringify(edge), edge])).values(),
  ].sort((a, b) => comparePaths(JSON.stringify(a), JSON.stringify(b)));
  for (const edge of imports) {
    if (
      isTestSource(edge.from) ||
      isTestSource(edge.to) ||
      barrel(edge.from) ||
      (edge.kind === "file" && barrel(edge.to))
    )
      continue;
    const from = owner(edge.from)?.node;
    const to = edge.kind === "directory" ? packageOwner(edge.to) : owner(edge.to)?.node;
    if (
      from &&
      !to &&
      edge.kind === "directory" &&
      trackedFiles.some(
        (file) => comparable(path.posix.dirname(file)) === comparable(edge.to) && owner(file),
      )
    )
      unassignedImports.push({
        from: edge.from,
        to: edge.to,
        reason:
          "Package import has no directory material owner or unique module owning all its production Go files.",
      });
    if (!from || !to || from.id === to.id) continue;
    const key = JSON.stringify([from.id, to.id]);
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  const ancestorOf = (ancestor: ModuleMapNode, descendant: ModuleMapNode): boolean => {
    let parent = descendant.parentId;
    while (parent) {
      if (parent === ancestor.id) return true;
      parent = byId.get(parent)?.parentId;
    }
    return false;
  };
  for (let i = 0; i < modules.length; i++) {
    const a = modules[i]!;
    for (const b of modules.slice(i + 1)) {
      if (ancestorOf(a, b) || ancestorOf(b, a)) continue;
      const forward = edgeCounts.get(JSON.stringify([a.id, b.id])) ?? 0;
      const reverse = edgeCounts.get(JSON.stringify([b.id, a.id])) ?? 0;
      if (
        Math.min(forward, reverse) < thresholds.minimumReverseImports ||
        Math.min(forward, reverse) / Math.max(forward, reverse) < thresholds.minimumReverseRatio ||
        pairExcepted("deps.cycle", a, b)
      )
        continue;
      issues.push({
        code: "deps.cycle",
        object: `${a.path} <-> ${b.path}`,
        facts: { nodeIds: [a.id, b.id], forwardImports: forward, reverseImports: reverse },
        fix: "Merge these modules or declare allow:deps.cycle with the other module's link on one body line.",
      });
    }
  }

  const eligible = input.commits.filter(
    (commit) => commit.files.length > 0 && commit.changedFiles <= thresholds.maximumCommitFiles,
  );
  const singles = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const commit of eligible) {
    const ids = ordered(
      commit.files.flatMap((file) => {
        const id = owner(file)?.node.id;
        return id ? [id] : [];
      }),
    );
    for (const id of ids) singles.set(id, (singles.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i++)
      for (const id of ids.slice(i + 1)) {
        const key = JSON.stringify([ids[i], id]);
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
  }
  for (const [key, shared] of pairs) {
    const [idA, idB] = JSON.parse(key) as [string, string];
    const pair = [byId.get(idA)!, byId.get(idB)!].sort(
      (a, b) => comparePaths(a.path, b.path) || comparePaths(a.id, b.id),
    );
    const [a, b] = pair as [ModuleMapNode, ModuleMapNode];
    const countA = singles.get(a.id)!;
    const countB = singles.get(b.id)!;
    const ratio = shared / Math.min(countA, countB);
    const lift = (shared * eligible.length) / (countA * countB);
    if (
      shared < thresholds.minimumSharedCommits ||
      ratio < thresholds.minimumSharedRatio ||
      lift < thresholds.minimumLift
    )
      continue;
    const generatedShares = [a, b].map((node) => {
      const facts = factsById.get(node.id)!;
      return facts.generatedFiles / Math.max(1, facts.files.length);
    });
    const generated = generatedShares.some((share) => share > thresholds.generatedMajority);
    const code = generated ? "history.generated-apart" : "history.always-together";
    if (pairExcepted(code, a, b)) continue;
    issues.push({
      code,
      object: `${a.path} + ${b.path}`,
      facts: {
        nodeIds: [a.id, b.id],
        sharedCommits: shared,
        moduleCommits: [countA, countB],
        eligibleCommits: eligible.length,
        ratio,
        lift,
        generatedShares,
      },
      fix: generated
        ? "Keep the generated output and its source in the same module."
        : "Merge these modules or declare allow:history.always-together with the other module's link and their shared change workflow on one body line.",
    });
  }
  const codes: ModuleMapCode[] = [
    "map.uncovered",
    "module.oversized",
    "module.skewed",
    "deps.cycle",
    "history.generated-apart",
    "history.always-together",
  ];
  issues.sort(
    (a, b) =>
      codes.indexOf(a.code) - codes.indexOf(b.code) ||
      comparePaths(a.object, b.object) ||
      comparePaths(JSON.stringify(a.facts), JSON.stringify(b.facts)),
  );
  return {
    issues,
    modules: moduleFacts,
    trackedFiles: trackedFiles.length,
    historyCommits: eligible.length,
    unassignedImports,
  };
}
