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
import { CARD, rectOf, isResult, shownTree, type Layout, type Rect } from "../src/ui/map/layout.js";
import { nearest, refPath, selectionPath } from "../src/ui/map/geometry.js";
import { arrange, TOPIC } from "../src/ui/map/arrange.js";
import type { Graph } from "../src/ui/data/store.js";
import { ago, relativeHref, resolveHref, workspaceImagePath } from "../src/ui/util.js";
import { setLang } from "../src/ui/i18n.js";
import { cardStateLabel, resultParts } from "../src/ui/data/card-state.js";
import {
  beginLens,
  foldInLens,
  lensFacts,
  lensLines,
  revealInLens,
  selectionAfterLens,
} from "../src/ui/map/lens.js";
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

/** The map as it lays out `graph`: `closed` cards closed, result outputs folded unless their card is in `open`. */
const laidOut = (
  graph: Graph,
  closed: ReadonlySet<string>,
  open: ReadonlySet<string> = new Set(),
  grown: (id: string) => number = () => 0,
  kidsOf: (id: string | null) => SnapshotNode[] = (id) => graph.childrenOf(id),
) =>
  arrange({
    kidsOf,
    closed,
    grown,
    openOutputs: open,
    results: (_id, kids) => kids.filter((c) => isResult(graph, c.id)).map((c) => c.id),
  });
const rectOfPlaced = (layout: Layout, id: string) => rectOf(at(layout, id));
const at = (layout: Layout, id: string) => {
  const p = layout.placed.get(id);
  assert.ok(p, `${id} is placed`);
  return p;
};

test("siblings read goal, then prompt, then output, otherwise keeping their order", () => {
  const graph = graphOf([
    node("a", null, "output"),
    node("b", null),
    node("c", null, "goal"),
    node("d", null, "prompt"),
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
      doing: 0,
      old: true,
    },
    {
      lane: "role-y",
      cards: 2,
      waiting: 0,
      doing: 0,
      old: false,
    },
    {
      lane: "",
      cards: 0,
      waiting: 1,
      doing: 0,
      old: false,
    },
  ]);
  assert.deepEqual(graph.handedTo("b"), [
    {
      lane: "role-y",
      cards: 1,
      waiting: 0,
      doing: 0,
      old: false,
    },
  ]);
});

test("a Card being done shows on each carried Node, counted once however often it names the Node", () => {
  const doing = card("doing", { receivedBy: "role-x" }, "consumed", [
    ["a", false],
    ["a", false],
  ]);
  doing.returnTo = "role-y";
  const finished = card("finished", { receivedBy: "role-x" }, "consumed", [["a", false]]);
  const back = card("back", { receivedBy: "role-x" }, "returned", [["a", false]]);
  back.returnTo = "role-y";
  back.result = "PASS";
  const graph = graphOf(
    [node("a", null)],
    [role("role-x"), role("role-y")],
    [doing, finished, back],
  );
  assert.deepEqual(graph.handedTo("a"), [
    { lane: "role-x", cards: 3, waiting: 0, doing: 1, old: false },
  ]);
});

test("a Card reads only its delivery state, and its result links the Node ids it names", () => {
  setLang("en", false);
  const sent = card("sent", {}, "consumed", []);
  assert.equal(cardStateLabel(sent), "Received");
  assert.equal(cardStateLabel({ ...sent, state: "pending" }), "Pending");
  assert.equal(cardStateLabel({ ...sent, returnTo: "role-y" }), "In progress");
  assert.equal(cardStateLabel({ ...sent, returnTo: "role-y", state: "returned" }), "Returned");
  assert.equal(cardStateLabel({ ...sent, returnTo: "role-y", state: "closed" }), "Collected");
  setLang("zh", false);
  assert.deepEqual(resultParts("PASS, see node-ab12 and node-cd34."), [
    { text: "PASS, see " },
    { nodeId: "node-ab12" },
    { text: " and " },
    { nodeId: "node-cd34" },
    { text: "." },
  ]);
  assert.deepEqual(resultParts("node-ab12"), [{ nodeId: "node-ab12" }]);
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
      doing: 0,
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
  assert.deepEqual([...laidOut(graph, new Set()).placed.keys()].sort(), ["a", "a1", "a2", "b"]);
  assert.deepEqual([...laidOut(graph, new Set(["a"])).placed.keys()].sort(), ["a", "b"]);
});

test("a switched-off type leaves no gap: what was under it hangs from the nearest shown card", () => {
  const graph = graphOf([
    node("g", null, "goal"),
    node("p", "g"),
    node("g2", "p", "goal"),
    node("o", "g2", "output"),
    node("b", null, "goal"),
  ]);
  const noPrompt = shownTree(graph, (id) => graph.nodes.get(id)?.type !== "prompt");
  assert.deepEqual(
    noPrompt.kidsOf("g").map((n) => n.id),
    ["g2"],
  );
  assert.equal(noPrompt.upOf("g2"), "g");
  const laid = laidOut(graph, new Set(), new Set(), () => 0, noPrompt.kidsOf);
  assert.deepEqual([...laid.placed.keys()].sort(), ["b", "g", "g2"]);
  // g2 takes p's column, right after g; its result folds into a count only while outputs are shown.
  assert.equal(at(laid, "g2").x, at(laidOut(graph, new Set()), "p").x);
  assert.deepEqual(laid.folds?.get("g2"), ["o"]);
  const noOutput = shownTree(graph, (id) => graph.nodes.get(id)?.type !== "output");
  assert.equal(
    laidOut(graph, new Set(), new Set(), () => 0, noOutput.kidsOf).folds?.has("g2"),
    false,
  );
  // With the top goal off, its prompt starts the tree.
  const noGoal = shownTree(graph, (id) => graph.nodes.get(id)?.type !== "goal");
  assert.deepEqual(
    noGoal.kidsOf(null).map((n) => n.id),
    ["p"],
  );
  assert.equal(noGoal.upOf("p"), null);
  assert.equal(noGoal.upOf("o"), "p");
});

test("a preview hangs below its card: the title keeps its row and only the cards under it make room", () => {
  const graph = graphOf([
    node("a", null),
    node("a1", "a"),
    node("a2", "a"),
    node("a3", "a"),
    node("b", null),
    node("b1", "b"),
  ]);
  const before = laidOut(graph, new Set());
  const after = laidOut(graph, new Set(), new Set(), (id) => (id === "a2" ? 150 : 0));
  const step = (l: Layout, x: string, y: string) => at(l, y).y - at(l, x).y;
  // The cards above keep their gap; the card below steps down by the preview's height.
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  near(step(after, "a1", "a2"), step(before, "a1", "a2"));
  near(step(after, "a2", "a3"), step(before, "a2", "a3") + 150);
  const grown = rectOfPlaced(after, "a2");
  // Links meet the title row, and the card reaches down over its preview without touching the next card.
  assert.equal(at(after, "a2").head, TOPIC.deeper);
  assert.equal(grown.y + TOPIC.deeper / 2, at(after, "a2").y);
  assert.ok(grown.y + grown.h < rectOfPlaced(after, "a3").y);
  // A reference leaving it starts from the middle of the title row, not of the preview.
  const start = /^M[-\d.]+,([-\d.]+)/.exec(refPath(grown, rectOfPlaced(after, "b1")).path);
  assert.equal(Number(start?.[1]), at(after, "a2").y);
});

test("top-level branches sit further apart than siblings", () => {
  const graph = graphOf([
    node("a", null),
    node("a1", "a"),
    node("a2", "a"),
    node("b", null),
    node("b1", "b"),
  ]);
  const layout = laidOut(graph, new Set());
  // A top-level card stands taller, as the head of its group.
  assert.ok(at(layout, "a").h > at(layout, "a1").h);
  const siblings = rectOfPlaced(layout, "a2").y - rectOfPlaced(layout, "a1").y - TOPIC.deeper;
  const span = (ids: string[]) => {
    const rs = ids.map((id) => rectOfPlaced(layout, id));
    return {
      x1: Math.min(...rs.map((r) => r.x)),
      x2: Math.max(...rs.map((r) => r.x + r.w)),
      y1: Math.min(...rs.map((r) => r.y)),
      y2: Math.max(...rs.map((r) => r.y + r.h)),
    };
  };
  const a = span(["a", "a1", "a2"]),
    b = span(["b", "b1"]);
  const branches = Math.max(b.x1 - a.x2, b.y1 - a.y2, a.x1 - b.x2, a.y1 - b.y2);
  assert.ok(siblings > 0);
  assert.ok(branches > siblings, `branch gap ${branches} should exceed sibling gap ${siblings}`);
});

test("the tree folds result outputs into a count on their parent until it is opened", () => {
  const graph = graphOf([
    node("g", null, "goal"),
    node("o1", "g", "output"),
    node("o2", "g", "output"),
    node("p", "g"),
    node("o3", "p", "output"),
    node("o4", "o3", "output"),
  ]);
  const folded = laidOut(graph, new Set());
  assert.deepEqual(folded.folds?.get("g"), ["o1", "o2"]);
  assert.ok(!folded.placed.has("o1") && folded.placed.has("p"));
  // An output with outputs under it is structure, so it stays a card.
  assert.ok(folded.placed.has("o3") && !folded.placed.has("o4"));
  const opened = laidOut(graph, new Set(), new Set(["g"]));
  assert.ok(opened.placed.has("o1") && !opened.folds?.has("g"));
});

test("lens facts retain five ruled groups, outgoing direction and actual Card receivers", () => {
  const graph = graphOf(
    [
      node("p", null),
      node("f", "p", "goal", {
        links: [linkTo("o"), linkTo("missing")],
        incoming: [citedBy("i"), citedBy("k", "card")],
        materials: [
          { kind: "file", resource: "./code.ts", workspacePath: "src/code.ts" },
          { kind: "node", resource: "m", id: "m" },
          { kind: "invalid", resource: "./gone.ts", error: "missing" },
        ],
        invalid: true,
        invalidReason: "bad header",
      }),
      node("c", "f"),
      node("o", null),
      node("i", null),
      node("m", null),
    ],
    [role("receiver"), role("target")],
    [
      card("waiting", { target: "target" }, "pending", [["f", false]]),
      card("doing", { target: "target", receivedBy: "receiver" }, "consumed", [
        ["f", false],
        ["f", true],
      ]),
      card("returned", { receivedBy: "receiver" }, "returned", [["f", false]]),
      card("other", {}, "closed", [["c", false]]),
    ],
  );
  const facts = lensFacts(graph, "f");
  assert.deepEqual(facts.groups, {
    parent: ["p"],
    children: ["c"],
    incoming: ["i"],
    outgoing: ["o", "m"],
  });
  assert.deepEqual(
    facts.files?.map((m) => m.resource),
    ["./code.ts", "./gone.ts"],
  );
  assert.deepEqual(
    facts.cards?.map(({ card, role }) => [card.id, role?.id ?? null]),
    [
      ["waiting", null],
      ["doing", "receiver"],
      ["returned", "receiver"],
    ],
  );
  assert.equal(graph.nodes.get("f")!.invalid, true);
  assert.equal(graph.nodes.get("f")!.invalidReason, "bad header");
  const reading = lensFacts(buildGraph(graph.snapshot, null, false), "f");
  assert.equal(reading.cards, null);
  assert.equal(reading.files, null);
  assert.deepEqual(lensFacts(graph, "missing").groups, {
    parent: [],
    children: [],
    incoming: [],
    outgoing: [],
  });
});

test("lens arcs connect visible related topics in place, including two neighbours", () => {
  const graph = graphOf([
    node("focus", null, "goal", {
      links: [linkTo("a"), linkTo("hidden")],
      incoming: [citedBy("b")],
    }),
    node("a", null, "prompt", { links: [linkTo("b")] }),
    node("b", null),
    node("hidden", "a"),
    node("unrelated", null),
  ]);
  const base = laidOut(graph, new Set(["a"]));
  const before = [...base.placed];
  const lines = lensLines(graph, lensFacts(graph, "focus"), base.placed);
  assert.deepEqual([...base.placed], before);
  assert.ok(lines.some((l) => l.from === "focus" && l.to === "a" && l.kind === "link"));
  assert.ok(lines.some((l) => l.from === "b" && l.to === "focus" && l.kind === "link"));
  assert.ok(lines.some((l) => l.from === "a" && l.to === "b" && l.kind === "link"));
  assert.ok(!lines.some((l) => [l.from, l.to].some((id) => id === "hidden" || id === "unrelated")));
});

test("lens reading unfolds hidden and result topics temporarily and keeps its entry viewport", () => {
  const graph = graphOf([
    node("focus", null, "goal"),
    node("a", "focus"),
    node("deep", "a"),
    node("result", "deep", "output"),
    node("other", null),
    node("there", "other"),
  ]);
  const saved = {
    selectedId: "focus",
    viewport: { x: 127, y: -38, zoom: 0.7 },
    open: ["focus"],
    shut: ["a", "other"],
    focus: "focus",
    outputs: new Set<string>(),
    previews: new Set<string>(),
    anchor: { id: "focus", at: [55, 80] as [number, number] },
  };
  const session = beginLens(saved);
  const opened = revealInLens(session, graph, "result", () => true);
  const fromFocus = arrange({
    kidsOf: graph.childrenOf,
    focus: opened.focus,
    closed: new Set(opened.shut),
    open: new Set(opened.open),
    openOutputs: opened.outputs,
    results: (id) =>
      graph
        .childrenOf(id)
        .filter((n) => isResult(graph, n.id))
        .map((n) => n.id),
  });
  assert.ok(fromFocus.placed.has("result"));
  assert.equal(opened.focus, "focus");
  const elsewhere = revealInLens(opened, graph, "there", () => true);
  assert.equal(elsewhere.focus, null);
  const changed = foldInLens(elsewhere, { a: "shut", other: null });
  assert.deepEqual(changed.viewport, saved.viewport);
  assert.deepEqual(saved.open, ["focus"]);
  assert.deepEqual(saved.shut, ["a", "other"]);
  assert.equal(saved.outputs.size, 0);
  assert.notEqual(session.viewport, saved.viewport);
  assert.deepEqual(changed.anchor, saved.anchor);
  assert.notEqual(session.anchor?.at, saved.anchor.at);
  assert.deepEqual(session.open, ["focus"]);
  assert.deepEqual(session.shut, ["a", "other"]);
  assert.equal(
    revealInLens(session, graph, "result", () => false),
    session,
  );
  assert.equal(
    revealInLens(session, graph, "deleted", () => true),
    session,
  );
  const afterDelete = buildGraph({
    ...graph.snapshot,
    nodes: graph.snapshot.nodes.filter((n) => n.id !== "a"),
  });
  assert.ok(!lensFacts(afterDelete, "focus").ids.has("a"));
});

test("lens exit restores the entry Node after reading a temporary reveal without stealing Card or Role navigation", () => {
  const graph = graphOf([
    node("entry", null, "goal"),
    node("closed", "entry"),
    node("hidden", "closed"),
    node("other", null),
    node("elsewhere", "other"),
  ]);
  const entry = beginLens({
    selectedId: "entry",
    viewport: { x: 125, y: -40, zoom: 0.8 },
    open: ["entry"],
    shut: ["closed", "other"],
    focus: "entry",
    outputs: new Set<string>(),
    previews: new Set<string>(),
  });
  const baseline = arrange({
    kidsOf: graph.childrenOf,
    closed: new Set(entry.shut),
    open: new Set(entry.open),
    focus: entry.focus,
  });
  const baselinePositions = [...baseline.placed];
  const available = (id: string) => graph.nodes.has(id);
  for (const id of ["hidden", "elsewhere"]) {
    const revealed = revealInLens(entry, graph, id, available);
    const temporary = arrange({
      kidsOf: graph.childrenOf,
      closed: new Set(revealed.shut),
      open: new Set(revealed.open),
      focus: revealed.focus,
    });
    assert.ok(temporary.placed.has(id));
    assert.ok(!baseline.placed.has(id));
    const selected = selectionAfterLens(revealed, { kind: "node", id }, available);
    assert.deepEqual(selected, { kind: "node", id: "entry" });
    assert.ok(selected && baseline.placed.has(selected.id));
    assert.deepEqual(revealed.viewport, entry.viewport);
    assert.deepEqual([...baseline.placed], baselinePositions);
    assert.deepEqual(entry.shut, ["closed", "other"]);
    for (const navigation of [
      { kind: "card" as const, id: "card-next" },
      { kind: "role" as const, id: "role-next" },
      null,
    ]) {
      assert.equal(selectionAfterLens(revealed, navigation, available), navigation);
    }
    const afterDelete = buildGraph({
      ...graph.snapshot,
      nodes: graph.snapshot.nodes.filter((n) => n.id !== "entry"),
    });
    assert.equal(
      selectionAfterLens(revealed, { kind: "node", id }, (nodeId) => afterDelete.nodes.has(nodeId)),
      null,
    );
    assert.equal(
      selectionAfterLens(
        revealed,
        { kind: "node", id },
        (nodeId) => available(nodeId) && nodeId !== "entry",
      ),
      null,
    );
  }
  const unchanged = { kind: "node" as const, id: "entry" };
  assert.equal(selectionAfterLens(entry, unchanged, available), unchanged);
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

test("arrow keys move to the closest card in that direction, preferring cards in line", () => {
  const view: Layout = {
    placed: new Map([
      ["here", { id: "here", x: 0, y: 0, h: 36, w: 248 }],
      ["above", { id: "above", x: 0, y: -68, h: 36, w: 248 }],
      ["right", { id: "right", x: 300, y: -10, h: 36, w: 248 }],
      ["far", { id: "far", x: 300, y: 200, h: 36, w: 248 }],
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

test("combined lens facts use the final layout-unit route around only other Nodes", () => {
  const graph = graphOf([
    node("root", null, "goal"),
    node("a", "root", "prompt", { links: [linkTo("c")] }),
    node("b", "root"),
    node("c", "root", "prompt", { incoming: [citedBy("a")] }),
  ]);
  const layout = laidOut(graph, new Set());
  const facts = lensFacts(graph, "a");
  const lines = lensLines(graph, facts, layout.placed);
  const line = lines.find((line) => line.kind === "link" && line.from === "a" && line.to === "c")!;
  assert.ok(line);
  const a = rectOf(layout.placed.get(line.from)!);
  const c = rectOf(layout.placed.get(line.to)!);
  const obstacles = [...layout.placed.values()].map(rectOf);
  const route = selectionPath(a, c, line.kind, obstacles, 1, 90);
  for (const zoom of [0.4, 2])
    assert.deepEqual(selectionPath(a, c, line.kind, obstacles, zoom, 90), route);
  for (let i = 1; i < route.points.length; i++) {
    const p = route.points[i - 1]!,
      q = route.points[i]!;
    assert.ok(p[0] === q[0] || p[1] === q[1]);
    for (const [id, placed] of layout.placed) {
      if (id === line.from || id === line.to) continue;
      const r = rectOf(placed);
      const crossing =
        p[1] === q[1]
          ? p[1] > r.y &&
            p[1] < r.y + r.h &&
            Math.max(p[0], q[0]) > r.x &&
            Math.min(p[0], q[0]) < r.x + r.w
          : p[0] > r.x &&
            p[0] < r.x + r.w &&
            Math.max(p[1], q[1]) > r.y &&
            Math.min(p[1], q[1]) < r.y + r.h;
      assert.equal(crossing, false, id);
    }
  }
});
