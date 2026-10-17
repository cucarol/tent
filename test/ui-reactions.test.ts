import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type { OutputComparison, Snapshot, SnapshotNode } from "../src/ui/data/types.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  comparisonsFor,
  headOf,
  noComparisons,
  outputsToCompare,
  reactionsIn,
  reactsWith,
  summaryOf,
  verifyOf,
  type Answer,
  type Verify,
} from "../src/ui/map/reactions.js";
import { RegionProduct } from "../src/ui/map/Reaction.js";

const node = (id: string, parentId: string | null, extra: Partial<SnapshotNode> = {}) =>
  ({
    id,
    name: id,
    path: id,
    notePath: `${id}/${id}.md`,
    type: "goal",
    tags: [],
    status: "stable",
    archived: false,
    body: "",
    parentId,
    childIds: [],
    links: [],
    materials: [],
    incoming: [],
    history: [],
    ...extra,
  }) as unknown as SnapshotNode;

function graphOf(nodes: SnapshotNode[]) {
  for (const n of nodes) n.childIds = nodes.filter((c) => c.parentId === n.id).map((c) => c.id);
  const snapshot = {
    workspace: { id: "ws", name: "ws", revision: "r", generatedAt: "" },
    nodes,
    roles: [],
    cards: [],
    commits: [],
    paths: {},
  } as unknown as Snapshot;
  return buildGraph(snapshot);
}
const compared = (...list: OutputComparison[]) => ({
  map: new Map(list.map((c) => [c.nodeId, c])),
  status: "ready" as const,
});

const graph = graphOf([
  node("goal", null, { incoming: [{ from: { kind: "node", id: "aside" }, via: "sources" }] }),
  node("out", "goal", { type: "output", outputAt: "2026-10-15T00:00:00Z" }),
  node("step", "goal"),
  node("deep", "step", { type: "output" }),
  node("aside", null, { type: "output" }),
  node("stray", null, { type: "output" }),
  node("rule", null, { type: "prompt" }),
]);

test("verify says how an output stands to the goal, as the tree and Core's comparison hold it", () => {
  const core = compared(
    {
      nodeId: "out",
      goals: [{ goalId: "goal", state: "changed" }],
      changedSince: [{ kind: "goal", nodeId: "goal", name: "goal" }],
    },
    {
      nodeId: "deep",
      goals: [
        { goalId: "step", state: "current" },
        { goalId: "goal", state: "current" },
      ],
      changedSince: [],
    },
  );
  // Right under the goal, which changed after it was written.
  const out = verifyOf(graph, core, "goal", "out");
  assert.equal(out.under, "child");
  assert.equal(out.goalState, "changed");
  assert.deepEqual(out.changed, []);
  assert.deepEqual(headOf(out), { mark: "warn", says: "goal" });
  // Further down and current with every goal above it.
  const deep = verifyOf(graph, core, "goal", "deep");
  assert.equal(deep.under, "below");
  assert.deepEqual(headOf(deep), { mark: "ok", says: "ok" });
  // Naming the goal as a source without standing under it: Core compares no goal for it here.
  const aside = verifyOf(graph, core, "goal", "aside");
  assert.equal(aside.under, "source");
  assert.deepEqual(headOf(aside), { mark: "none", says: "unknown" });
  // Neither under it nor naming it: not evidence, whatever else holds.
  assert.deepEqual(headOf(verifyOf(graph, core, "goal", "stray")), { mark: "none", says: "none" });
  // Before the comparison arrives nothing is claimed.
  assert.deepEqual(headOf(verifyOf(graph, noComparisons, "goal", "out")), {
    mark: "none",
    says: "waiting",
  });
});

test("unknown claims neither a match nor a change; the output's own materials are listed by name", () => {
  const unknown = verifyOf(
    graph,
    compared({ nodeId: "out", goals: [{ goalId: "goal", state: "unknown" }], changedSince: [] }),
    "goal",
    "out",
  );
  assert.deepEqual(headOf(unknown), { mark: "none", says: "unknown" });
  const moved = verifyOf(
    graph,
    compared({
      nodeId: "out",
      goals: [{ goalId: "goal", state: "current" }],
      changedSince: [
        { kind: "material", resource: "../../docs/auth-flow.md" },
        { kind: "material", resource: "docs/%E7%99%BB%E5%BD%95.md" },
      ],
    }),
    "goal",
    "out",
  );
  assert.deepEqual(moved.changed, ["auth-flow.md", "登录.md"]);
  assert.deepEqual(headOf(moved), { mark: "warn", says: "materials" });
});

test("a region reacts each goal with each output; prompts wait for the next recipes", () => {
  assert.deepEqual(
    reactionsIn(graph, noComparisons, ["goal", "rule", "out", "step"]).map(
      (r) => `${r.goal}>${r.output}`,
    ),
    ["goal>out", "step>out"],
  );
  assert.deepEqual(reactionsIn(graph, noComparisons, ["goal", "step", "rule"]), []);
  // Only outputs that meet a goal are compared.
  assert.deepEqual(outputsToCompare(graph, ["out", "rule", "goal"]), ["out"]);
  assert.deepEqual(outputsToCompare(graph, ["out", "aside", "rule"]), []);
  assert.deepEqual(reactsWith("goal"), ["output"]);
  assert.deepEqual(reactsWith("output"), ["goal"]);
  assert.deepEqual(reactsWith("prompt"), []);
});

const pair = (more: Partial<Verify>): Verify => ({
  kind: "verify",
  goal: "goal",
  output: "out",
  under: "child",
  goalState: "current",
  changed: [],
  writtenAt: null,
  read: "ready",
  ...more,
});

test("several pairs say all match only when every pair is known to match", () => {
  const ok = pair({});
  const unknown = pair({ goalState: "unknown" });
  const waiting = pair({ goalState: null, read: "waiting" });
  const failed = pair({ goalState: null, read: "failed" });
  const moved = pair({ goalState: "changed" });
  assert.deepEqual(summaryOf([ok, ok]), { mark: "ok", says: "all", moved: 0, unclear: 0 });
  assert.equal(summaryOf([unknown, unknown]).says, "unclear");
  assert.equal(summaryOf([waiting, waiting]).says, "waiting");
  assert.equal(summaryOf([failed, failed]).says, "failed");
  assert.deepEqual(summaryOf([ok, unknown]), {
    mark: "none",
    says: "unclear",
    moved: 0,
    unclear: 1,
  });
  assert.deepEqual(summaryOf([ok, waiting]).mark, "none");
  // Not evidence, or only naming the goal, never counts as a match.
  assert.equal(summaryOf([ok, pair({ under: "none" })]).says, "unclear");
  assert.equal(summaryOf([ok, pair({ under: "source", goalState: null })]).says, "unclear");
  // A pair that moved leads, and the rest are not folded into matches.
  assert.deepEqual(summaryOf([moved, unknown, ok]), {
    mark: "warn",
    says: "moved",
    moved: 1,
    unclear: 1,
  });
  // The strip as rendered: two unknown pairs, or two still being read, never read as all matching.
  for (const list of [
    [unknown, pair({ output: "o2", goalState: "unknown" })],
    [waiting, pair({ output: "o2", goalState: null, read: "waiting" })],
  ]) {
    const html = renderToStaticMarkup(createElement(RegionProduct, { list, nameOf: (id) => id }));
    assert.match(html, /react-pill/);
    assert.doesNotMatch(html, /都对得上|All match/);
    assert.doesNotMatch(html, /is-ok/);
  }
});

test("an answer counts only for the ask it answered; a failure keeps no old verdict", () => {
  const map = new Map([
    [
      "out",
      { nodeId: "out", goals: [{ goalId: "goal", state: "current" as const }], changedSince: [] },
    ],
  ]);
  const answer = (ask: number, failed = false): Answer => ({ key: "ws:out", ask, map, failed });
  assert.equal(comparisonsFor(null, { key: "ws:out", ask: 1 }).status, "waiting");
  assert.equal(comparisonsFor(answer(1), { key: "ws:out", ask: 1 }).status, "ready");
  // Asked again: the last answer stays up, marked as the last one, never as current.
  const again = comparisonsFor(answer(1), { key: "ws:out", ask: 2 });
  assert.equal(again.status, "refreshing");
  assert.equal(verifyOf(graph, again, "goal", "out").read, "refreshing");
  // Other outputs, or another workspace: nothing from before.
  assert.equal(comparisonsFor(answer(1), { key: "ws:out o2", ask: 2 }).status, "waiting");
  // The latest read failed: no verdict, not even the old green.
  const failed = comparisonsFor(answer(2, true), { key: "ws:out", ask: 2 });
  assert.equal(failed.status, "failed");
  const v = verifyOf(graph, failed, "goal", "out");
  assert.equal(v.goalState, null);
  assert.deepEqual(headOf(v), { mark: "none", says: "failed" });
});
