import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoryTrees,
  historicalGraph,
  historyViewGraph,
  readHistoricalNode,
} from "../src/ui/data/history-tree.js";
import { historyLayout } from "../src/ui/map/history-layout.js";
import { buildGraph } from "../src/ui/data/store.js";
import type { Snapshot, SnapshotNode } from "../src/ui/data/types.js";
import type { HistoryTree } from "../src/core/read/history-query.js";
import { rectOf } from "../src/ui/map/layout.js";
import { arrange, CENTRE } from "../src/ui/map/arrange.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Reader } from "../src/ui/panel/Reader.js";
import type { Work } from "../src/ui/shell/work.js";
import { t } from "../src/ui/i18n.js";

const node = (
  id: string,
  parentId: string | null = null,
  extra: Partial<SnapshotNode> = {},
): SnapshotNode => ({
  id,
  parentId,
  name: id,
  type: "prompt",
  path: id,
  notePath: `${id}/${id}.md`,
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
  ...extra,
});
function graph(nodes: SnapshotNode[]) {
  const snapshot: Snapshot = {
    workspace: { id: "ws", name: "Test", revision: "now", generatedAt: "" },
    nodes,
    roles: [],
    cards: [],
    commits: [],
    paths: {},
  };
  return buildGraph(snapshot);
}
function tree(nodes: Array<[string, string, string | null, string?]>, commit = "old"): HistoryTree {
  return {
    commit,
    nodes: nodes.map(([id, name, parentId, type = "prompt"]) => ({
      id,
      name,
      parentId,
      type,
      path: name,
      version: { commit, path: `${name}/${name}.md` },
    })),
  };
}

test("past graph uses historical structure and names, preserves live drawing order, appends deleted names and drops current facts", () => {
  const current = graph([
    node("node-parent", null, { type: "goal" }),
    node("node-z", "node-parent", {
      name: "Z",
      type: "goal",
      status: "deprecated",
      links: [{ label: "x", href: "x", ref: { kind: "node", id: "node-parent" } }],
      materials: [{ kind: "file", resource: "now.txt" }],
      body: "present",
    }),
    node("node-a", "node-parent", { name: "A" }),
    node("node-later"),
  ]);
  const past = historicalGraph(
    current,
    tree([
      ["node-parent", "Parent", null, "goal"],
      ["node-a", "old A", "node-parent"],
      ["node-deleted-z", "Deleted Z", "node-parent", "goal"],
      ["node-z", "old Z", "node-parent", "output"],
      ["node-deleted-a", "Deleted A", "node-parent"],
      ["node-moved", "Moved", "node-a"],
    ]),
  );
  assert.deepEqual(
    past.childrenOf("node-parent").map((node) => node.id),
    ["node-z", "node-a", "node-deleted-a", "node-deleted-z"],
  );
  assert.equal(past.nodes.has("node-later"), false);
  assert.equal(past.nodes.get("node-z")?.type, "output");
  assert.equal(past.nodes.get("node-z")?.name, "old Z");
  assert.equal(past.nodes.get("node-moved")?.parentId, "node-a");
  assert.deepEqual(
    past.ancestors("node-moved").map((node) => node.id),
    ["node-parent", "node-a"],
  );
  assert.deepEqual(past.nodes.get("node-z")?.materials, []);
  assert.deepEqual(past.nodes.get("node-z")?.links, []);
  assert.equal(past.nodes.get("node-z")?.body, "");
  assert.equal(past.states.get("node-z")?.deprecated, false);
  assert.equal(
    past.snapshot.roles.length + past.snapshot.cards.length + past.snapshot.commits.length,
    0,
  );
  assert.equal(past.snapshot.modules, undefined);
  assert.equal(historicalGraph(current, null).nodes.size, 0);
});

test("immutable requests are shared and late A/B results cannot replace B or now; errors stay explicit", async () => {
  const resolves = new Map<string, (tree: HistoryTree) => void>();
  const calls: string[] = [];
  const reads = new HistoryTrees((commit) => {
    calls.push(commit);
    return new Promise((resolve, reject) => {
      if (commit === "bad") reject(new Error("failed"));
      else resolves.set(commit, resolve);
    });
  });
  const events: Array<string | null> = [];
  const receive = (value: HistoryTree | null, error?: unknown) =>
    events.push(error ? "error" : (value?.commit ?? null));
  reads.select("A", receive);
  reads.select("B", receive);
  resolves.get("A")!(tree([], "A"));
  await Promise.resolve();
  assert.deepEqual(events, [null, null]);
  resolves.get("B")!(tree([], "B"));
  await Promise.resolve();
  assert.equal(events.at(-1), "B");
  reads.select("A", receive);
  reads.select(null, receive);
  await Promise.resolve();
  assert.equal(events.at(-1), null);
  await reads.get("A");
  assert.deepEqual(calls, ["A", "B"]);
  reads.select("bad", receive);
  await Promise.resolve();
  assert.equal(events.at(-1), "error");
  reads.select("bad", receive);
  await Promise.resolve();
  assert.deepEqual(calls, ["A", "B", "bad"]);
});

test("view selection returns only matching history, no live fallback, and restores current graph immediately", () => {
  const current = graph([node("node-live")]);
  const old = tree([["node-deleted", "Old name", null]], "A");
  assert.equal(historyViewGraph(current, "A", null).nodes.size, 0);
  assert.equal(historyViewGraph(current, "B", old).nodes.size, 0);
  assert.deepEqual([...historyViewGraph(current, "A", old).nodes.keys()], ["node-deleted"]);
  assert.equal(historyViewGraph(current, null, old), current);
});

test("historical Node pages request the selected identity and commit:path and reject incomplete or mismatched reads", async () => {
  const selection = {
    node: node("node-deleted", null, { name: "Old name" }),
    version: { commit: "A", path: "Old/Old.md" },
  };
  const called: unknown[] = [];
  assert.deepEqual(
    await readHistoricalNode(selection, async (nodeId, version) => {
      called.push({ nodeId, version });
      return { nodeId, text: "historical\r\ntext🙂", partial: false };
    }),
    { body: "historical\r\ntext🙂" },
  );
  assert.deepEqual(called, [{ nodeId: selection.node.id, version: selection.version }]);
  await assert.rejects(
    readHistoricalNode(selection, async () => ({
      nodeId: "node-live",
      text: "now",
      partial: false,
    })),
    /identity does not match/,
  );
  await assert.rejects(
    readHistoricalNode(selection, async () => ({
      nodeId: "node-deleted",
      text: "cut",
      partial: true,
    })),
    /text is incomplete/,
  );
});

test("Reader renders a deleted historical Node in the shared page shell with no live edit or Card controls", () => {
  const current = graph([node("node-live", null, { name: "Today's name" })]);
  const html = renderToStaticMarkup(
    createElement(Reader, {
      graph: current,
      target: { kind: "node", id: "node-deleted" },
      historical: {
        node: node("node-deleted", null, { name: "Historical name" }),
        version: { commit: "a".repeat(40), path: "Old/Old.md" },
      },
      work: {} as Work,
      startEditing: true,
      onOpen() {},
      onClose() {},
      onLocate() {},
      onToast() {},
    }),
  );
  assert.match(html, /Historical name/);
  assert.match(html, /pg-scroll/);
  assert.match(html, /aaaaaaa/);
  assert.ok(!html.includes(t.sheet.notFound));
  assert.ok(!html.includes(`aria-label="${t.sheet.edit}"`));
  assert.ok(!html.includes('draggable="true"'));
  assert.ok(!html.includes("Today's name"));
});

test("unchanged topics keep coordinates when an earlier sibling disappears; new topics do not overlap them", () => {
  const current = graph([
    node("node-parent", null, { type: "goal" }),
    node("node-before", "node-parent"),
    node("node-keep", "node-parent"),
  ]);
  const first = arrange({ kidsOf: current.childrenOf, closed: new Set() });
  const next = historicalGraph(
    current,
    tree([
      ["node-parent", "node-parent", null, "goal"],
      ["node-keep", "node-keep", "node-parent"],
      ["node-new", "new", "node-parent"],
    ]),
  );
  const layout = historyLayout(
    { graph: current, layout: first },
    next,
    arrange({ kidsOf: next.childrenOf, closed: new Set() }),
  );
  for (const id of ["node-parent", "node-keep"])
    assert.deepEqual(layout.placed.get(id), first.placed.get(id));
  const all = new Map([...layout.placed, [CENTRE, layout.centre]]);
  // Lines leave from the bottom of the parent's title row, the centre's base line included.
  for (const line of layout.lines) {
    const from = all.get(line.source)!,
      to = all.get(line.target)!;
    const side = layout.topics.get(line.target)!.side;
    assert.deepEqual(line.points[0], [
      side > 0 ? from.x + from.w : from.x,
      rectOf(from).y + (from.head ?? from.h),
    ]);
    assert.deepEqual(line.points.at(-1), [
      side > 0 ? to.x : to.x + to.w,
      rectOf(to).y + (to.head ?? to.h),
    ]);
  }
  const positions = [...layout.placed.values()].map(rectOf);
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]!,
        b = positions[j]!;
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    }
});

test("remeasured historical headings use the fresh arrangement rather than overlapping fixed descendants", () => {
  const g = graph([
    node("parent", null, { name: "A long unchanged heading", type: "goal" }),
    node("child", "parent"),
  ]);
  const measure = (width: number) =>
    arrange({
      kidsOf: g.childrenOf,
      closed: new Set(),
      measure: (_id, depth) => ({
        w: depth === 0 ? 176 : depth === 1 ? width : 160,
        h: depth === 0 ? 52 : depth === 1 ? 30 : 25,
      }),
    });
  for (const [beforeWidth, afterWidth] of [
    [200, 500],
    [500, 200],
  ]) {
    const before = measure(beforeWidth!),
      after = measure(afterWidth!);
    const held = historyLayout({ graph: g, layout: before }, g, after);
    const a = rectOf(held.placed.get("parent")!),
      b = rectOf(held.placed.get("child")!);
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    assert.deepEqual(held.placed, after.placed);
  }
});

test("historical rename keeps an unrelated unchanged topic at its prior coordinates", () => {
  const beforeGraph = graph(["a", "b", "c"].map((id) => node(id, null, { type: "goal" })));
  const nextGraph = graph([
    node("a", null, { type: "goal", name: "A much longer renamed title" }),
    node("c", null, { type: "goal" }),
  ]);
  const layout = (g: ReturnType<typeof graph>, renamed: boolean) =>
    arrange({
      kidsOf: g.childrenOf,
      closed: new Set(),
      measure: (id, depth) => ({
        w: depth === 0 ? 176 : renamed && id === "a" ? 300 : 100,
        h: depth === 0 ? 52 : 30,
      }),
    });
  const before = layout(beforeGraph, false),
    fresh = layout(nextGraph, true);
  assert.equal(before.placed.get("c")!.y, -26);
  assert.equal(fresh.placed.get("c")!.y, 0);
  const held = historyLayout({ graph: beforeGraph, layout: before }, nextGraph, fresh);
  assert.deepEqual(held.placed.get("c"), before.placed.get("c"));
  assert.equal(held.placed.get("a")!.w, 300);
  const a = rectOf(held.placed.get("a")!),
    c = rectOf(held.placed.get("c")!);
  assert.ok(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y);
});

test("combined history arrangement carries summaries and title-underlined tree lines with retained coordinates", () => {
  const current = graph([
    node("node-parent", null, { type: "goal" }),
    ...Array.from({ length: 14 }, (_, i) => node(`node-${i}`, "node-parent")),
    node("node-output", "node-parent", { type: "output" }),
  ]);
  const arrangeGraph = (graph: ReturnType<typeof buildGraph>) =>
    arrange({
      kidsOf: graph.childrenOf,
      closed: new Set<string>(),
      results: (_id, kids) => kids.filter((kid) => kid.type === "output").map((kid) => kid.id),
    });
  const first = arrangeGraph(current);
  const next = historicalGraph(
    current,
    tree([
      ["node-parent", "node-parent", null, "goal"],
      ...Array.from(
        { length: 13 },
        (_, i) => [`node-${i + 1}`, `node-${i + 1}`, "node-parent"] as [string, string, string],
      ),
      ["node-output", "node-output", "node-parent", "output"],
    ]),
  );
  const layout = historyLayout({ graph: current, layout: first }, next, arrangeGraph(next));
  assert.ok(layout.summaries.length > 0);
  for (const [id, placed] of layout.placed) {
    const old = first.placed.get(id);
    if (old) assert.deepEqual([placed.x, placed.y], [old.x, old.y]);
  }
  const all = new Map([
    ...layout.placed,
    [layout.centre.id, layout.centre] as const,
    ...layout.summaries.map((summary) => [summary.at.id, summary.at] as const),
  ]);
  const positions = [...all.values()].map(rectOf);
  for (let i = 0; i < positions.length; i++)
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]!,
        b = positions[j]!;
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    }
  for (const line of layout.lines) {
    const from = all.get(line.source)!,
      to = all.get(line.target)!;
    assert.ok(from && to);
    const end = line.points.at(-1)!;
    assert.equal(end[1], rectOf(to).y + (to.head ?? to.h));
    assert.ok(end[0] === to.x || end[0] === to.x + to.w);
  }
  // A current focus at the old centre must not overlap the project's synthetic centre on entering time.
  const focused = arrange({ kidsOf: current.childrenOf, closed: new Set(), focus: "node-parent" });
  const full = arrangeGraph(next);
  assert.equal(historyLayout({ graph: current, layout: focused }, next, full), full);
});
