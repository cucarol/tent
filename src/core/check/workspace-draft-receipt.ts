import path from "node:path";
import type { WorkspaceDraftSummary } from "./workspace-draft.js";
import { workspaceDraftCounts } from "./workspace-draft-report.js";

const RECEIPT_BYTES = 4096;

/** Shared by draft publication and staged consumption. */
export function workspaceDraftReportPath(filename: string): string {
  return /\.json$/i.test(filename)
    ? filename.replace(/\.json$/i, ".report.json")
    : filename + ".report.json";
}

type Locations = { workspaceRoot: string; draft: string; report: string };
type SampleKey =
  | "guidanceFiles"
  | "issues"
  | "inspectionErrors"
  | "unassignedImports"
  | "warnings"
  | "importIssues"
  | "parts";

export function workspaceDraftExitCode(summary: WorkspaceDraftSummary): 0 | 1 {
  return summary.issues.length ||
    summary.inspectionErrors.length ||
    summary.unassignedImports.length
    ? 1
    : 0;
}

/** Final serialization is budgeted, including JSON escaping and the stdout newline. */
export function formatWorkspaceDraft(
  summary: WorkspaceDraftSummary,
  locations: Locations,
  json = false,
): string {
  const counts = workspaceDraftCounts(summary);
  const relative = (filename: string) => {
    const local = path.relative(locations.workspaceRoot, filename);
    return local.length < filename.length ? local || "." : filename;
  };
  const receipt = {
    draft: relative(locations.draft),
    report: relative(locations.report),
    pathBase: "Relative paths start at Workspace",
    reportLocation:
      'Next to the --draft file: replace its .json suffix with .report.json, or append .report.json. JSON Lines: paths in snapshot header; search "ref":"@<ref>" for one part.',
    counts,
    examples: {} as Partial<Record<SampleKey, unknown[]>>,
    omitted: {} as Record<string, { count: number; at: string }>,
  };
  const sampleLocation = (key: SampleKey) =>
    key === "guidanceFiles" || key === "warnings"
      ? `snapshot header: ${key}`
      : key === "parts"
        ? 'ref lines (search "ref":"@<ref>"): part'
        : `ref/finding lines: ${key}`;
  const samples: Record<SampleKey, readonly unknown[]> = {
    guidanceFiles: summary.guidanceFiles,
    issues: summary.issues.map(({ code, object, fix }) => ({ code, object, fix })),
    inspectionErrors: summary.inspectionErrors,
    unassignedImports: summary.unassignedImports,
    warnings: summary.warnings,
    importIssues: summary.importIssues,
    parts: summary.parts.map(({ ref, path, parent, textFiles }) => ({
      ref,
      path,
      ...(parent ? { parent } : {}),
      textFiles,
    })),
  };
  for (const [key, items] of Object.entries(samples)) {
    if (items.length)
      receipt.omitted[key] = { count: items.length, at: sampleLocation(key as SampleKey) };
  }
  // Raw history, imports and per-part evidence stay in the snapshot report.
  for (const [key, count, at] of [
    ["history", summary.history.length, "ref/history lines: history"],
    ["imports", summary.imports.edges.length, "ref/imports lines: imports.edges"],
    ["testImports", summary.testImports.edges.length, "ref/testImports lines: testImports.edges"],
    ["testedBy", counts.testedBy, "ref lines: part.testedBy"],
    ["coChanges", counts.coChanges, "ref lines: part.coChanges"],
    ["issueFacts", counts.issues, "ref/finding lines: issues.value.facts"],
  ] as const) {
    if (count) receipt.omitted[key] = { count, at };
  }
  const render = () =>
    json
      ? JSON.stringify(receipt) + "\n"
      : [
          `draft ${counts.parts} parts; ${counts.trackedFiles} tracked files; ${counts.historyCommits} history commits`,
          `draft-file ${JSON.stringify(receipt.draft)}; report-file ${JSON.stringify(receipt.report)} (relative paths start at Workspace)`,
          receipt.reportLocation,
          `counts ${JSON.stringify(counts)}`,
          ...Object.entries(receipt.examples).flatMap(([key, items]) =>
            items.map((item) => `${key} ${JSON.stringify(item)}`),
          ),
          ...Object.entries(receipt.omitted).map(
            ([key, value]) => `${key}: ${value.count} omitted; report ${value.at}`,
          ),
          ...(counts.importIssues
            ? ["Import issues describe unresolved code references; they are advisory."]
            : []),
        ].join("\n") + "\n";

  // Round-robin gives each actionable category and guidance a chance before extra rows.
  // Each sample is whole; omitted evidence always has a count and an exact report location.
  const keys = Object.keys(samples) as SampleKey[];
  for (let row = 0; row < 3; row++) {
    for (const key of keys) {
      const item = samples[key][row];
      if (item === undefined) continue;
      const shown = receipt.examples[key] ?? (receipt.examples[key] = []);
      shown.push(item);
      const remaining = samples[key].length - shown.length;
      if (remaining) receipt.omitted[key] = { count: remaining, at: sampleLocation(key) };
      else delete receipt.omitted[key];
      if (Buffer.byteLength(render(), "utf8") > RECEIPT_BYTES) {
        shown.pop();
        if (!shown.length) delete receipt.examples[key];
        receipt.omitted[key] = {
          count: samples[key].length - shown.length,
          at: sampleLocation(key),
        };
      }
    }
  }
  return render();
}
