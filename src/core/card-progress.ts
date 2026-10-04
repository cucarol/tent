import { readOnlyFs, type FsAdapter } from "./adapter.js";
import type { CardDocumentState } from "./card-document.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isNodeId } from "./id.js";
import { documentVersionSchema, type DocumentVersion, type HistoryCommit } from "./git-history.js";
import type { MaterialSource } from "./material.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { nearestGoal, isRequirementNode, isOutputNode } from "./node-sync-record.js";
import { documentLifecycle } from "./document-status.js";
import { nodeVerifications } from "./node-provenance.js";

export type CardProgress = "pending" | "received-no-output" | "has-output";
export type CardProgressItem = {
  progress: CardProgress | null;
  goalCount: number;
  totalGoalCount: number;
  outputNodeIds: string[];
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
    outputNodeIds: [...outputNodeIds].sort(),
  };
}

/** Live goal/output ownership plus retained publication/link/confirmation evidence; never writes. */
export async function readCardProgress(
  fs: FsAdapter,
  cards: readonly CardProgressInput[],
  retainedEvents?: readonly HistoryCommit[],
): Promise<Map<string, CardProgressItem>> {
  const result = new Map(cards.map((card) => [card.cardId, deriveCardProgress(card.state, 0)]));
  if (
    !cards.length ||
    !cards.some((card) => card.sources.some((source) => source.version)) ||
    !fs.history ||
    !(await fs.exists(".git"))
  )
    return result;
  const history = fs.history;
  const catalog = await loadNodeCatalog(readOnlyFs(fs));
  const events = retainedEvents ?? (await history.changesInRange());
  const versions = new Map<string, DocumentVersion>();
  const key = (version: DocumentVersion) => `${version.commit}:${version.path}`;
  for (const card of cards)
    for (const source of card.sources) {
      const parsed = documentVersionSchema.safeParse(source.version);
      if (parsed.success) versions.set(key(parsed.data), parsed.data);
    }
  // Only current outputs and Nodes that occupied their historical ancestor paths matter.
  const currentOutputs = new Set(
    [...catalog.byId.values()]
      .filter((node) => !node.archived && isOutputNode({ type: node.type }))
      .map((node) => node.nodeId),
  );
  const ancestors = new Set<string>();
  for (const event of events)
    for (const change of event.changes)
      if (change.objectId && currentOutputs.has(change.objectId) && change.after) {
        let path = change.after.path.slice(0, change.after.path.lastIndexOf("/"));
        while (path.includes("/")) {
          path = path.slice(0, path.lastIndexOf("/"));
          ancestors.add(path);
        }
      }
  const relevantNodes = new Set(currentOutputs);
  for (const event of events)
    for (const change of event.changes)
      if (
        change.objectId &&
        isNodeId(change.objectId) &&
        change.after &&
        ancestors.has(change.after.path.slice(0, change.after.path.lastIndexOf("/")))
      )
        relevantNodes.add(change.objectId);
  for (const event of events)
    for (const change of event.changes)
      if (change.objectId && relevantNodes.has(change.objectId) && change.after)
        versions.set(key(change.after), change.after);
  const selected = [...versions.values()];
  const rawByVersion = new Map<string, Record<string, unknown>>();
  for (const [index, read] of (await history.readVersions(selected)).entries()) {
    if (read instanceof Error) throw read;
    rawByVersion.set(key(selected[index]!), parseFrontmatter(read.raw).data);
  }
  const publications = new Map<string, number>();
  const historical = new Map<string, { path: string; data: Record<string, unknown> }>();
  const byPath = new Map<string, string>();
  const outputIds = new Set<string>();
  const linked = new Map<string, { goalId: string; index: number }>();
  const owner = (outputId: string) => {
    const output = historical.get(outputId);
    if (!output || typeof output.data.resource !== "string") return;
    let path = output.path;
    while (path.includes("/")) {
      path = path.slice(0, path.lastIndexOf("/"));
      const id = byPath.get(path),
        node = id && historical.get(id);
      if (node && isRequirementNode(node.data) && node.data.status !== "deprecated") return id;
    }
  };
  const verificationKeys = (data: Record<string, unknown>) =>
    new Set(nodeVerifications(data).map((verified) => `${verified.by}:${verified.at}`));
  for (const [index, event] of events.entries()) {
    const previousOwners = new Map([...outputIds].map((id) => [id, owner(id)]));
    const confirmed = new Set<string>();
    for (const change of event.changes) {
      const id = change.objectId;
      if (!id) continue;
      if (!publications.has(id)) publications.set(id, index);
      if (!relevantNodes.has(id)) continue;
      const previous = historical.get(id);
      if (previous && byPath.get(previous.path) === id) byPath.delete(previous.path);
      if (!change.after) {
        historical.delete(id);
        outputIds.delete(id);
      } else {
        const data = rawByVersion.get(key(change.after))!;
        const path = change.after.path.slice(0, change.after.path.lastIndexOf("/"));
        historical.set(id, { path, data });
        byPath.set(path, id);
        if (isOutputNode(data)) {
          outputIds.add(id);
          const before = verificationKeys(previous?.data ?? {});
          if ([...verificationKeys(data)].some((value) => !before.has(value))) confirmed.add(id);
        } else outputIds.delete(id);
      }
    }
    // Newly attached outputs count; saves without new verification never confirm.
    for (const id of outputIds) {
      const goalId = owner(id);
      if (
        goalId &&
        (goalId !== previousOwners.get(id) ||
          confirmed.has(id) ||
          (event.operation === "node.sync-confirm" && event.objectIds.includes(id)))
      )
        linked.set(id, { goalId, index });
    }
  }
  for (const card of cards) {
    const goalIds = new Set<string>();
    for (const source of card.sources) {
      const parsed = documentVersionSchema.safeParse(source.version);
      if (!parsed.success) continue;
      const data = rawByVersion.get(key(parsed.data));
      if (data && typeof data.id === "string" && isNodeId(data.id) && isRequirementNode(data))
        goalIds.add(data.id);
    }
    const publication = publications.get(card.cardId);
    const completed = new Set<string>(),
      outputs: string[] = [];
    if (publication !== undefined)
      for (const node of catalog.byId.values()) {
        if (node.archived || !isOutputNode({ type: node.type })) continue;
        const data = parseFrontmatter(node.header).data;
        const status = documentLifecycle(data).status;
        if ((status !== "stable" && status !== "draft") || typeof data.resource !== "string")
          continue;
        const goalId = nearestGoal(node, catalog.byId)?.nodeId;
        const evidence = linked.get(node.nodeId);
        if (
          goalId &&
          goalIds.has(goalId) &&
          evidence?.goalId === goalId &&
          evidence.index > publication
        ) {
          completed.add(goalId);
          outputs.push(node.nodeId);
        }
      }
    result.set(card.cardId, deriveCardProgress(card.state, goalIds.size, completed.size, outputs));
  }
  return result;
}
