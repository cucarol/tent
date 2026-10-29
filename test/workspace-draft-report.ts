import assert from "node:assert/strict";
import type { WorkspaceDraftSummary } from "../src/core/check/workspace-draft.js";

type Entry = { index: number; value: unknown };
type SnapshotHeader = Pick<
  WorkspaceDraftSummary,
  "guidanceFiles" | "warnings" | "trackedFiles" | "historyCommits" | "head"
> & {
  snapshot: boolean;
  draft: string;
  report: string;
  counts: unknown;
  imports: Omit<WorkspaceDraftSummary["imports"], "edges" | "issues">;
  testImports: Omit<WorkspaceDraftSummary["testImports"], "edges" | "issues">;
};

/** Test-only reconstruction proves the report retains sequence, duplicates and every field. */
export function readWorkspaceDraftReport(raw: string): WorkspaceDraftSummary {
  assert.ok(raw.endsWith("\n"));
  const rows: Record<string, unknown>[] = raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const [header] = rows;
  assert.equal(Object.keys(header!)[0], "snapshot");
  const modules = rows.filter((row) => Object.keys(row)[0] === "ref");
  const collect = <T>(key: string, group?: "imports" | "testImports"): T[] => {
    const entries: Entry[] = [];
    for (const row of rows.slice(1)) {
      if (typeof row.ref === "string") {
        const evidence = group ? (row[group] as Record<string, unknown>) : row;
        entries.push(...(evidence[key] as Entry[]));
      } else if (
        group
          ? row[group] === key
          : row.finding === key || (key === "history" && row.history === true)
      ) {
        entries.push({ index: row.index as number, value: row.value });
      }
    }
    const byIndex = new Map<number, unknown>();
    for (const entry of entries) {
      if (byIndex.has(entry.index)) assert.deepEqual(entry.value, byIndex.get(entry.index));
      byIndex.set(entry.index, entry.value);
    }
    const ordered = [...byIndex].sort(([a], [b]) => a - b);
    assert.deepEqual(
      ordered.map(([index]) => index),
      ordered.map((_, index) => index),
    );
    return ordered.map(([, value]) => value as T);
  };
  const { snapshot, draft, report, counts, imports, testImports, ...global } =
    header as SnapshotHeader;
  assert.equal(snapshot, true);
  assert.equal(typeof draft, "string");
  assert.equal(typeof report, "string");
  assert.ok(counts);
  return {
    ...global,
    modules: modules
      .sort((a, b) => (a.index as number) - (b.index as number))
      .map((row) => row.module as WorkspaceDraftSummary["modules"][number]),
    history: collect("history"),
    imports: {
      ...imports,
      edges: collect("edges", "imports"),
      issues: collect("issues", "imports"),
    },
    testImports: {
      ...testImports,
      edges: collect("edges", "testImports"),
      issues: collect("issues", "testImports"),
    },
    issues: collect("issues"),
    inspectionErrors: collect("inspectionErrors"),
    importIssues: collect("importIssues"),
    unassignedImports: collect("unassignedImports"),
  };
}
