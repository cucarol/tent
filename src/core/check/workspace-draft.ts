import path from "node:path";
import {
  comparePaths,
  isCodeSource,
  isGeneratedSource,
  isTestSource,
} from "../base/repository-imports.js";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { loadTent } from "../store/tree.js";
import { validateNodeName } from "../store/scaffold.js";
import type { NodeWriteBatchInput } from "../write/node-write-batch.js";
import type { WorkspaceScanResult } from "./workspace-scan.js";
import {
  checkModuleMap,
  formatModuleImportIssues,
  isModuleProductionSource,
  type ModuleMapCommit,
  type ModuleMapMaterial,
  type ModuleMapNode,
} from "./module-map.js";

type Unit = { key: string; materials: ModuleMapMaterial[]; frozen?: boolean };
const directory = (file: string) => path.posix.dirname(file);
const ordered = (values: Iterable<string>) => [...new Set(values)].sort(comparePaths);
const material = (value: string, structure = true): ModuleMapMaterial => ({
  path: value.endsWith("/") ? value.slice(0, -1) : value,
  kind: value.endsWith("/") ? "directory" : "prefix",
  ...(structure ? { track: "structure" as const } : {}),
});
const prefix = (file: string) => file.slice(0, file.length - path.posix.extname(file).length) + ".";

function projection(units: Unit[]): ModuleMapNode[] {
  return units.map((unit) => ({
    id: unit.key,
    path: unit.key,
    name: unit.key,
    body: "",
    materials: unit.materials,
  }));
}

/** Condense whole import cycles after ownership changes, including cycles with >2 modules. */
function condense(units: Unit[], scan: WorkspaceScanResult): Unit[] {
  const facts = checkModuleMap({
    trackedFiles: scan.coverage.uncoveredFiles,
    imports: [],
    commits: [],
    nodes: projection(units),
  });
  const owner = new Map(
    facts.modules.flatMap((unit) => unit.files.map((file) => [file, unit.id] as const)),
  );
  const packages = new Map<string, Set<string>>();
  for (const [file, id] of owner)
    if (file.endsWith(".go") && !isTestSource(file)) {
      const dir = directory(file),
        members = packages.get(dir) ?? new Set<string>();
      members.add(id);
      packages.set(dir, members);
    }
  const edges = new Map(units.map((unit) => [unit.key, new Set<string>()]));
  for (const edge of scan.imports.edges) {
    const from = owner.get(edge.from);
    const targets =
      edge.kind === "file" ? [owner.get(edge.to)] : [...(packages.get(edge.to) ?? [])];
    if (from) for (const to of targets) if (to && to !== from) edges.get(from)!.add(to);
  }
  let sequence = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    active = new Set<string>(),
    groups: string[][] = [];
  const visit = (key: string) => {
    indices.set(key, sequence);
    low.set(key, sequence++);
    stack.push(key);
    active.add(key);
    for (const next of edges.get(key)!) {
      if (!indices.has(next)) {
        visit(next);
        low.set(key, Math.min(low.get(key)!, low.get(next)!));
      } else if (active.has(next)) low.set(key, Math.min(low.get(key)!, indices.get(next)!));
    }
    if (low.get(key) !== indices.get(key)) return;
    const group: string[] = [];
    let next: string;
    do {
      next = stack.pop()!;
      active.delete(next);
      group.push(next);
    } while (next !== key);
    groups.push(group.sort(comparePaths));
  };
  for (const unit of units) if (!indices.has(unit.key)) visit(unit.key);
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  return groups
    .map((group) =>
      group.length === 1
        ? byKey.get(group[0])!
        : {
            key: group[0],
            materials: group.flatMap((key) => byKey.get(key)!.materials),
            frozen: true,
          },
    )
    .sort((a, b) => comparePaths(a.key, b.key));
}

/** Suggestions depend only on scan facts. History participates only in the later preflight. */
export function draftWorkspaceModules(scan: WorkspaceScanResult) {
  if (scan.coverage.coveredFiles)
    throw new Error(
      "Existing coverage: maintain the current module map instead of bootstrapping another one",
    );
  const files = ordered(scan.coverage.uncoveredFiles);
  const warnings: string[] = [];
  const ordinary: ModuleMapMaterial[] = [],
    tests: ModuleMapMaterial[] = [];
  let units: Unit[] = [];
  const tops = ordered(
    files.filter((file) => file.includes("/")).map((file) => file.split("/")[0]),
  );
  for (const top of tops) {
    const members = files.filter((file) => file.startsWith(top + "/"));
    const code = members.filter(isCodeSource);
    if (!code.length) {
      ordinary.push(material(top + "/", false));
      continue;
    }
    if (code.every(isTestSource)) {
      tests.push(material(top + "/", false));
      continue;
    }
    let dir = top;
    // Descend wrappers only when they contain no direct files of any kind.
    for (;;) {
      const below = files.filter((file) => file.startsWith(dir + "/"));
      const kids = ordered(below.map((file) => file.slice(dir.length + 1).split("/")[0]));
      if (below.some((file) => directory(file) === dir) || kids.length !== 1) break;
      dir += "/" + kids[0];
    }
    units.push({ key: dir, materials: [material(dir + "/")] });
    if (!code.some(isModuleProductionSource) && code.some(isGeneratedSource))
      warnings.push(`Generated boundary needs review: ${top}/`);
  }
  const roots = files.filter((file) => !file.includes("/"));
  const rootCode = roots.filter((file) => isCodeSource(file) && !isTestSource(file));
  const rootGo = rootCode.filter((file) => file.endsWith(".go"));
  if (rootGo.length)
    units.push({
      key: "Root Go package",
      materials: ordered(rootGo.map(prefix)).map((p) => material(p)),
      frozen: true,
    });
  for (const file of rootCode.filter((file) => !file.endsWith(".go"))) {
    const facts = checkModuleMap({
      trackedFiles: files,
      imports: [],
      commits: [],
      nodes: projection(units),
    });
    const owner = new Map(
      facts.modules.flatMap((unit) => unit.files.map((f) => [f, unit.id] as const)),
    );
    const scores = new Map<string, number>();
    for (const edge of scan.imports.edges) {
      const candidate =
        edge.from === file && edge.kind === "file"
          ? owner.get(edge.to)
          : edge.to === file
            ? owner.get(edge.from)
            : undefined;
      if (candidate) scores.set(candidate, (scores.get(candidate) ?? 0) + 1);
    }
    const ranked = [...scores].sort((a, b) => b[1] - a[1] || comparePaths(a[0], b[0]));
    if (ranked.length && ranked[0][1] > (ranked[1]?.[1] ?? 0)) {
      units.find((unit) => unit.key === ranked[0][0])!.materials.push({ path: file, kind: "file" });
    } else {
      units.push({ key: file, materials: [material(prefix(file))] });
      warnings.push(`Root boundary needs review (no unique import owner): ${file}`);
    }
  }
  for (const file of roots.filter((file) => !rootCode.includes(file)))
    (isTestSource(file) ? tests : ordinary).push({ path: file, kind: "file" });

  const importedPackages = new Set(
    scan.imports.edges.filter((edge) => edge.kind === "directory").map((edge) => edge.to),
  );
  // The checker supplies the same directory/prefix size groups that the Agent will see.
  // Each successful split adds an actual selector; an unsplittable unit is never retried.
  for (;;) {
    const check = checkModuleMap({
      trackedFiles: files,
      imports: [],
      commits: [],
      nodes: projection(units),
    });
    const issue = check.issues.find(
      (item) =>
        ["module.oversized", "module.skewed"].includes(item.code) &&
        !units.find((unit) => unit.key === item.object)!.frozen,
    );
    if (!issue) break;
    const unit = units.find((candidate) => candidate.key === issue.object)!;
    unit.frozen = true;
    const groups = (issue.facts.groups as { path: string }[]).filter(
      (group) =>
        !units.some((other) =>
          other.materials.some((m) => m.path === group.path.replace(/\/$/, "")),
        ),
    );
    const owned = check.modules.find((candidate) => candidate.id === unit.key)!.files;
    // Prefix splitting cannot assign one imported Go package to multiple owners.
    if (
      owned.some((file) => file.endsWith(".go") && importedPackages.has(directory(file))) &&
      groups.some((group) => !group.path.endsWith("/"))
    )
      continue;
    if (groups.length < 2) continue;
    units.push(...groups.map((group) => ({ key: group.path, materials: [material(group.path)] })));
    // Keep the old selector for the remainder; drop it only if it owns no code.
    const split = checkModuleMap({
      trackedFiles: files,
      imports: [],
      commits: [],
      nodes: projection(units),
    });
    const remainder = split.modules.find((candidate) => candidate.id === unit.key)!;
    if (!remainder.productionFiles && !remainder.generatedFiles) {
      for (const file of remainder.files)
        (isTestSource(file) ? tests : ordinary).push({ path: file, kind: "file" });
      units = units.filter((candidate) => candidate !== unit);
    }
  }
  units = condense(units, scan);

  const names = new Set<string>(["setup", "tests"]);
  const nameOf = (key: string) => {
    let base =
      key
        .replace(/[<>:"/\\|?*\x00-\x1f\x7f\u2028\u2029]/g, " ")
        .replace(/^[. ]+|[. ]+$/g, "")
        .slice(0, 170) || "Code";
    try {
      validateNodeName(base.toLowerCase());
    } catch {
      base = `Module ${base}`;
    }
    let name = base,
      n = 2;
    for (;;) {
      try {
        validateNodeName(name.toLowerCase());
        if (!names.has(name.toLowerCase())) break;
      } catch {
        /* Use a safe suffix for reserved names. */
      }
      name = `${base} module ${n++}`;
    }
    names.add(name.toLowerCase());
    return name;
  };
  const nodes: ModuleMapNode[] = [];
  for (const unit of units.sort((a, b) => comparePaths(a.key, b.key))) {
    const name = nameOf(unit.key);
    nodes.push({
      id: `m${nodes.length + 1}`,
      path: name,
      name,
      body: "",
      materials: unit.materials,
    });
  }
  if (ordinary.length)
    nodes.push({
      id: "setup",
      path: "Setup",
      name: "Setup",
      body: "",
      materials: ordinary,
    });
  if (tests.length)
    nodes.push({ id: "tests", path: "Tests", name: "Tests", body: "", materials: tests });
  if (!nodes.length) throw new Error("No tracked Workspace materials to draft");
  const batch: NodeWriteBatchInput = {
    items: nodes.map((node) => ({
      op: "create",
      ref: node.id,
      name: node.name,
      type: "prompt",
      tags: ["spec"],
      body: "",
      sources: node.materials.map((m) => ({
        resource:
          "./" +
          m.path.split("/").map(encodeURIComponent).join("/") +
          (m.kind === "directory" ? "/" : m.kind === "prefix" ? "*" : ""),
        ...(m.track ? { track: m.track } : {}),
      })),
    })),
  };
  return { batch, nodes, warnings };
}

export async function prepareWorkspaceDraft(
  fs: FsAdapter,
  scan: WorkspaceScanResult,
  commits: readonly ModuleMapCommit[],
) {
  if ((await loadTent(readOnlyFs(fs))).byPath.size)
    throw new Error(
      "Existing Nodes: maintain the current module map instead of bootstrapping another one",
    );
  const draft = draftWorkspaceModules(scan);
  const check = checkModuleMap({
    trackedFiles: scan.coverage.uncoveredFiles,
    imports: scan.imports.edges,
    commits,
    nodes: draft.nodes,
  });
  return {
    batch: draft.batch,
    summary: {
      modules: check.modules.map(({ id, name, productionFiles }) => ({
        ref: id,
        name,
        productionFiles,
      })),
      guidanceFiles: scan.guidanceFiles,
      warnings: draft.warnings,
      issues: check.issues,
      inspectionErrors: scan.inspectionErrors,
      importIssues: scan.imports.issues,
      unassignedImports: check.unassignedImports,
      trackedFiles: check.trackedFiles,
      historyCommits: check.historyCommits,
    },
  };
}

export function formatWorkspaceDraft(
  summary: Awaited<ReturnType<typeof prepareWorkspaceDraft>>["summary"],
) {
  const safe = (value: unknown) => JSON.stringify(value);
  return [
    `draft ${summary.modules.length} modules; ${summary.trackedFiles} tracked files; ${summary.historyCommits} history commits`,
    ...summary.modules.map(
      (module) => `${module.ref} ${safe(module.name)} ${module.productionFiles} production files`,
    ),
    `guidance ${safe(summary.guidanceFiles.slice(0, 10))}${summary.guidanceFiles.length > 10 ? `; +${summary.guidanceFiles.length - 10} more in --json` : ""}`,
    ...summary.warnings.map((warning) => `review ${safe(warning)}`),
    ...summary.issues.map(
      (issue) =>
        `${issue.code} ${safe(issue.object)} ${safe(Object.fromEntries(Object.entries(issue.facts).map(([key, value]) => [key, Array.isArray(value) && value.length > 5 ? { count: value.length, examples: value.slice(0, 5) } : value])))} fix: ${issue.fix}`,
    ),
    ...summary.inspectionErrors.map((issue) => `inspection ${safe(issue)}`),
    ...(summary.importIssues.length ? [formatModuleImportIssues(summary.importIssues.length)] : []),
    ...summary.unassignedImports.map((issue) => `unassigned ${safe(issue)}`),
  ].join("\n");
}
