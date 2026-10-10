import { readOnlyFs, type FsAdapter } from "./adapter.js";
import type { CardDocumentState } from "./card-document.js";
import { parseFrontmatter } from "./frontmatter.js";
import { documentVersionSchema, type DocumentVersion } from "./git-history.js";
import { materialLocator, isDirectoryMaterial, type MaterialSource } from "./material.js";
import { loadNodeCatalog, type NodeCatalog } from "./node-catalog.js";
import { isRequirementNode, isOutputNode } from "./node-sync-record.js";
import { inspectNodesSync, type NodeSyncInspection } from "./node-sync.js";
import { documentLifecycle } from "./document-status.js";
import { nodeVerifications, okfTimestampSchema } from "./node-provenance.js";
import { cardRecordPath, nodeNotePath } from "./paths.js";
import { parseRoleDocument } from "./role-document.js";
import { canonicalIdentityError } from "./tree.js";

export type CardProgress = "pending" | "received-no-output" | "needs-review" | "has-output";
export type CardProgressItem = {
  progress: CardProgress | null;
  goalCount: number;
  totalGoalCount: number;
  outputNodeIds: string[];
  reviewGoalCount?: number;
  reviewOutputNodeIds?: string[];
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
  reviewGoalCount = 0,
  reviewOutputNodeIds: readonly string[] = [],
): CardProgressItem {
  return {
    progress: !totalGoalCount
      ? null
      : state === "pending"
        ? "pending"
        : goalCount === totalGoalCount
          ? "has-output"
          : reviewGoalCount
            ? "needs-review"
            : "received-no-output",
    goalCount,
    totalGoalCount,
    outputNodeIds: [...new Set(outputNodeIds)].sort(),
    ...(reviewGoalCount
      ? { reviewGoalCount, reviewOutputNodeIds: [...new Set(reviewOutputNodeIds)].sort() }
      : {}),
  };
}

/** A pinned Node or Role must still pass its own identity rules; null when it does. */
export function cardSourceIdentityError(
  path: string,
  raw: string,
  data: Record<string, unknown>,
): string | null {
  if (path.startsWith("roles/")) {
    try {
      parseRoleDocument(path.slice(6, -3), raw);
      return null;
    } catch {
      return "Selected Role is invalid";
    }
  }
  return canonicalIdentityError(data) ?? null;
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
      if (
        locator.kind !== "path" ||
        isDirectoryMaterial(locator) ||
        locator.target !== entry.version.path
      )
        throw new Error("Source address disagrees with its pinned version");
      const read = byVersion.get(key(entry.version))!;
      if (read instanceof Error) throw read;
      const data = read.frontmatter ?? parseFrontmatter(read.raw).data;
      const identityError = cardSourceIdentityError(entry.version.path, read.raw, data);
      if (identityError) throw new Error(identityError);
      if (isRequirementNode(data)) target.goalIds.add(data.id as string);
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
  const outputs = [...catalog.byId.values()].filter((node) => isOutputNode(node) && active(node));
  if (!outputs.length) return result;
  const inspections = new Map(
    (
      await inspectNodesSync(
        readOnlyFs(fs),
        outputs.map((node) => node.nodeId),
      )
    ).map((node) => [node.nodeId, node]),
  );
  for (const node of outputs) {
    const inspection = inspections.get(node.nodeId);
    if (!inspection || inspection.behind || inspection.uncertain) continue;
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
    times.sort((a, b) => Date.parse(a) - Date.parse(b));
    if (times[0]) result.set(node.nodeId, new Date(times[0]).toISOString());
  }
  return result;
}

/** An active output counts only for Cards it explicitly names in sources. */
export async function readCardProgress(
  fs: FsAdapter,
  cards: readonly CardProgressInput[],
  currentInspections?: readonly NodeSyncInspection[] | Promise<readonly NodeSyncInspection[]>,
  currentCatalog?: NodeCatalog | Promise<NodeCatalog | undefined>,
): Promise<Map<string, CardProgressItem>> {
  const result = new Map(cards.map((card) => [card.cardId, deriveCardProgress(card.state, 0)]));
  if (!cards.length) return result;
  const pinned = await readCardGoalIds(fs, cards);
  if (![...pinned.values()].some((entry) => entry.goalIds.size)) {
    for (const card of cards) {
      const { diagnostics } = pinned.get(card.cardId)!;
      if (diagnostics.length)
        result.set(card.cardId, {
          ...result.get(card.cardId)!,
          diagnostic: [...new Set(diagnostics)].join("; "),
        });
    }
    return result;
  }
  const catalog = (await currentCatalog) ?? (await loadNodeCatalog(readOnlyFs(fs)));
  const dataOf = (node: { path: string }) => catalog.tree.byPath.get(node.path)!.fm;
  const isActive = (node: { path: string; archived: boolean }) => {
    const status = documentLifecycle(dataOf(node)).status;
    return !node.archived && (status === "draft" || status === "stable");
  };
  const outputs = [...catalog.byId.values()].filter((node) => isOutputNode(node) && isActive(node));
  const responses = new Map(
    outputs.map((node) => {
      const sources = dataOf(node).sources;
      const targets = new Set<string>();
      if (Array.isArray(sources))
        for (const source of sources) {
          try {
            const locator = materialLocator(source.resource, nodeNotePath(node.path), true);
            if (locator.kind === "path" && !isDirectoryMaterial(locator) && !locator.suffix)
              targets.add(locator.target);
          } catch {
            /* Invalid source addresses are not response evidence. */
          }
        }
      return [node.nodeId, targets];
    }),
  );
  const relatedOutputs = outputs.filter((output) =>
    cards.some((card) => {
      if (!responses.get(output.nodeId)!.has(cardRecordPath(card.cardId))) return false;
      return [...pinned.get(card.cardId)!.goalIds].some((goalId) => {
        const goal = catalog.byId.get(goalId);
        return (
          goal &&
          isActive(goal) &&
          isRequirementNode({ type: goal.type }) &&
          output.path.startsWith(goal.path + "/")
        );
      });
    }),
  );
  const inspections = new Map(
    (
      (await currentInspections) ??
      (relatedOutputs.length
        ? await inspectNodesSync(
            readOnlyFs(fs),
            relatedOutputs.map((node) => node.nodeId),
          )
        : [])
    ).map((node) => [node.nodeId, node]),
  );
  for (const card of cards) {
    const { goalIds, diagnostics } = pinned.get(card.cardId)!;
    const currentGoalIds = [...goalIds].filter((goalId) => {
      const goal = catalog.byId.get(goalId);
      return !goal || documentLifecycle(dataOf(goal)).status !== "deprecated";
    });
    const completed = new Set<string>(),
      outputIds = new Set<string>(),
      reviewGoals = new Set<string>(),
      reviewOutputIds = new Set<string>();
    for (const goalId of currentGoalIds) {
      const goal = catalog.byId.get(goalId);
      if (!goal || !isRequirementNode({ type: goal.type }) || !isActive(goal)) continue;
      const awaitingReview = new Set<string>();
      for (const output of relatedOutputs)
        if (
          output.path.startsWith(goal.path + "/") &&
          responses.get(output.nodeId)!.has(cardRecordPath(card.cardId))
        ) {
          const inspection = inspections.get(output.nodeId);
          if (!inspection || inspection.behind || inspection.uncertain)
            awaitingReview.add(output.nodeId);
          else {
            completed.add(goalId);
            outputIds.add(output.nodeId);
          }
        }
      if (!completed.has(goalId) && awaitingReview.size) {
        reviewGoals.add(goalId);
        for (const outputId of awaitingReview) reviewOutputIds.add(outputId);
      }
    }
    result.set(card.cardId, {
      ...deriveCardProgress(
        card.state,
        currentGoalIds.length,
        completed.size,
        [...outputIds],
        reviewGoals.size,
        [...reviewOutputIds],
      ),
      ...(diagnostics.length
        ? { progress: null, diagnostic: [...new Set(diagnostics)].join("; ") }
        : {}),
    });
  }
  return result;
}
