import { readOnlyFs, type FsAdapter } from "./adapter.js";
import { loadNodeCatalog, type CatalogNode } from "./node-catalog.js";
import { parseFrontmatter } from "./frontmatter.js";
import { nodeTypePrimary } from "./node-type.js";
import { documentLifecycle } from "./document-status.js";
import { listCardDocuments } from "./card-document.js";
import { readCardGoalIds, type CardProgressInput } from "./card-progress.js";
import { type MaterialSource } from "./material.js";

export type GoalContextItem = {
  kind: "ancestor" | "prompt" | "output" | "card";
  id: string;
  name: string;
  description: string;
  state?: string;
  receiver?: string;
};

/** Live structural context, without capturing neighbouring documents or replaying history. */
export async function readGoalContext(fs: FsAdapter, nodeId: string): Promise<GoalContextItem[]> {
  fs = readOnlyFs(fs);
  const catalog = await loadNodeCatalog(fs);
  const goal = catalog.byId.get(nodeId);
  if (!goal || nodeTypePrimary(goal.type) !== "goal") return [];
  const visible = (node: CatalogNode) => {
    const status = documentLifecycle(parseFrontmatter(node.header).data).status;
    return !node.archived && (status === "draft" || status === "stable");
  };
  const item = (node: CatalogNode, kind: GoalContextItem["kind"]): GoalContextItem => {
    const data = parseFrontmatter(node.header).data;
    return {
      kind,
      id: node.nodeId,
      name: node.name,
      description: typeof data.description === "string" ? data.description : "",
      ...(kind === "output" ? { state: documentLifecycle(data).status ?? "invalid" } : {}),
    };
  };
  const scopes = [goal];
  let parent = goal.parentNodeId;
  while (parent) {
    const node = catalog.byId.get(parent);
    if (!node) break;
    scopes.push(node);
    parent = node.parentNodeId;
  }
  const ancestors = scopes.slice(1).map((node) => item(node, "ancestor"));
  const ancestorIds = new Set(scopes.map((node) => node.nodeId));
  const prompts = scopes.flatMap((scope) =>
    scope.childNodeIds.flatMap((id) => {
      const node = catalog.byId.get(id);
      return node &&
        visible(node) &&
        !ancestorIds.has(id) &&
        nodeTypePrimary(node.type) === "prompt"
        ? [item(node, "prompt")]
        : [];
    }),
  );
  const outputs = [...catalog.byId.values()]
    .filter(
      (node) =>
        visible(node) &&
        nodeTypePrimary(node.type) === "output" &&
        node.path.startsWith(goal.path + "/"),
    )
    .map((node) => item(node, "output"));
  const cards = (await listCardDocuments(fs)).items.filter((card) => !card.diagnostic);
  const inputs: CardProgressInput[] = [];
  for (const card of cards) {
    const path = String(card.path);
    const raw = fs.readFrontmatter ? await fs.readFrontmatter(path) : await fs.readFile(path);
    const data = parseFrontmatter(raw).data;
    inputs.push({
      cardId: String(card.cardId),
      state: card.state as CardProgressInput["state"],
      sources: Array.isArray(data.sources) ? (data.sources as MaterialSource[]) : [],
    });
  }
  const goals = await readCardGoalIds(fs, inputs);
  const related: GoalContextItem[] = cards
    .filter((card) => goals.get(String(card.cardId))?.goalIds.has(nodeId))
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .map((card) => ({
      kind: "card",
      id: String(card.cardId),
      name: String(card.title ?? card.cardId),
      description: `${card.goalCount}/${card.totalGoalCount}`,
      state: String(card.progress ?? card.state),
      receiver: String(card.receivedBy ?? card.target ?? "open"),
    }));
  return [...ancestors, ...prompts, ...outputs, ...related];
}
