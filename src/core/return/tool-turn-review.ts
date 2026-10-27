import { materialCoverageContains } from "../base/material-coverage-match.js";
import type { StopMaterialIndex } from "./stop-material-index.js";

export type TurnReviewModule = { nodeId: string; path: string; names: string[]; files: string[] };

export function modulesForIndexedTurn(
  index: StopMaterialIndex,
  event: {
    files: { kind: "provided" | "read" | "written"; address: string }[];
    cancelled?: true;
  },
): TurnReviewModule[] {
  if (event.cancelled) return [];
  const modules = index.nodes
    .filter((node) => node.moduleCoverage.length)
    .map((node) => ({ node, coverage: node.moduleCoverage, files: new Set<string>() }));
  for (const file of event.files.filter((file) => file.kind === "written")) {
    const matches = modules.flatMap((module) => {
      const covering = module.coverage.filter((coverage) =>
        materialCoverageContains(coverage, file.address),
      );
      return covering.length
        ? [{ module, specificity: Math.max(...covering.map((coverage) => coverage.prefix.length)) }]
        : [];
    });
    const mostSpecific = Math.max(...matches.map((match) => match.specificity));
    for (const match of matches)
      if (match.specificity === mostSpecific) match.module.files.add(file.address);
  }
  return modules
    .filter((module) => module.files.size)
    .sort((a, b) => b.files.size - a.files.size || a.node.path.localeCompare(b.node.path))
    .map(({ node, files }) => ({
      nodeId: node.nodeId,
      path: node.path,
      names: node.names,
      files: [...files].sort(),
    }));
}

export const TOOL_REVIEW_ACTION =
  "Check them before you end this turn. If one now says something the change made wrong, edit that sentence in its file. If the change settled a rule or a rejected option that also binds code it did not touch, or hit a dead end, add one short section: tent node append <nodeId> --heading <title> --body -. A lesson about these lines belongs in a code comment or a test. Otherwise say nothing about it.";
export const ANSWER_REVIEW =
  "Tent: the user just answered. If the answer settles a requirement or a decision, record it in the Node it belongs to before you end this turn; otherwise say nothing about it.";
const shown = (value: string) =>
  /[\r\n\t\u2028\u2029]/.test(value) ? JSON.stringify(value) : value;

/** Core budgets plain text and returns the Nodes actually named. */
export function formatToolTurnReview(
  textByteLimit: number,
  modules: TurnReviewModule[],
): { message: string; nodeIds: string[] } | undefined {
  const selected = modules
    .slice(0, 5)
    .map((module) => ({ ...module, files: module.files.slice(0, 8) }));
  const render = () =>
    [
      "Tent: these Nodes cover the file you just changed:",
      ...selected.map(
        (module) =>
          `- ${module.names.map(shown).join(" / ")} (${shown(module.nodeId)}, ${shown(module.path)}): ${module.files.map(shown).join(", ")}`,
      ),
      ...(modules.length > selected.length
        ? [`+${modules.length - selected.length} more modules`]
        : []),
      TOOL_REVIEW_ACTION,
    ].join("\n");
  while (selected.length && Buffer.byteLength(render()) > textByteLimit) {
    const withFiles = [...selected].reverse().find((module) => module.files.length > 0);
    if (withFiles) withFiles.files.pop();
    else selected.pop();
  }
  return selected.length
    ? { message: render(), nodeIds: selected.map((module) => module.nodeId) }
    : undefined;
}
