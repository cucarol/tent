import path from "node:path";
import {
  comparePaths,
  extractRepositoryTestImports,
  isCodeSource,
  isGeneratedSource,
  isTestSource,
  type RepositoryImport,
  type RepositorySource,
} from "../base/repository-imports.js";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { loadTent } from "../store/tree.js";
import { validateNodeName } from "../store/scaffold.js";
import type { NodeWriteBatchInput } from "../write/node-write-batch.js";
import type { WorkspaceScanResult } from "./workspace-scan.js";
import { dependencyCycles } from "../base/dependency-cycles.js";
import {
  draftDirectoryUnits,
  draftRootPackageUnits,
  draftMaterial as material,
  draftPrefix as prefix,
  DRAFT_CODE_FILES,
  type DraftUnit as Unit,
} from "./workspace-draft-groups.js";
import {
  checkModuleMap,
  isModuleProductionSource,
  type ModuleMapCommit,
  type ModuleMapMaterial,
  type ModuleMapNode,
} from "./module-map.js";

const directory = (file: string) => path.posix.dirname(file);
const ordered = (values: Iterable<string>) => [...new Set(values)].sort(comparePaths);

function projection(units: Unit[]): ModuleMapNode[] {
  return units.map((unit) => ({
    id: unit.key,
    path: unit.key,
    name: unit.key,
    parentId: unit.parentKey,
    body: "",
    materials: unit.materials,
  }));
}

/** Condense only cycles that still fit the size target after ownership changes. */
function condense(units: Unit[], files: string[], imports: readonly RepositoryImport[]): Unit[] {
  const facts = checkModuleMap({
    trackedFiles: files,
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
  for (const edge of imports) {
    if (isTestSource(edge.from) || isTestSource(edge.to)) continue;
    const from = owner.get(edge.from);
    const targets =
      edge.kind === "file" ? [owner.get(edge.to)] : [...(packages.get(edge.to) ?? [])];
    if (from) for (const to of targets) if (to && to !== from) edges.get(from)!.add(to);
  }
  const counts = new Map(
    facts.modules.map((unit) => [
      unit.id,
      unit.files.filter((file) => isCodeSource(file) && !isTestSource(file)).length,
    ]),
  );
  const cycles = dependencyCycles(edges).filter(
    (cycle) => cycle.reduce((count, key) => count + (counts.get(key) ?? 0), 0) <= DRAFT_CODE_FILES,
  );
  const grouped = new Set(cycles.flat());
  const groups = [
    ...cycles,
    ...units.filter((unit) => !grouped.has(unit.key)).map((unit) => [unit.key]),
  ];
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  const mergedKeys = new Map(
    groups.flatMap((group) => group.map((key) => [key, group[0]!] as const)),
  );
  const ancestors = (key: string) => {
    const result: string[] = [];
    let parent = byKey.get(key)?.parentKey;
    while (parent) {
      result.push(parent);
      parent = byKey.get(parent)?.parentKey;
    }
    return result;
  };
  return groups
    .map((group): Unit => {
      const parent = ancestors(group[0]!).find(
        (key) => !group.includes(key) && group.every((member) => ancestors(member).includes(key)),
      );
      return {
        key: group[0]!,
        ...(group.length === 1
          ? byKey.get(group[0]!)!.name
            ? { name: byKey.get(group[0]!)!.name }
            : {}
          : {
              name: ordered(
                group.map((key) => byKey.get(key)!.name ?? path.posix.basename(key)),
              ).join(" and "),
            }),
        materials: group.flatMap((key) => byKey.get(key)!.materials),
        ...(parent ? { parentKey: mergedKeys.get(parent) } : {}),
      };
    })
    .sort((a, b) => comparePaths(a.key, b.key));
}

/** Suggestions depend only on scan facts. History participates only in the later preflight. */
export function draftWorkspaceModules(scan: WorkspaceScanResult) {
  if (scan.coverage.coveredFiles)
    throw new Error(
      "Existing coverage: maintain the current module map instead of bootstrapping another one",
    );
  const files = ordered(scan.coverage.uncoveredFiles);
  const imports = scan.imports.edges.filter((edge) => edge.execution === "module-load");
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
    units.push(
      ...draftDirectoryUnits(
        dir,
        files.filter((file) => file.startsWith(dir + "/")),
        imports,
      ),
    );
    if (!code.some(isModuleProductionSource) && code.some(isGeneratedSource))
      warnings.push(`Generated boundary needs review: ${top}/`);
  }
  const roots = files.filter((file) => !file.includes("/"));
  const rootCode = roots.filter((file) => isCodeSource(file) && !isTestSource(file));
  const rootGo = rootCode.filter((file) => file.endsWith(".go"));
  if (rootGo.length) units.push(...draftRootPackageUnits(files, imports));
  for (const file of rootCode.filter((file) => !file.endsWith(".go"))) {
    if (
      units.some((unit) =>
        unit.materials.some((source) => source.kind === "prefix" && source.path === prefix(file)),
      )
    )
      continue;
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
    for (const edge of imports) {
      const candidate =
        edge.from === file && edge.kind === "file"
          ? owner.get(edge.to)
          : edge.to === file
            ? owner.get(edge.from)
            : undefined;
      if (candidate && !isTestSource(edge.from))
        scores.set(candidate, (scores.get(candidate) ?? 0) + 1);
    }
    const ranked = [...scores].sort((a, b) => b[1] - a[1] || comparePaths(a[0], b[0]));
    const unique = ranked.length && ranked[0][1] > (ranked[1]?.[1] ?? 0);
    const ownerFiles = unique
      ? facts.modules
          .find((unit) => unit.id === ranked[0][0])!
          .files.filter((file) => isCodeSource(file) && !isTestSource(file)).length
      : 0;
    if (unique && ownerFiles < DRAFT_CODE_FILES) {
      units.find((unit) => unit.key === ranked[0][0])!.materials.push({ path: file, kind: "file" });
    } else {
      units.push({ key: file, materials: [material(prefix(file))] });
      warnings.push(
        `Root boundary needs review (${unique ? "import owner at draft size target" : "no unique import owner"}): ${file}`,
      );
    }
  }
  for (const file of roots.filter((file) => !rootCode.includes(file)))
    (isTestSource(file) ? tests : ordinary).push({ path: file, kind: "file" });

  units = condense(units, files, imports);
  const sizes = checkModuleMap({
    trackedFiles: files,
    imports: [],
    commits: [],
    nodes: projection(units),
  });
  for (const unit of sizes.modules) {
    const count = unit.files.filter((file) => isCodeSource(file) && !isTestSource(file)).length;
    if (count > DRAFT_CODE_FILES)
      warnings.push(
        `Boundary exceeds ${DRAFT_CODE_FILES}-file draft target; review its generated-source family: ${unit.path} (${count} code files)`,
      );
  }

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
  const unitNodes = new Map<string, ModuleMapNode>();
  const addUnit = (unit: Unit): ModuleMapNode => {
    const existing = unitNodes.get(unit.key);
    if (existing) return existing;
    const parent = unit.parentKey
      ? addUnit(units.find((candidate) => candidate.key === unit.parentKey)!)
      : undefined;
    const name = nameOf(unit.name ?? (parent ? path.posix.basename(unit.key) : unit.key));
    const node: ModuleMapNode = {
      id: `m${nodes.length + 1}`,
      path: parent ? `${parent.path}/${name}` : name,
      name,
      ...(parent ? { parentId: parent.id } : {}),
      body: "",
      materials: unit.materials,
    };
    nodes.push(node);
    unitNodes.set(unit.key, node);
    return node;
  };
  for (const unit of units.sort((a, b) => comparePaths(a.key, b.key))) {
    addUnit(unit);
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
      ...(node.parentId ? { parent: `@${node.parentId}` } : {}),
      name: node.name,
      type: "goal",
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
  sources: readonly RepositorySource[] = [],
) {
  if ((await loadTent(readOnlyFs(fs))).byPath.size)
    throw new Error(
      "Existing Nodes: maintain the current module map instead of bootstrapping another one",
    );
  const draft = draftWorkspaceModules(scan);
  const testImports = extractRepositoryTestImports(sources);
  const check = checkModuleMap({
    trackedFiles: scan.coverage.uncoveredFiles,
    imports: [...scan.imports.edges, ...testImports.edges],
    commits,
    nodes: draft.nodes,
  });
  return {
    batch: draft.batch,
    summary: {
      modules: check.modules.map(
        ({ id, path, name, files, productionFiles, testedBy, coChanges }) => ({
          ref: id,
          path,
          name,
          files,
          ...(draft.nodes.find((node) => node.id === id)?.parentId
            ? { parent: draft.nodes.find((node) => node.id === id)!.parentId }
            : {}),
          productionFiles,
          testedBy,
          coChanges,
        }),
      ),
      guidanceFiles: scan.guidanceFiles,
      warnings: draft.warnings,
      issues: check.issues,
      inspectionErrors: scan.inspectionErrors,
      importIssues: [
        ...new Map(
          [...scan.imports.issues, ...testImports.issues].map((issue) => [
            JSON.stringify(issue),
            issue,
          ]),
        ).values(),
      ].sort((a, b) => comparePaths(JSON.stringify(a), JSON.stringify(b))),
      unassignedImports: check.unassignedImports,
      trackedFiles: check.trackedFiles,
      historyCommits: check.historyCommits,
      head: scan.head,
      history: commits,
      imports: scan.imports,
      testImports,
    },
  };
}

export type WorkspaceDraftSummary = Awaited<ReturnType<typeof prepareWorkspaceDraft>>["summary"];
export {
  formatWorkspaceDraft,
  workspaceDraftReportPath,
  workspaceDraftExitCode,
} from "./workspace-draft-receipt.js";
