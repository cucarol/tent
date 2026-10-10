import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type { Snapshot, SnapshotCard, SnapshotNode } from "../src/ui/data/types.js";
import { deleteImpact } from "../src/ui/panel/Manage.js";

const node = (id: string, extra: Partial<SnapshotNode> = {}): SnapshotNode => ({
  id,
  name: id,
  path: id,
  notePath: `${id}/${id}.md`,
  depth: 0,
  type: "goal",
  tags: [],
  status: "stable",
  archived: false,
  description: "",
  body: "",
  parentId: null,
  childIds: [],
  links: [],
  materials: [],
  incoming: [],
  history: [],
  ...extra,
});
const card = (id: string, source: string): SnapshotCard => ({
  id,
  title: id,
  state: "pending",
  progress: "pending",
  goalCount: 0,
  totalGoalCount: 0,
  outputNodeIds: [],
  target: null,
  receivedBy: null,
  status: "stable",
  body: "",
  sources: [
    {
      kind: "node",
      id: source,
      resource: `../${source}/${source}.md`,
      version: null,
      changedSince: false,
    },
  ],
  path: `cards/${id}.md`,
  history: [],
  publishedAt: null,
  updatedAt: null,
});

test("deleting a Node counts outside links into every Node under it, not only into itself", () => {
  const snapshot: Snapshot = {
    workspace: { id: "manage-test", name: "Manage", revision: "r", generatedAt: "" },
    nodes: [
      // Nothing links to Parent itself; only its Child is referenced from outside.
      node("parent", { path: "parent", childIds: ["child"] }),
      node("child", {
        path: "parent/child",
        parentId: "parent",
        depth: 1,
        childIds: ["grandchild"],
        incoming: [
          { from: { kind: "node", id: "external" }, via: "link" },
          { from: { kind: "card", id: "card-carry" }, via: "card-source" },
          // A link from inside the subtree goes with it and breaks nothing.
          { from: { kind: "node", id: "grandchild" }, via: "link" },
        ],
      }),
      node("grandchild", {
        path: "parent/child/grandchild",
        parentId: "child",
        depth: 2,
        incoming: [{ from: { kind: "node", id: "other" }, via: "mention" }],
      }),
      node("external", {
        links: [
          { label: "Child", href: "../parent/child/child.md", ref: { kind: "node", id: "child" } },
        ],
      }),
      node("other"),
    ],
    roles: [],
    cards: [card("card-carry", "child"), card("local-card-draft", "child")],
    commits: [],
    paths: {},
  };
  const graph = buildGraph(snapshot);
  const impact = deleteImpact(graph, graph.nodes.get("parent")!);
  assert.deepEqual(
    impact.kids.map((k) => k.id),
    ["child", "grandchild"],
  );
  // external → child and other → grandchild; the inside link and the Card source are not links here.
  assert.equal(impact.links, 2);
  // The published Card that carries Child; an unsent draft is not a Card yet.
  assert.equal(impact.cards, 1);
  // Deleting only the leaf still sees its own outside link.
  assert.equal(deleteImpact(graph, graph.nodes.get("grandchild")!).links, 1);
});
