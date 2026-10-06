import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type {
  Snapshot,
  SnapshotIncoming,
  SnapshotLink,
  SnapshotCard,
  SnapshotNode,
  SnapshotRole,
} from "../src/ui/data/types.js";
import { lensLayout, treeLayout, type Layout, type Rect } from "../src/ui/map/layout.js";
import { nearest, refPath } from "../src/ui/map/geometry.js";
import { routeLinks, type Pt } from "../src/ui/map/route.js";
import { ago, relativeHref, resolveHref, workspaceImagePath } from "../src/ui/util.js";
import { setLang } from "../src/ui/i18n.js";
import { cardProgressLabel } from "../src/ui/data/card-progress.js";
import { petTraits } from "../src/ui/components/Pet.js";

setLang("zh", false);

const linkTo = (id: string): SnapshotLink => ({
  label: id,
  href: `${id}.md`,
  ref: { kind: "node", id },
});
const citedBy = (id: string, kind: "node" | "card" = "node"): SnapshotIncoming => ({
  from: { kind, id },
  via: kind === "card" ? "card-source" : "link",
});

function node(
  id: string,
  parentId: string | null,
  type = "prompt",
  extra: Partial<SnapshotNode> = {},
): SnapshotNode {
  return {
    id,
    name: id,
    path: id,
    notePath: `${id}/${id}.md`,
    depth: 0,
    type,
    tags: [],
    status: "stable",
    archived: false,
    description: "",
    body: "",
    parentId,
    childIds: [],
    links: [],
    materials: [],
    incoming: [],
    history: [],
    ...extra,
  };
}

function role(id: string, extra: Partial<SnapshotRole> = {}): SnapshotRole {
  return {
    id,
    title: id,
    status: "active",
    path: `roles/${id}.md`,
    body: "",
    links: [],
    incoming: [],
    history: [],
    ...extra,
  };
}

function graphOf(nodes: SnapshotNode[], roles: SnapshotRole[] = [], cards: SnapshotCard[] = []) {
  for (const n of nodes) n.childIds = nodes.filter((c) => c.parentId === n.id).map((c) => c.id);
  const snapshot: Snapshot = {
    workspace: { id: "ws-test", name: "test", revision: "r0", generatedAt: "" },
    nodes,
    roles,
    cards,
    commits: [],
    paths: Object.fromEntries([
      ...nodes.map((n) => [n.notePath, { kind: "node" as const, id: n.id }]),
      ...roles.map((r) => [r.path, { kind: "role" as const, id: r.id }]),
    ]),
  };
  return buildGraph(snapshot);
}

const at = (layout: Layout, id: string) => {
  const p = layout.placed.get(id);
  assert.ok(p, `${id} is placed`);
  return p;
};

test("siblings read goal, then prompt, then output, otherwise keeping their order", () => {
  const graph = graphOf([
    node("a", null, "output-analysis"),
    node("b", null),
    node("c", null, "goal"),
    node("d", null, "prompt-spec"),
  ]);
  assert.deepEqual(
    graph.childrenOf(null).map((n) => n.id),
    ["c", "b", "d", "a"],
  );
});

test("a Role belongs to the Nodes it links to and the Nodes that link to it", () => {
  const graph = graphOf(
    [node("x", null), node("y", null), node("z", null)],
    [role("r1", { links: [linkTo("x")] }), role("r2", { incoming: [citedBy("y")] })],
  );
  assert.deepEqual(
    graph.rolesOf("x").map((r) => r.id),
    ["r1"],
  );
  assert.deepEqual(
    graph.rolesOf("y").map((r) => r.id),
    ["r2"],
  );
  assert.deepEqual(graph.rolesOf("z"), []);
});

/** A sent Card carrying Nodes. [id, changed since] per source. */
function card(
  id: string,
  lane: { target?: string; receivedBy?: string },
  state: SnapshotCard["state"],
  sources: [string, boolean][],
  history = ["c0"],
): SnapshotCard {
  return {
    id,
    title: id,
    state,
    progress: null,
    goalCount: 0,
    totalGoalCount: 0,
    outputNodeIds: [],
    target: lane.target ?? null,
    receivedBy: lane.receivedBy ?? null,
    status: "stable",
    body: "",
    sources: sources.map(([node, changedSince]) => ({
      kind: "node",
      resource: `/${node}/${node}.md`,
      id: node,
      version: null,
      changedSince,
    })),
    path: `cards/${id}.md`,
    history,
    publishedAt: null,
    updatedAt: null,
  };
}

test("a Node's faces are the lanes its published Cards went to, Roles first, with what still waits", () => {
  const graph = graphOf(
    [node("a", null), node("b", null)],
    [role("role-x"), role("role-y")],
    [
      card("c1", { receivedBy: "role-y" }, "consumed", [["a", false]]),
      card("c2", { target: "role-y", receivedBy: "role-y" }, "consumed", [
        ["a", false],
        ["b", false],
      ]),
      card("c3", { target: "role-x" }, "pending", [["a", true]]),
      card("c4", {}, "pending", [["a", false]]),
      // A draft has handed nothing to anyone yet.
      card("local-card-d1", { target: "role-x" }, "pending", [["b", false]], []),
    ],
  );
  assert.deepEqual(graph.handedTo("a"), [
    {
      lane: "role-x",
      cards: 0,
      waiting: 1,
      outputs: 0,
      reviews: 0,
      goalCount: 0,
      totalGoalCount: 0,
      old: true,
    },
    {
      lane: "role-y",
      cards: 2,
      waiting: 0,
      outputs: 0,
      reviews: 0,
      goalCount: 0,
      totalGoalCount: 0,
      old: false,
    },
    {
      lane: "",
      cards: 0,
      waiting: 1,
      outputs: 0,
      reviews: 0,
      goalCount: 0,
      totalGoalCount: 0,
      old: false,
    },
  ]);
  assert.deepEqual(graph.handedTo("b"), [
    {
      lane: "role-y",
      cards: 1,
      waiting: 0,
      outputs: 0,
      reviews: 0,
      goalCount: 0,
      totalGoalCount: 0,
      old: false,
    },
  ]);
});

test("Card output progress is reflected on each carried Node without counting repeated sources twice", () => {
  const sent = card("sent", { receivedBy: "role-x" }, "consumed", [
    ["a", false],
    ["a", false],
  ]);
  sent.progress = "has-output";
  sent.goalCount = 1;
  sent.totalGoalCount = 1;
  sent.outputNodeIds = ["result"];
  const graph = graphOf([node("a", null), node("result", null)], [role("role-x")], [sent]);
  assert.deepEqual(graph.handedTo("a"), [
    {
      lane: "role-x",
      cards: 1,
      waiting: 0,
      outputs: 1,
      reviews: 0,
      goalCount: 1,
      totalGoalCount: 1,
      old: false,
    },
  ]);
});

test("goal-free Cards show only reception while partial multi-goal Cards show a completion ratio", () => {
  setLang("en", false);
  const sent = card("sent", {}, "consumed", []);
  assert.equal(cardProgressLabel(sent), "Received");
  assert.equal(cardProgressLabel({ ...sent, state: "pending" }), "Pending");
  const partial = {
    ...sent,
    progress: "received-no-output" as const,
    goalCount: 1,
    totalGoalCount: 2,
  };
  assert.equal(cardProgressLabel(partial), "Some outputs still missing · 1/2");
  assert.equal(cardProgressLabel({ ...partial, goalCount: 0 }), "Received, no output yet · 0/2");
  assert.equal(
    cardProgressLabel({ ...partial, goalCount: 2, progress: "has-output" }),
    "Has output · 2/2",
  );
  setLang("zh", false);
});

test("map badges keep partial goal counts without treating a Card as completed", () => {
  const partial = card("partial", { receivedBy: "role-x" }, "consumed", [
    ["a", false],
    ["a", false],
  ]);
  partial.progress = "received-no-output";
  partial.goalCount = 1;
  partial.totalGoalCount = 2;
  partial.outputNodeIds = ["result"];
  const referenceOnly = card("reference", { receivedBy: "role-x" }, "consumed", [["a", false]]);
  const graph = graphOf([node("a", null)], [role("role-x")], [partial, referenceOnly]);
  assert.deepEqual(graph.handedTo("a"), [
    {
      lane: "role-x",
      cards: 2,
      waiting: 0,
      outputs: 0,
      reviews: 0,
      goalCount: 1,
      totalGoalCount: 2,
      old: false,
    },
  ]);
});

test("map badges count Cards whose outputs wait for review", () => {
  const review = card("review", { receivedBy: "role-x" }, "consumed", [["a", false]]);
  review.progress = "needs-review";
  review.totalGoalCount = 1;
  review.reviewGoalCount = 1;
  review.reviewOutputNodeIds = ["result"];
  const graph = graphOf([node("a", null)], [role("role-x")], [review]);
  assert.deepEqual(graph.handedTo("a"), [
    {
      lane: "role-x",
      cards: 1,
      waiting: 0,
      outputs: 0,
      reviews: 1,
      goalCount: 0,
      totalGoalCount: 1,
      old: false,
    },
  ]);
});

test("a repeated Node source counts its Card once and keeps drift from any of its versions", () => {
  const graph = graphOf(
    [node("a", null)],
    [role("role-x")],
    [
      card("received", { receivedBy: "role-x" }, "consumed", [
        ["a", true],
        ["a", false],
      ]),
      card("waiting", { target: "role-x" }, "pending", [
        ["a", false],
        ["a", true],
      ]),
    ],
  );
  assert.deepEqual(graph.handedTo("a"), [
    {
      lane: "role-x",
      cards: 1,
      waiting: 1,
      outputs: 0,
      reviews: 0,
      goalCount: 0,
      totalGoalCount: 0,
      old: true,
    },
  ]);
});

test("a Card source names its Node or Role from the Tent root or from cards/", () => {
  const graph = graphOf([node("a", null)], [role("role-x")]);
  assert.deepEqual(graph.refOf("/a/a.md"), { kind: "node", id: "a" });
  assert.deepEqual(graph.refOf("../a/./a.md"), { kind: "node", id: "a" });
  assert.deepEqual(graph.refOf("/roles/role-x.md"), { kind: "role", id: "role-x" });
  assert.equal(graph.refOf("https://example.com/a.md"), null);
});

test("each Role keeps its own avatar until it is turned", () => {
  assert.deepEqual(petTraits("role-main"), petTraits("role-main"));
  // The colours the earlier pixel pets gave these Roles.
  assert.equal(petTraits("role-main").hue, 90);
  assert.equal(petTraits("role-ui").hue, 330);
  assert.notDeepEqual(petTraits("role-main#1"), petTraits("role-main"));
});

test("folding a Node leaves its branch off the map and keeps everything else", () => {
  const graph = graphOf([node("a", null), node("a1", "a"), node("a2", "a"), node("b", null)]);
  assert.deepEqual([...treeLayout(graph, new Set()).placed.keys()].sort(), ["a", "a1", "a2", "b"]);
  assert.deepEqual([...treeLayout(graph, new Set(["a"])).placed.keys()].sort(), ["a", "b"]);
});

test("top-level branches sit further apart than siblings", () => {
  const graph = graphOf([
    node("a", null),
    node("a1", "a"),
    node("a2", "a"),
    node("b", null),
    node("b1", "b"),
  ]);
  const layout = treeLayout(graph, new Set());
  // A top-level card stands taller, as the head of its group.
  assert.ok(at(layout, "a").h > at(layout, "a1").h);
  const siblings = at(layout, "a2").y - at(layout, "a1").y;
  const branches = at(layout, "b1").y - at(layout, "a2").y;
  assert.ok(siblings > 0);
  assert.ok(branches > siblings, `branch gap ${branches} should exceed sibling gap ${siblings}`);
});

test("the lens puts what a Node hangs from and what cites it on the left, what it holds and cites on the right", () => {
  const graph = graphOf([
    node("p", null),
    node("f", "p", "goal", {
      links: [linkTo("o"), linkTo("c")],
      incoming: [citedBy("i"), citedBy("k", "card")],
    }),
    node("c", "f"),
    node("o", null),
    node("i", null),
  ]);
  const lens = lensLayout(graph, "f", () => true);
  assert.deepEqual(at(lens, "f"), { id: "f", x: 0, y: 0, h: 36 });
  for (const id of ["p", "i"]) assert.ok(at(lens, id).x < 0, `${id} is on the left`);
  for (const id of ["c", "o"]) assert.ok(at(lens, id).x > 0, `${id} is on the right`);
  // A child that is also linked appears once, as a child; Cards citing the Node are not cards on the map.
  assert.deepEqual(
    lens.labels.map((l) => l.text),
    ["上级 1", "引用了它 1", "下级 1", "它引用的 1"],
  );
  assert.equal(lens.placed.size, 5);

  const hidingO = lensLayout(graph, "f", (id) => id !== "o");
  assert.equal(hidingO.placed.has("o"), false);
  assert.deepEqual(
    hidingO.labels.map((l) => l.text),
    ["上级 1", "引用了它 1", "下级 1"],
  );
});

test("a reference leaves the side facing its target and its arrow points into the target", () => {
  const ends = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const { path, arrow } = refPath({ ...a, w: 216, h: 52 }, { ...b, w: 216, h: 52 });
    const [, sx] = /^M(-?[\d.]+),/.exec(path)!.map(Number);
    const [, tip, , back] = /^M(-?[\d.]+),(-?[\d.]+) L(-?[\d.]+)/.exec(arrow)!.map(Number);
    return { start: sx, tip, pointsRight: tip > back };
  };
  assert.deepEqual(ends({ x: 0, y: 0 }, { x: 300, y: 80 }), {
    start: 216,
    tip: 300,
    pointsRight: true,
  });
  assert.deepEqual(ends({ x: 0, y: 0 }, { x: -300, y: 80 }), {
    start: 0,
    tip: -84,
    pointsRight: false,
  });
  // Same column: loop out on the left and come back into the target's left edge.
  assert.deepEqual(ends({ x: 0, y: 0 }, { x: 0, y: 200 }), { start: 0, tip: 0, pointsRight: true });
});

/** Whether a straight run between two corners passes through a card. */
const crosses = (p: Pt, q: Pt, r: Rect) =>
  Math.max(p.x, q.x) > r.x + 0.5 &&
  Math.min(p.x, q.x) < r.x + r.w - 0.5 &&
  Math.max(p.y, q.y) > r.y + 0.5 &&
  Math.min(p.y, q.y) < r.y + r.h - 0.5;
const box = (x: number, y: number): Rect => ({ x, y, w: 248, h: 36 });

test("a reference runs around the cards between its ends, from its side into the target's, off the middle", () => {
  const from = box(0, 0),
    past = box(304, 0),
    to = box(608, 0);
  const cards = [from, past, to, box(304, 50), box(304, -50)];
  const route = routeLinks(cards, [{ id: "l", from, to }]).get("l");
  assert.ok(route, "routed");
  const pts = route.points;
  // The middle of a side is the tree's; references attach beside it.
  assert.deepEqual(pts[0], { x: 248, y: 26 });
  assert.deepEqual(pts.at(-1), { x: 608, y: 26 });
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i - 1]!.x === pts[i]!.x || pts[i - 1]!.y === pts[i]!.y, "right angles only");
    for (const card of cards)
      assert.ok(!crosses(pts[i - 1]!, pts[i]!, card), `run ${i} passes through a card`);
  }
});

test("references sharing a gap run side by side instead of on top of each other", () => {
  const from = box(0, 0);
  const targets = [box(304, 200), box(304, 250), box(304, 300)];
  const cards = [from, box(304, 0), box(304, 50), box(304, 100), ...targets];
  const routes = routeLinks(
    cards,
    targets.map((to, i) => ({ id: `l${i}`, from, to })),
  );
  assert.equal(routes.size, 3);
  const downs = [...routes.values()].map((r) => {
    const i = r.points.findIndex((p, k) => k > 0 && p.x === r.points[k - 1]!.x);
    return r.points[i]!.x;
  });
  assert.equal(new Set(downs).size, 3, `vertical runs at ${downs.join(", ")}`);
  // They leave the card's side at different heights too.
  assert.equal(new Set([...routes.values()].map((r) => r.points[0]!.y)).size, 3);
});

test("many references on one side stay attached inside the card and keep right angles", () => {
  const from = box(0, 0);
  const targets = Array.from({ length: 10 }, (_, i) => box(304, 150 + i * 50));
  const routes = routeLinks(
    [from, ...targets],
    targets.map((to, i) => ({ id: `crowded-${i}`, from, to })),
  );
  assert.equal(routes.size, targets.length);
  for (const route of routes.values()) {
    const start = route.points[0]!;
    assert.equal(start.x, from.x + from.w);
    assert.ok(start.y >= from.y + 4 && start.y <= from.y + from.h - 4, `endpoint at ${start.y}`);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!,
        b = route.points[i]!;
      assert.ok(a.x === b.x || a.y === b.y, "right angles only");
    }
  }
});

test("a reference within one column goes round on the side it asks for", () => {
  const a = box(0, 0),
    b = box(0, 100);
  const right = routeLinks([a, b], [{ id: "r", from: a, to: b }]).get("r")!.points;
  assert.ok(right[0]!.x === 248 && right.at(-1)!.x === 248, "right sides by default");
  assert.ok(Math.min(...right.map((p) => p.x)) >= 248, "stays right of the column");
  const left = routeLinks([a, b], [{ id: "l", from: a, to: b, loop: -1 }]).get("l")!.points;
  assert.ok(left[0]!.x === 0 && left.at(-1)!.x === 0, "left sides when asked");
});

test("arrow keys move to the closest card in that direction, preferring cards in line", () => {
  const view: Layout = {
    placed: new Map([
      ["here", { id: "here", x: 0, y: 0, h: 36 }],
      ["above", { id: "above", x: 0, y: -68, h: 36 }],
      ["right", { id: "right", x: 300, y: -10, h: 36 }],
      ["far", { id: "far", x: 300, y: 200, h: 36 }],
    ]),
    labels: [],
  };
  const here = view.placed.get("here")!;
  const all = () => true;
  assert.equal(nearest(view, here, [0, -1], all), "above");
  assert.equal(nearest(view, here, [1, 0], all), "right");
  assert.equal(nearest(view, here, [0, 1], all), "far");
  assert.equal(nearest(view, here, [-1, 0], all), null);
  assert.equal(
    nearest(view, here, [0, -1], (id) => id !== "above"),
    "right",
  );
});

test("a link the editor writes reads back to the same document", () => {
  const cases: Array<[string, string]> = [
    ["a/b/b.md", "a/c/c.md"],
    ["a/a.md", "a/b/b.md"],
    ["a/b/c/c.md", "x y/x y.md"],
  ];
  for (const [from, to] of cases) {
    const href = relativeHref(from, to);
    assert.deepEqual(resolveHref(from, href), { tentPath: to }, `${from} -> ${href}`);
  }
  assert.equal(relativeHref("a/b/b.md", "a/c/c.md"), "../c/c.md");
  assert.equal(relativeHref("a/a.md", "a/b/b.md"), "./b/b.md");
  assert.equal(relativeHref("a/b/c/c.md", "x y/x y.md"), "../../../x%20y/x%20y.md");
});

test("a document's image is asked for by its place in the Workspace", () => {
  const from = "a/b/b.md";
  assert.equal(workspaceImagePath(from, "./shot.png"), ".tent/a/b/shot.png");
  assert.equal(workspaceImagePath(from, "/attachments/x%20y.svg"), ".tent/attachments/x y.svg");
  assert.equal(workspaceImagePath(from, "../../../docs/img.JPG"), "docs/img.JPG");
  assert.equal(workspaceImagePath(from, "../../../../outside.png"), null, "outside the Workspace");
  assert.equal(workspaceImagePath(from, "./notes.txt"), null, "not an image");
  assert.equal(workspaceImagePath(from, "https://example.com/a.png"), null, "loaded by address");
});

test("relative times count back in minutes, hours and days", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(ago("2026-09-29T11:59:30Z", now), "刚刚");
  assert.equal(ago("2026-09-29T11:15:00Z", now), "45 分钟前");
  assert.equal(ago("2026-09-29T09:00:00Z", now), "3 小时前");
  assert.equal(ago("2026-09-27T12:00:00Z", now), "2 天前");
  assert.equal(ago(undefined, now), "");
});
