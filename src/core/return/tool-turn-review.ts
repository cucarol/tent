import { materialCoverageContains } from "../base/material-coverage-match.js";
import { isModuleProductionSource } from "../base/source-kind.js";
import { sectionKey } from "./section-fingerprint.js";
import type { StopMaterialFile, StopMaterialIndex } from "./stop-material-index.js";

export type TurnReviewNode = { nodeId: string; path: string; names: string[]; body?: string };
export type TurnReviewModule = TurnReviewNode & { files: string[]; rules?: TurnReviewNode[] };

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
  "If one now says something the change made wrong, edit that sentence in its file. If the change settled a rule or a rejected option that also binds code it did not touch, or hit a dead end, add one short section: tent node append <nodeId> --heading <title> --body -. A lesson about these lines belongs in a code comment or a test. Otherwise say nothing about Tent.";
export const ANSWER_REVIEW =
  "Tent: the user just answered. If the answer settles a requirement or a decision, record it in the Node it belongs to before you end this turn; otherwise say nothing about it.";
const shown = (value: string) =>
  /[\r\n\t\u2028\u2029]/.test(value) ? JSON.stringify(value) : value;
const resourceArgument = (value: string) => {
  if (/^[\w./-]+$/.test(value)) return value;
  // PowerShell also recognizes curly single quotes as string delimiters.
  return process.platform === "win32"
    ? `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
};

/** Core budgets plain text and returns every owner and rule whose text was delivered. */
export function formatToolTurnReview(
  textByteLimit: number,
  modules: TurnReviewModule[],
  scope: "tool" | "turn" = "tool",
):
  | { message: string; nodeIds: string[]; ownerNodeIds: string[]; ruleNodeIds: string[] }
  | undefined {
  type Entry = {
    node: TurnReviewNode;
    owner?: TurnReviewModule;
    resource: string;
    points: string[];
    limit: number;
  };
  const ownerIds = new Set(modules.map((module) => module.nodeId));
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const add = (node: TurnReviewNode, module: TurnReviewModule, owner?: TurnReviewModule) => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const points = [...(node.body ?? "")];
    entries.push({
      node,
      owner,
      resource: module.files[0] ?? "",
      points,
      limit: Math.min(1600, points.length),
    });
  };
  for (const module of modules) {
    add(module, module, module);
    for (const rule of module.rules ?? []) if (!ownerIds.has(rule.nodeId)) add(rule, module);
  }
  if (!entries.length) return;
  const selected: Entry[] = [];
  const label = (node: TurnReviewNode) =>
    `${node.names.map(shown).join(" / ")} (${shown(node.nodeId)}, ${shown(node.path)})`;
  const omittedGroups = () => {
    const omitted = new Map<string, number>();
    for (const entry of entries.slice(selected.length))
      omitted.set(entry.resource, (omitted.get(entry.resource) ?? 0) + 1);
    return [...omitted].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  };
  const render = (hints: string[] = [], remaining = omittedGroups()) => {
    const blocks = [
      scope === "turn"
        ? "Tent: these Nodes cover files changed during this turn."
        : "Tent: these Nodes cover the file you just changed.",
    ];
    let rules = false;
    for (const entry of selected) {
      const { node, owner, points, limit } = entry;
      const ruleHeading = !owner && !rules ? "Rules over it:\n" : "";
      rules = !owner;
      const text = points.slice(0, limit).join("");
      const cut = limit < points.length ? `\n… (cut; the rest is in ${shown(node.path)})` : "";
      blocks.push(
        `${ruleHeading}${label(node)}${owner ? ` covers ${owner.files.map(shown).join(", ")}` : ""}:\n${text}${cut}`,
      );
    }
    blocks.push(...hints);
    if (remaining.length)
      blocks.push(
        `${remaining.reduce((total, [, count]) => total + count, 0)} more Nodes cover ${remaining.length} other changed files: run tent node search --resource on each.`,
      );
    blocks.push(TOOL_REVIEW_ACTION);
    return blocks.join("\n\n");
  };
  for (const entry of entries) {
    selected.push(entry);
    if (Buffer.byteLength(render()) <= textByteLimit) continue;
    let low = entry.points.length ? 1 : 0;
    let high = entry.limit - 1;
    let fitting = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      entry.limit = middle;
      if (Buffer.byteLength(render()) <= textByteLimit) {
        fitting = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (fitting < 0) selected.pop();
    else entry.limit = fitting;
    break;
  }
  if (Buffer.byteLength(render()) > textByteLimit) return;
  // Body prefixes have priority. Only their remaining room is available to file
  // recovery lines; reserve the aggregate line until every omitted group is named.
  const groups = omittedGroups();
  const hints: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const [resource, count] = groups[i];
    const line = `${count} more Nodes: tent node search --resource ${resourceArgument(resource)}`;
    if (Buffer.byteLength(render([...hints, line], groups.slice(i + 1))) > textByteLimit) break;
    hints.push(line);
  }
  return {
    message: render(hints, groups.slice(hints.length)),
    nodeIds: selected.map((entry) => entry.node.nodeId),
    ownerNodeIds: selected.flatMap((entry) => (entry.owner ? [entry.node.nodeId] : [])),
    ruleNodeIds: selected.flatMap((entry) => (entry.owner ? [] : [entry.node.nodeId])),
  };
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
):
  | {
      message: string;
      nodeIds: string[];
      ownerNodeIds: string[];
      ruleNodeIds: string[];
      files: string[];
    }
  | undefined {
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
    ownerNodeIds: review?.ownerNodeIds ?? [],
    ruleNodeIds: review?.ruleNodeIds ?? [],
    files: note?.files ?? [],
  };
}
