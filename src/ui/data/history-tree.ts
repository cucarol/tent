import type { HistoryTree } from "../../core/read/history-query.js";
import { buildGraph, type Graph } from "./store.js";
import type { DocumentVersion, SnapshotNode } from "./types.js";

export type HistoricalSelection = { node: SnapshotNode; version: DocumentVersion };

export async function readHistoricalNode(
  selection: HistoricalSelection,
  read: (
    nodeId: string,
    version: DocumentVersion,
  ) => Promise<{ nodeId: string; text: string; partial: boolean }>,
) {
  const document = await read(selection.node.id, selection.version);
  if (document.nodeId !== selection.node.id)
    throw new Error("Historical Node identity does not match");
  if (document.partial !== false) throw new Error("Historical Node text is incomplete");
  return { body: document.text };
}

/** A keyed selection never flashes a response for another commit, including while its effect cleans up. */
export function historyViewGraph(current: Graph, commit: string | null, tree: HistoryTree | null) {
  return commit === null
    ? current
    : historicalGraph(current, tree?.commit === commit ? tree : null);
}

/** One immutable request per commit for this mounted map; failures remain explicit. */
export class HistoryTrees {
  private requests = new Map<string, Promise<HistoryTree>>();
  private selection = 0;
  constructor(private read: (commit: string) => Promise<HistoryTree>) {}
  get(commit: string) {
    let request = this.requests.get(commit);
    if (!request) {
      request = this.read(commit);
      this.requests.set(commit, request);
    }
    return request;
  }
  select(commit: string | null, receive: (tree: HistoryTree | null, error?: unknown) => void) {
    const selection = ++this.selection;
    receive(null);
    if (commit)
      this.get(commit).then(
        (tree) => selection === this.selection && receive(tree),
        (error) => selection === this.selection && receive(null, error),
      );
    return () => {
      if (selection === this.selection) this.selection++;
    };
  }
}

/** No current status, relationships, bodies, robots, materials or canvas facts enter a past tree. */
export function historicalGraph(current: Graph, tree: HistoryTree | null): Graph {
  const rank = new Map<string, number>();
  const visit = (parent: string | null) => {
    for (const node of current.childrenOf(parent)) {
      rank.set(node.id, rank.size);
      visit(node.id);
    }
  };
  if (tree?.nodes.length) visit(null);
  const nodes: SnapshotNode[] = (tree?.nodes ?? []).map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    path: node.path,
    notePath: node.version.path,
    parentId: node.parentId,
    depth: 0,
    childIds: [],
    tags: [],
    status: "stable",
    archived: false,
    description: "",
    body: "",
    links: [],
    materials: [],
    incoming: [],
    history: [],
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, SnapshotNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
    let parent = node.parentId;
    while (parent) {
      node.depth++;
      parent = byId.get(parent)?.parentId ?? null;
    }
  }
  for (const [parent, list] of children) {
    list.sort((a, b) => {
      const ar = rank.get(a.id),
        br = rank.get(b.id);
      if (ar !== undefined || br !== undefined) return (ar ?? Infinity) - (br ?? Infinity);
      return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id);
    });
    if (parent) byId.get(parent)!.childIds = list.map((node) => node.id);
  }
  const graph = buildGraph({
    ...current.snapshot,
    nodes,
    roles: [],
    cards: [],
    commits: [],
    modules: undefined,
    paths: Object.fromEntries(
      nodes.map((node) => [node.notePath, { kind: "node" as const, id: node.id }]),
    ),
  });
  return { ...graph, childrenOf: (id) => children.get(id) ?? [] };
}
