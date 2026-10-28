import { materialCoverageContains } from "../base/material-coverage-match.js";
import { isModuleProductionSource } from "../base/source-kind.js";
import { sectionKey } from "./section-fingerprint.js";
import type { StopMaterialFile, StopMaterialIndex } from "./stop-material-index.js";

export type TurnReviewModule = { nodeId: string; path: string; names: string[]; files: string[] };

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Hand-written product code that no module owns, as the module map's unowned and uncovered checks see it. */
export function unownedFilesForTurn(
  index: StopMaterialIndex,
  written: readonly string[],
): string[] {
  const modules = index.nodes.filter((node) => node.moduleCoverage.length);
  return [...new Set(written)]
    .filter(
      (address) =>
        isModuleProductionSource(address) &&
        !modules.some(
          (node) =>
            node.moduleMaterials.some((coverage) => materialCoverageContains(coverage, address)) ||
            node.materialFiles.some((file) => samePath(file.path, address)),
        ),
    )
    .sort();
}

/** Linked Markdown sections in the written files; the caller decides which of them changed. */
export function sectionsForTurn(
  index: StopMaterialIndex,
  written: readonly string[],
): Map<string, Required<StopMaterialFile>> {
  const sections = new Map<string, Required<StopMaterialFile>>();
  for (const node of index.nodes)
    for (const file of node.materialFiles)
      if (file.heading !== undefined && written.some((address) => samePath(address, file.path)))
        sections.set(sectionKey(file.path, file.heading), {
          path: file.path,
          heading: file.heading,
        });
  return sections;
}

/** Nodes that link any of these sections. */
export function nodesLinkingSections(
  index: StopMaterialIndex,
  sections: ReadonlySet<string>,
): Set<string> {
  return new Set(
    index.nodes
      .filter((node) =>
        node.materialFiles.some(
          (file) => file.heading !== undefined && sections.has(sectionKey(file.path, file.heading)),
        ),
      )
      .map((node) => node.nodeId),
  );
}

export function modulesForIndexedTurn(
  index: StopMaterialIndex,
  event: {
    files: { kind: "provided" | "read" | "written"; address: string }[];
    cancelled?: true;
    changedSections?: ReadonlySet<string>;
  },
): TurnReviewModule[] {
  if (event.cancelled) return [];
  const modules = index.nodes
    .filter((node) => node.moduleCoverage.length || node.materialFiles.length)
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
    // Every Node resting on the file is named, beside the most specific module.
    for (const module of modules)
      if (
        module.node.materialFiles.some(
          (material) =>
            samePath(material.path, file.address) &&
            (material.heading === undefined ||
              !!event.changedSections?.has(sectionKey(material.path, material.heading))),
        )
      )
        module.files.add(file.address);
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

const unownedReview = (paths: string) =>
  `Tent: no module Node owns these files: ${paths}. Before you end this turn, add a directory or filename-prefix source with track: structure to the module Node that owns them, or create a module Node if they start a new area. If they are temporary, say nothing about them.`;
const unownedPaths = (shownFiles: string[], total: number) =>
  [
    ...shownFiles.map(shown),
    ...(total > shownFiles.length ? [`+${total - shownFiles.length} more`] : []),
  ].join(", ");

/** At most eight paths, dropped from the end until the note fits; the files actually named are returned. */
export function formatUnownedFiles(
  textByteLimit: number,
  files: string[],
): { message: string; files: string[] } | undefined {
  const selected = files.slice(0, 8);
  const render = () => unownedReview(unownedPaths(selected, files.length));
  while (selected.length && Buffer.byteLength(render()) > textByteLimit) selected.pop();
  return selected.length ? { message: render(), files: selected } : undefined;
}

/**
 * One context for one write: the covering Nodes take the whole budget first, and the
 * unowned note gets what remains, losing paths from the end or dropping out entirely.
 */
export function formatWriteReview(
  textByteLimit: number,
  modules: TurnReviewModule[],
  files: string[],
): { message: string; nodeIds: string[]; files: string[] } | undefined {
  const gap = "\n\n";
  const review = modules.length ? formatToolTurnReview(textByteLimit, modules) : undefined;
  const note = files.length
    ? formatUnownedFiles(
        textByteLimit - (review ? Buffer.byteLength(review.message + gap) : 0),
        files,
      )
    : undefined;
  if (!review && !note) return undefined;
  return {
    message: [review?.message, note?.message].filter((part) => part !== undefined).join(gap),
    nodeIds: review?.nodeIds ?? [],
    files: note?.files ?? [],
  };
}
