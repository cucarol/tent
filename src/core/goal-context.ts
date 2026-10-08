import { readOnlyFs, type FsAdapter } from "./adapter.js";
import { loadNodeCatalog, type CatalogNode } from "./node-catalog.js";
import { parseFrontmatter } from "./frontmatter.js";
import { nodeTypeOf } from "./node-type.js";
import { documentLifecycle } from "./document-status.js";
import { listCardDocuments } from "./card-document.js";
import { listWorkspaceRelations, type WorkspaceRelation } from "./workspace-relations.js";
import { navigationIds } from "./context-reader.js";

export type GoalContextItem = {
  kind:
    "ancestor" | "child" | "incoming" | "outgoing" | "goal" | "prompt" | "output" | "card" | "self";
  id: string;
  name: string;
  description: string;
  type?: string;
  relationKinds?: WorkspaceRelation["via"][];
  state?: string;
  sync?: true;
  progress?: string | null;
  receiver?: string;
};

/** Complete live associations for every Node type; CLI alone bounds the navigation hint. */
export async function readGoalContext(fs: FsAdapter, nodeId: string): Promise<GoalContextItem[]> {
  fs = readOnlyFs(fs);
  const catalog = await loadNodeCatalog(fs);
  const selected = catalog.byId.get(nodeId);
  if (!selected) return [];
  const active = (node: CatalogNode) => {
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
      type: node.type,
      ...(nodeTypeOf(node.type) === "output"
        ? {
            state: documentLifecycle(data).status ?? "invalid",
            ...(kind === "self" ||
            kind === "output" ||
            (kind === "child" && nodeTypeOf(selected.type) === "goal")
              ? { sync: true as const }
              : {}),
          }
        : {}),
    };
  };
  const scopes = [selected];
  let parent = selected.parentNodeId;
  while (parent) {
    const node = catalog.byId.get(parent);
    if (!node) break;
    scopes.push(node);
    parent = node.parentNodeId;
  }
  const ancestors = scopes.slice(1).map((node) => item(node, "ancestor"));
  const visible = navigationIds(catalog.byId.values());
  const children = selected.childNodeIds
    .flatMap((id) => {
      const node = catalog.byId.get(id);
      return node && visible.has(id) ? [item(node, "child")] : [];
    })
    .sort((a, b) => (a.type ?? "").localeCompare(b.type ?? "") || a.id.localeCompare(b.id));
  const result: GoalContextItem[] = [...ancestors, ...children];
  if (nodeTypeOf(selected.type) === "output") {
    result.unshift(item(selected, "self"));
    result.push(
      ...scopes
        .slice(1)
        .filter((node) => nodeTypeOf(node.type) === "goal")
        .map((node) => item(node, "goal")),
    );
  }
  if (nodeTypeOf(selected.type) === "goal") {
    const covered = new Set(
      scopes.map((node) => node.nodeId).concat(children.map((node) => node.id)),
    );
    result.push(
      ...scopes.flatMap((scope) =>
        scope.childNodeIds.flatMap((id) => {
          const node = catalog.byId.get(id);
          return node && active(node) && !covered.has(id) && nodeTypeOf(node.type) === "prompt"
            ? [item(node, "prompt")]
            : [];
        }),
      ),
    );
    result.push(
      ...[...catalog.byId.values()]
        .filter(
          (node) =>
            active(node) &&
            !covered.has(node.nodeId) &&
            nodeTypeOf(node.type) === "output" &&
            node.path.startsWith(selected.path + "/"),
        )
        .map((node) => item(node, "output")),
    );
  }
  const relations = await listWorkspaceRelations(fs);
  const pinnedCardIds = [
    ...new Set(
      relations
        .filter(
          (relation) =>
            relation.from.kind === "card" &&
            relation.target.kind === "node" &&
            relation.target.id === nodeId &&
            relation.via === "sources" &&
            relation.version,
        )
        .map((relation) => relation.from.id),
    ),
  ];
  const cards = (
    await listCardDocuments(fs, { includeDeprecated: true, cardIds: pinnedCardIds })
  ).items.filter((card) => !card.diagnostic);
  const cardById = new Map(cards.map((card) => [String(card.cardId), card]));
  const associations = new Map<string, GoalContextItem>();
  for (const relation of relations) {
    const incoming = relation.target.kind === "node" && relation.target.id === nodeId;
    const outgoing = relation.from.kind === "node" && relation.from.id === nodeId;
    if (!incoming && !outgoing) continue;
    const ref = incoming ? relation.from : relation.target;
    if (ref.kind !== "node" && ref.kind !== "role" && ref.kind !== "card") continue;
    const node = ref.kind === "node" ? catalog.byId.get(ref.id) : undefined;
    if (incoming && node?.archived) continue;
    const pinned =
      incoming && ref.kind === "card" && relation.via === "sources" && relation.version;
    const kind = pinned ? "card" : incoming ? "incoming" : "outgoing";
    const key = `${kind}:${ref.id}`;
    const existing = associations.get(key);
    if (existing) {
      if (!existing.relationKinds!.includes(relation.via))
        existing.relationKinds!.push(relation.via);
      continue;
    }
    const card = ref.kind === "card" ? cardById.get(ref.id) : undefined;
    const metadata =
      ref.kind === "role"
        ? parseFrontmatter(await fs.readFile(`roles/${ref.id}.md`)).data
        : undefined;
    associations.set(key, {
      ...(node
        ? item(node, kind)
        : {
            kind,
            id: ref.id,
            name: String(card?.title ?? metadata?.title ?? ref.id),
            description: typeof metadata?.description === "string" ? metadata.description : "",
            type: ref.kind,
          }),
      relationKinds: [relation.via],
      ...(card
        ? {
            state: String(card.state),
            progress: card.progress == null ? null : String(card.progress),
            description: `${card.goalCount}/${card.totalGoalCount}`,
            receiver: String(card.receivedBy ?? card.target ?? "open"),
          }
        : {}),
    });
  }
  return [...result, ...associations.values()];
}
