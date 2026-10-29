import path from "node:path";
import type { WorkspaceDraftSummary } from "./workspace-draft.js";

export function workspaceDraftCounts(summary: WorkspaceDraftSummary) {
  const issuesByCode: Record<string, number> = {};
  for (const issue of summary.issues)
    issuesByCode[issue.code] = (issuesByCode[issue.code] ?? 0) + 1;
  return {
    modules: summary.modules.length,
    trackedFiles: summary.trackedFiles,
    historyCommits: summary.historyCommits,
    testedBy: summary.modules.reduce((n, module) => n + module.testedBy.length, 0),
    coChanges: summary.modules.reduce((n, module) => n + module.coChanges.length, 0),
    guidanceFiles: summary.guidanceFiles.length,
    warnings: summary.warnings.length,
    issues: summary.issues.length,
    issuesByCode,
    inspectionErrors: summary.inspectionErrors.length,
    importIssues: summary.importIssues.length,
    unassignedImports: summary.unassignedImports.length,
    importEdges: summary.imports.edges.length,
    testImportEdges: summary.testImports.edges.length,
  };
}

type Indexed<T> = { index: number; value: T };
type ImportEvidence = {
  edges: Indexed<WorkspaceDraftSummary["imports"]["edges"][number]>[];
  issues: Indexed<WorkspaceDraftSummary["imports"]["issues"][number]>[];
};

/** Indexes retain original order and distinguish repeated facts from cross-module copies. */
export function serializeWorkspaceDraftReport(
  summary: WorkspaceDraftSummary,
  locations: { draft: string; report: string },
): string {
  const {
    modules,
    history,
    imports,
    testImports,
    issues,
    inspectionErrors,
    importIssues,
    unassignedImports,
    ...global
  } = summary;
  const { edges: importEdges, issues: sourceImportIssues, ...importMetadata } = imports;
  const { edges: testEdges, issues: testImportIssues, ...testImportMetadata } = testImports;
  const rows = modules.map((module, index) => ({
    ref: `@${module.ref}`,
    index,
    module,
    history: [] as Indexed<WorkspaceDraftSummary["history"][number]>[],
    imports: { edges: [], issues: [] } as ImportEvidence,
    testImports: { edges: [], issues: [] } as ImportEvidence,
    issues: [] as Indexed<WorkspaceDraftSummary["issues"][number]>[],
    inspectionErrors: [] as Indexed<WorkspaceDraftSummary["inspectionErrors"][number]>[],
    importIssues: [] as Indexed<WorkspaceDraftSummary["importIssues"][number]>[],
    unassignedImports: [] as Indexed<WorkspaceDraftSummary["unassignedImports"][number]>[],
  }));
  const comparable = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const files = new Map<string, Set<number>>();
  const directories = new Map<string, Set<number>>();
  const add = (map: Map<string, Set<number>>, key: string, index: number) => {
    const owners = map.get(comparable(key)) ?? new Set<number>();
    owners.add(index);
    map.set(comparable(key), owners);
  };
  for (const [index, module] of modules.entries()) {
    for (const file of module.files) {
      add(files, file, index);
      add(directories, path.posix.dirname(file), index);
    }
  }
  const byRef = new Map(modules.map((module, index) => [module.ref, index]));
  const fileOwners = (file: string, directory = false) => [
    ...((directory ? directories : files).get(comparable(file)) ?? []),
  ];
  const refOwners = (ref: unknown) => {
    if (typeof ref !== "string") return [];
    const index = byRef.get(ref.startsWith("@") ? ref.slice(1) : ref);
    return index === undefined ? [] : [index];
  };
  const unowned: object[] = [];
  const distribute = <T>(
    values: readonly T[],
    owners: (value: T) => number[],
    append: (row: (typeof rows)[number], entry: Indexed<T>) => void,
    globalRow: (entry: Indexed<T>) => object,
  ) => {
    values.forEach((value, index) => {
      const entry = { index, value };
      const assigned = new Set(owners(value));
      if (!assigned.size) unowned.push(globalRow(entry));
      for (const owner of assigned) append(rows[owner]!, entry);
    });
  };
  distribute(
    history,
    (commit) => commit.files.flatMap((file) => fileOwners(file)),
    (row, entry) => row.history.push(entry),
    (entry) => ({ history: true, ...entry }),
  );
  for (const [kind, edges, diagnostics] of [
    ["imports", importEdges, sourceImportIssues],
    ["testImports", testEdges, testImportIssues],
  ] as const) {
    distribute(
      edges,
      (edge) => [...fileOwners(edge.from), ...fileOwners(edge.to, edge.kind === "directory")],
      (row, entry) => row[kind].edges.push(entry),
      (entry) => ({ [kind]: "edges", ...entry }),
    );
    distribute(
      diagnostics,
      (issue) => fileOwners(issue.file),
      (row, entry) => row[kind].issues.push(entry),
      (entry) => ({ [kind]: "issues", ...entry }),
    );
  }
  distribute(
    issues,
    (issue) => [
      ...refOwners(issue.object),
      ...modules.flatMap((module, index) => (module.path === issue.object ? [index] : [])),
      ...(Array.isArray(issue.facts.nodeIds) ? issue.facts.nodeIds.flatMap(refOwners) : []),
      ...(Array.isArray(issue.facts.files)
        ? issue.facts.files.flatMap((file) => (typeof file === "string" ? fileOwners(file) : []))
        : []),
    ],
    (row, entry) => row.issues.push(entry),
    (entry) => ({ finding: "issues", ...entry }),
  );
  distribute(
    inspectionErrors,
    (error) => fileOwners(error.node),
    (row, entry) => row.inspectionErrors.push(entry),
    (entry) => ({ finding: "inspectionErrors", ...entry }),
  );
  distribute(
    importIssues,
    (issue) => fileOwners(issue.file),
    (row, entry) => row.importIssues.push(entry),
    (entry) => ({ finding: "importIssues", ...entry }),
  );
  distribute(
    unassignedImports,
    (issue) => [...fileOwners(issue.from), ...fileOwners(issue.to, true)],
    (row, entry) => row.unassignedImports.push(entry),
    (entry) => ({ finding: "unassignedImports", ...entry }),
  );
  return (
    [
      {
        snapshot: true,
        ...locations,
        counts: workspaceDraftCounts(summary),
        ...global,
        imports: importMetadata,
        testImports: testImportMetadata,
      },
      ...rows,
      ...unowned,
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}
