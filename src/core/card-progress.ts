import { readOnlyFs, type FsAdapter } from "./adapter.js";
import type { CardDocumentState } from "./card-document.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isNodeId } from "./id.js";
import { documentVersionSchema, type DocumentVersion } from "./git-history.js";
import { materialLocator, type MaterialSource } from "./material.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { isRequirementNode, isOutputNode } from "./node-sync-record.js";
import { documentLifecycle } from "./document-status.js";
import { nodeVerifications, okfTimestampSchema } from "./node-provenance.js";
import { cardRecordPath, nodeNotePath } from "./paths.js";

export type CardProgress = "pending" | "received-no-output" | "has-output";
export type CardProgressItem = {
  progress: CardProgress | null;
  goalCount: number;
  totalGoalCount: number;
  outputNodeIds: string[];
  diagnostic?: string;
};
export type CardProgressInput = {
  cardId: string;
  state: CardDocumentState;
  sources: readonly MaterialSource[];
};

export function deriveCardProgress(
  state: CardDocumentState,
  totalGoalCount: number,
  goalCount = 0,
  outputNodeIds: readonly string[] = [],
): CardProgressItem {
  return {
    progress: !totalGoalCount
      ? null
      : state === "pending"
        ? "pending"
        : goalCount === totalGoalCount
          ? "has-output"
          : "received-no-output",
    goalCount,
    totalGoalCount,
    outputNodeIds: [...new Set(outputNodeIds)].sort(),
  };
}

/** Read only the versions pinned by these Cards, never replay document history. */
export async function readCardGoalIds(fs: FsAdapter, cards: readonly CardProgressInput[]) {
  const result = new Map(
    cards.map((card) => [card.cardId, { goalIds: new Set<string>(), diagnostics: [] as string[] }]),
  );
  const selected = cards.flatMap((card) =>
    card.sources.flatMap((source) => {
      if (!source.version) return [];
      const version = documentVersionSchema.safeParse(source.version);
      if (!version.success) {
        result.get(card.cardId)!.diagnostics.push(`Invalid source version: ${source.resource}`);
        return [];
      }
      return [{ cardId: card.cardId, source, version: version.data }];
    }),
  );
  if (!selected.length) return result;
  if (!fs.history || !(await fs.exists(".git"))) {
    for (const entry of selected)
      result.get(entry.cardId)!.diagnostics.push("Card source history unavailable");
    return result;
  }
  const key = (v: DocumentVersion) => `${v.commit}:${v.path}`;
  const versions = [
    ...new Map(selected.map((entry) => [key(entry.version), entry.version])).values(),
  ];
  const reads = await fs.history.readVersions(versions);
  const byVersion = new Map(versions.map((version, index) => [key(version), reads[index]!]));
  for (const entry of selected) {
    const target = result.get(entry.cardId)!;
    try {
      const locator = materialLocator(entry.source.resource, cardRecordPath(entry.cardId), true);
      if (locator.kind !== "path" || locator.target !== entry.version.path)
        throw new Error("Source address disagrees with its pinned version");
      const read = byVersion.get(key(entry.version))!;
      if (read instanceof Error) throw read;
      const data = read.frontmatter ?? parseFrontmatter(read.raw).data;
      if (typeof data.id === "string" && isNodeId(data.id) && isRequirementNode(data))
        target.goalIds.add(data.id);
    } catch (error) {
      target.diagnostics.push(
        `Cannot derive Card progress from ${entry.source.resource}: ${String(error)}`,
      );
    }
  }
  return result;
}

function active(node: { archived: boolean; header: string }) {
  const status = documentLifecycle(parseFrontmatter(node.header).data).status;
  return !node.archived && (status === "draft" || status === "stable");
}

/** Activity is declared by the current output's own generated/verified timestamps. */
export async function readOutputActivity(fs: FsAdapter): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const catalog = await loadNodeCatalog(readOnlyFs(fs));
  for (const node of catalog.byId.values()) {
    if (!isOutputNode({ type: node.type }) || !active(node)) continue;
    const data = parseFrontmatter(node.header).data;
    const times: string[] = [];
    const generated = data.generated as { at?: unknown } | undefined;
    const at = okfTimestampSchema.safeParse(generated?.at);
    if (at.success) times.push(at.data);
    try {
      times.push(...nodeVerifications(data).map((entry) => entry.at));
    } catch {
      /* Invalid provenance supplies no verification evidence. */
    }
    times.sort((a, b) => Date.parse(b) - Date.parse(a));
    if (times[0]) result.set(node.nodeId, times[0]);
  }
  return result;
}

/** An active output counts only for Cards it explicitly names in sources. */
export async function readCardProgress(
  fs: FsAdapter,
  cards: readonly CardProgressInput[],
): Promise<Map<string, CardProgressItem>> {
  const result = new Map(cards.map((card) => [card.cardId, deriveCardProgress(card.state, 0)]));
  if (!cards.length) return result;
  const pinned = await readCardGoalIds(fs, cards);
  const catalog = await loadNodeCatalog(readOnlyFs(fs));
  const outputs = [...catalog.byId.values()].filter(
    (node) => isOutputNode({ type: node.type }) && active(node),
  );
  const responses = new Map(
    outputs.map((node) => {
      const sources = parseFrontmatter(node.header).data.sources;
      const targets = new Set<string>();
      if (Array.isArray(sources))
        for (const source of sources) {
          try {
            const locator = materialLocator(source.resource, nodeNotePath(node.path), true);
            if (locator.kind === "path" && !locator.suffix) targets.add(locator.target);
          } catch {
            /* Invalid source addresses are not response evidence. */
          }
        }
      return [node.nodeId, targets];
    }),
  );
  for (const card of cards) {
    const { goalIds, diagnostics } = pinned.get(card.cardId)!;
    const completed = new Set<string>(),
      outputIds = new Set<string>();
    for (const goalId of goalIds) {
      const goal = catalog.byId.get(goalId);
      if (!goal || !isRequirementNode({ type: goal.type }) || !active(goal)) continue;
      for (const output of outputs)
        if (
          output.path.startsWith(goal.path + "/") &&
          responses.get(output.nodeId)!.has(cardRecordPath(card.cardId))
        ) {
          completed.add(goalId);
          outputIds.add(output.nodeId);
        }
    }
    result.set(card.cardId, {
      ...deriveCardProgress(card.state, goalIds.size, completed.size, [...outputIds]),
      ...(diagnostics.length
        ? { progress: null, diagnostic: [...new Set(diagnostics)].join("; ") }
        : {}),
    });
  }
  return result;
}
