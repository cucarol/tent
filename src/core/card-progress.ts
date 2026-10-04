import { readOnlyFs, type FsAdapter } from "./adapter.js";
import type { CardDocumentState } from "./card-document.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isCardId, isNodeId } from "./id.js";
import {
  documentVersionSchema,
  type DocumentVersion,
  type HistoryCommit,
  type GitDocumentHistory,
} from "./git-history.js";
import type { MaterialSource } from "./material.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { isRequirementNode, isOutputNode } from "./node-sync-record.js";
import { documentLifecycle } from "./document-status.js";
import { nodeVerifications } from "./node-provenance.js";

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

type ProgressHistory = {
  publications: Record<string, number>;
  sourceGoals: Record<string, string>;
  pinErrors: Record<string, string>;
  attachments: Record<string, Record<string, number>>;
};
const versionKey = (version: DocumentVersion) => `${version.commit}:${version.path}`;
const nodePath = (version: DocumentVersion) => version.path.slice(0, version.path.lastIndexOf("/"));

/** Persist only retained history facts. Live Node state and hierarchy are checked on every read. */
async function buildProgressHistory(
  history: GitDocumentHistory,
  retainedEvents: readonly HistoryCommit[] | undefined,
  head: string | null | undefined,
): Promise<ProgressHistory> {
  const events =
    retainedEvents && retainedEvents.at(-1)?.commit === head
      ? retainedEvents!
      : await history.changesInRange();
  const versions = new Map<string, DocumentVersion>();
  for (const event of events)
    for (const change of event.changes)
      if (
        change.after &&
        change.objectId &&
        (isNodeId(change.objectId) || isCardId(change.objectId))
      )
        versions.set(versionKey(change.after), change.after);
  const dataByVersion = new Map<string, Record<string, unknown>>();
  const pinErrors: Record<string, string> = {};
  async function readVersions(selected: readonly DocumentVersion[], toleratePinErrors = false) {
    for (const [index, read] of (await history.readVersions(selected)).entries()) {
      if (read instanceof Error) {
        if (!toleratePinErrors) throw read;
        pinErrors[versionKey(selected[index]!)] = read.message;
        continue;
      }
      dataByVersion.set(
        versionKey(selected[index]!),
        read.frontmatter ?? parseFrontmatter(read.raw).data,
      );
    }
  }
  await readVersions([...versions.values()]);
  // A Card may pin a Node at a commit that did not change that Node's own bytes.
  const pinned = new Map<string, DocumentVersion>();
  for (const data of dataByVersion.values())
    if (data.type === "card" && Array.isArray(data.sources))
      for (const source of data.sources) {
        const version = documentVersionSchema.safeParse(source.version);
        if (version.success && !dataByVersion.has(versionKey(version.data)))
          pinned.set(versionKey(version.data), version.data);
      }
  await readVersions([...pinned.values()], true);
  const sourceGoals: Record<string, string> = {};
  for (const [key, data] of dataByVersion)
    if (typeof data.id === "string" && isNodeId(data.id) && isRequirementNode(data))
      sourceGoals[key] = data.id;
  const publications: Record<string, number> = {};
  const historical = new Map<string, { path: string; data: Record<string, unknown> }>();
  const byPath = new Map<string, string>();
  const outputs = new Set<string>();
  const attachments: Record<string, Record<string, number>> = {};
  const ancestors = (outputId: string) => {
    const goals = new Set<string>();
    let path = historical.get(outputId)!.path;
    while (path.includes("/")) {
      path = path.slice(0, path.lastIndexOf("/"));
      const id = byPath.get(path),
        node = id && historical.get(id);
      if (node && isRequirementNode(node.data)) goals.add(id!);
    }
    return goals;
  };
  const verificationKeys = (data: Record<string, unknown>) =>
    new Set(nodeVerifications(data).map((entry) => `${entry.by}:${entry.at}`));
  for (const [index, event] of events.entries()) {
    const previousAncestors = new Map([...outputs].map((id) => [id, ancestors(id)]));
    const confirmed = new Set<string>();
    for (const change of event.changes) {
      const id = change.objectId;
      if (!id) continue;
      if (isCardId(id) && publications[id] === undefined) publications[id] = index;
      if (!isNodeId(id)) continue;
      const previous = historical.get(id);
      if (previous && byPath.get(previous.path) === id) byPath.delete(previous.path);
      if (!change.after) {
        historical.delete(id);
        outputs.delete(id);
        delete attachments[id];
      } else {
        const data = dataByVersion.get(versionKey(change.after))!;
        historical.set(id, { path: nodePath(change.after), data });
        byPath.set(nodePath(change.after), id);
        if (isOutputNode(data)) {
          outputs.add(id);
          const before = verificationKeys(previous?.data ?? {});
          if ([...verificationKeys(data)].some((value) => !before.has(value))) confirmed.add(id);
        } else {
          outputs.delete(id);
          delete attachments[id];
        }
      }
    }
    for (const id of outputs) {
      const goals = ancestors(id),
        evidence = attachments[id] ?? {};
      for (const goalId of Object.keys(evidence)) if (!goals.has(goalId)) delete evidence[goalId];
      for (const goalId of goals)
        if (
          !previousAncestors.get(id)?.has(goalId) ||
          confirmed.has(id) ||
          (event.operation === "node.sync-confirm" && event.objectIds.includes(id))
        )
          evidence[goalId] = index;
      attachments[id] = evidence;
    }
  }
  return { publications, sourceGoals, pinErrors, attachments };
}

/** Each referenced goal observes every active output in its subtree, including nested goals. */
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
  const history = await fs.history.derived("card-subtree-progress", 2, (head) =>
    buildProgressHistory(fs.history!, retainedEvents, head),
  );
  const catalog = await loadNodeCatalog(readOnlyFs(fs));
  const active = (node: { archived: boolean; header: string }) => {
    const status = documentLifecycle(parseFrontmatter(node.header).data).status;
    return !node.archived && (status === "draft" || status === "stable");
  };
  const outputs = [...catalog.byId.values()].filter(
    (node) => isOutputNode({ type: node.type }) && active(node),
  );
  for (const card of cards) {
    const goalIds = new Set<string>();
    const diagnostics: string[] = [];
    for (const source of card.sources) {
      const version = documentVersionSchema.safeParse(source.version);
      if (!version.success) continue;
      const pinError = history.pinErrors[versionKey(version.data)];
      if (pinError)
        diagnostics.push(`Cannot derive Card progress from ${source.resource}: ${pinError}`);
      const id = history.sourceGoals[versionKey(version.data)];
      if (id) goalIds.add(id);
    }
    const publication = history.publications[card.cardId];
    const completed = new Set<string>(),
      outputIds = new Set<string>();
    if (publication !== undefined)
      for (const goalId of goalIds) {
        const goal = catalog.byId.get(goalId);
        if (!goal || !isRequirementNode({ type: goal.type }) || !active(goal)) continue;
        for (const output of outputs)
          if (
            output.path.startsWith(goal.path + "/") &&
            (history.attachments[output.nodeId]?.[goalId] ?? -1) > publication
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
