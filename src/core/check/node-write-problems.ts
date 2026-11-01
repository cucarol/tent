import type { GraphCheckIssue, GraphCheckResult } from "./graph-check.js";

export type NodeWriteProblem =
  | ({ category: "issue" } & GraphCheckIssue)
  | ({ category: "notice" } & GraphCheckResult["notices"][number])
  | ({ category: "error" } & GraphCheckResult["errors"][number]);

/** Shared human receipt for CLI writes and native write Hooks. */
export function formatNodeWriteProblems(
  problems: readonly NodeWriteProblem[],
  textByteLimit?: number,
  measureBytes: (text: string) => number = Buffer.byteLength,
): string {
  const grouped = new Map<string, string[]>();
  for (const problem of problems) {
    const detail =
      problem.category === "issue"
        ? `${problem.kind}: ${"target" in problem ? problem.target : "state" in problem ? problem.state : (problem.resource ?? problem.field)} — ${problem.reason}`
        : problem.category === "notice"
          ? `${problem.resource ?? problem.field ?? "Material"} — ${problem.reason}`
          : problem.reason;
    const lines = grouped.get(problem.path) ?? [];
    if (!lines.includes(detail)) lines.push(detail);
    grouped.set(problem.path, lines);
  }
  const entries = [...grouped].flatMap(([file, lines]) =>
    lines.map((detail) => ({ file, detail })),
  );
  function render(visible: typeof entries, omitted: number): string {
    const groups: Array<{ file: string; lines: string[] }> = [];
    for (const entry of visible) {
      let group = groups.at(-1);
      if (!group || group.file !== entry.file) {
        group = { file: entry.file, lines: [] };
        groups.push(group);
      }
      group.lines.push(`- ${entry.detail}`);
    }
    if (omitted && groups.length)
      groups.at(-1)!.lines.push(`${omitted} more problems: tent workspace check --json`);
    return groups
      .map(
        ({ file, lines }) =>
          `Tent: ${file} has problems:\n${lines.join("\n")}\nFix them before you end this turn.`,
      )
      .join("\n\n");
  }
  const full = render(entries, 0);
  if (textByteLimit === undefined || measureBytes(full) <= textByteLimit) return full;
  const visible: typeof entries = [];
  let output = "";
  for (const entry of entries) {
    const candidate = render([...visible, entry], entries.length - visible.length - 1);
    if (measureBytes(candidate) > textByteLimit) break;
    visible.push(entry);
    output = candidate;
  }
  if (visible.length || !entries.length) return output;
  const first = entries[0]!;
  const points = [...first.detail];
  const truncated = (length: number) =>
    render(
      [{ file: first.file, detail: points.slice(0, length).join("") + "…" }],
      entries.length - 1,
    );
  if (measureBytes(truncated(0)) > textByteLimit) return "";
  let lower = 0;
  let upper = points.length - 1;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (measureBytes(truncated(middle)) <= textByteLimit) lower = middle;
    else upper = middle - 1;
  }
  return truncated(lower);
}
