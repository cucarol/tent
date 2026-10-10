import type { NodeCatalog } from "./node-catalog.js";
import type { SessionObservationEvent } from "./session-observations.js";
import { materialCoverageContains } from "./material-coverage.js";
import { buildStopMaterialIndex, type StopMaterialIndex } from "./stop-material-index.js";
import type { StopQuestion } from "./stop-advice.js";

export type StopHost = "codex" | "claude-code";
export type TurnReviewModule = { nodeId: string; path: string; names: string[]; files: string[] };

export function stopReviewEnvelope(host: StopHost, message: string) {
  return host === "codex"
    ? { decision: "block", reason: message }
    : { hookSpecificOutput: { hookEventName: "Stop", additionalContext: message } };
}

/** Only this turn's saved writes count; equally specific modules retain shared ownership. */
export function modulesForObservedTurn(
  catalog: NodeCatalog,
  workspaceRoot: string,
  event: SessionObservationEvent,
  invalidNodePaths: readonly string[] = [],
): TurnReviewModule[] {
  return modulesForIndexedTurn(
    buildStopMaterialIndex(catalog, workspaceRoot, invalidNodePaths),
    event,
  );
}

export function modulesForIndexedTurn(
  index: StopMaterialIndex,
  event: SessionObservationEvent,
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
    .sort((a, b) => a.node.path.localeCompare(b.node.path))
    .map(({ node, files }) => ({
      nodeId: node.nodeId,
      path: node.path,
      names: node.names,
      files: [...files].sort(),
    }));
}

export const TURN_REVIEW_RULE =
  "Tent keeps what code cannot hold: a rule or a rejected option that also binds code this turn did not touch, or a dead end. A lesson about these lines belongs in a code comment or a test.";
export const TURN_REVIEW_ACTION =
  "If one of these Nodes now says something this turn made wrong, edit that sentence in its file. If this turn produced something worth keeping, add one short section: tent node append <nodeId> --heading <title> --body -. If neither applies, reply that nothing needs recording; no command is needed.";
const shown = (value: string) =>
  /[\r\n\t\u2028\u2029]/.test(value) ? JSON.stringify(value) : value;
const shorten = (value: string, limit: number) =>
  Array.from(value).length > limit
    ? Array.from(value)
        .slice(0, limit - 1)
        .join("") + "…"
    : value;

/** Budget the complete native JSON. Drop filenames, then modules; keep every question kind. */
export function formatStopTurnReview(
  host: StopHost,
  modules: TurnReviewModule[],
  questions: StopQuestion[],
  uncertain = false,
): string | undefined {
  if (!modules.length) return undefined;
  const selected = modules
    .slice(0, 5)
    .map((module) => ({ ...module, files: module.files.slice(0, 8) }));
  let questionLimit = 180;
  let includeUncertain = uncertain;
  const render = () =>
    [
      "Tent turn review. This turn changed files that these Nodes cover:",
      ...selected.map(
        (module) =>
          `- ${module.names.map(shown).join(" / ")} (${shown(module.nodeId)}, ${shown(module.path)})${module.files.length ? `: ${module.files.map(shown).join(", ")}` : ""}`,
      ),
      ...(modules.length > selected.length
        ? [`+${modules.length - selected.length} more modules`]
        : []),
      TURN_REVIEW_RULE,
      TURN_REVIEW_ACTION,
      ...questions
        .slice(0, 3)
        .map(
          (question, index) =>
            `${index + 1}. ${shorten(question.question, questionLimit)}\nOptions: ${question.answers.map((answer) => shorten(answer, questionLimit)).join("; ")}.`,
        ),
      ...(includeUncertain
        ? ["Some observations are incomplete; workspace brief shows the current state."]
        : []),
    ].join("\n");
  const fits = () =>
    Buffer.byteLength(JSON.stringify(stopReviewEnvelope(host, render())) + "\n", "utf8") <= 2048;
  while (!fits() && selected.some((module) => module.files.length))
    [...selected]
      .reverse()
      .find((module) => module.files.length)!
      .files.pop();
  while (!fits() && selected.length) selected.pop();
  while (!fits() && questionLimit > 8) questionLimit = Math.max(8, Math.floor(questionLimit / 2));
  if (!fits()) includeUncertain = false;
  return fits() ? render() : undefined;
}
