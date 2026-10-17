import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/ui/data/store.js";
import type { OutputComparison, Snapshot, SnapshotNode } from "../src/ui/data/types.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  comparisonsFor,
  constrainOf,
  contrastOf,
  governOf,
  headOf,
  listed,
  loopOf,
  noComparisons,
  outputsToCompare,
  overlapOf,
  reactionsIn,
  reacts,
  sequenceOf,
  summaryOf,
  verifyOf,
  type Answer,
  type Reaction,
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

const file = (path: string) => ({ kind: "file" as const, resource: path, workspacePath: path });
const by = (from: string, via: "link" | "card-source" = "link") => ({
  from: { kind: "node" as const, id: from },
  via,
});
const world = graphOf([
  node("app", null, { materials: [file("src/app/"), file("docs/auth.md")] }),
  node("login", "app", { materials: [file("src/app/")] }),
  node("lint", "app", { type: "prompt", materials: [file("src/app/")] }),
  node("style", null, {
    type: "prompt",
    materials: [file("src/app/")],
    incoming: [by("app"), by("note", "card-source")],
  }),
  node("spare", null, { type: "prompt", materials: [file("README.md")] }),
  node("note", "app", {
    type: "output",
    outputAt: "2026-10-15T00:00:00Z",
    materials: [file("src/app/"), file("a.md")],
  }),
  node("note2", "login", {
    type: "output",
    outputAt: "2026-10-16T00:00:00Z",
    materials: [file("src/app/"), file("b.md")],
    incoming: [],
  }),
  node("loose", null, { type: "output" }),
  node("other", null),
]);
// note2 cites lint; note names style only as a Card source, which is not citing it.
world.nodes.get("lint")!.incoming.push(by("note2"));

test("goal and rule: whether the rule hangs on the goal, what both name, and whether it fell behind", () => {
  const child = constrainOf(world, {}, "app", "lint");
  assert.equal(child.on, "child");
  assert.deepEqual(child.shared, ["app/"]);
  assert.deepEqual(headOf(child), { mark: "ok", says: "on" });
  assert.equal(constrainOf(world, {}, "app", "style").on, "link");
  // Fallen behind, or no basis to tell: never a plain match.
  const moved = { lint: { behind: { reasons: ["Material changed: src/app/x.ts"] } } };
  assert.deepEqual(headOf(constrainOf(world, moved, "app", "lint")), {
    mark: "warn",
    says: "behind",
  });
  const gaps = { lint: { behind: { reasons: ["no retained baseline for src/app/"] } } };
  assert.deepEqual(headOf(constrainOf(world, gaps, "app", "lint")).mark, "none");
  // Not hanging on it and naming nothing in common: only counted.
  const off = constrainOf(world, {}, "app", "spare");
  assert.deepEqual(headOf(off), { mark: "info", says: "off" });
  assert.equal(listed(off), false);
});

test("rule and conclusion: citing counts; a Card source does not", () => {
  assert.equal(contrastOf(world, "lint", "note2").cites, true);
  const silent = contrastOf(world, "style", "note");
  assert.equal(silent.cites, false);
  assert.equal(listed(silent), false);
});

test("two goals, two rules, two conclusions say only what the tree and materials hold", () => {
  const family = overlapOf(world, "login", "app");
  assert.equal(family.family, "b");
  assert.deepEqual(family.shared, ["app/"]);
  assert.deepEqual(overlapOf(world, "app", "other"), {
    kind: "overlap",
    a: "app",
    b: "other",
    family: null,
    shared: [],
    rules: [],
  });
  assert.deepEqual(overlapOf(world, "app", "login").rules, []);
  assert.deepEqual(governOf(world, "lint", "style").shared, ["app/"]);
  assert.equal(listed(governOf(world, "lint", "spare")), false);
  const seq = sequenceOf(world, "note2", "note");
  assert.deepEqual(seq.goals, ["login", "app"]);
  assert.equal(seq.first, "b");
  assert.deepEqual([seq.onlyA, seq.onlyB, seq.both], [["b.md"], ["a.md"], 1]);
  // No time on one of them: no order claimed.
  assert.equal(sequenceOf(world, "note", "loose").first, null);
  assert.equal(listed(sequenceOf(world, "note", "loose")), false);
});

test("a goal, a rule and a conclusion close a loop only when all three links hold", () => {
  // The rule hangs on the goal and the note is its evidence, but the note never cites the rule.
  const open = loopOf(world, "app", "lint", "note");
  assert.deepEqual([open.ruleOn, open.evidence, open.cites], [true, true, false]);
  assert.deepEqual(headOf(open), { mark: "warn", says: "missing" });
  // Further down counts as evidence; citing closes it.
  assert.deepEqual(headOf(loopOf(world, "app", "lint", "note2")), { mark: "ok", says: "whole" });
  const side = loopOf(world, "login", "lint", "note2");
  assert.deepEqual([side.ruleOn, side.evidence, side.cites], [false, true, true]);
});

test("a region lists loops first, then each pair by its recipe; unrelated pairs only count", () => {
  const all = reactionsIn(world, {}, noComparisons, ["app", "lint", "note", "spare"]);
  assert.deepEqual(
    all.map((r) => r.kind),
    ["loop", "verify", "constrain", "constrain", "contrast", "contrast", "govern"],
  );
  assert.deepEqual(
    all.filter(listed).map((r) => r.kind),
    ["loop", "verify", "constrain"],
  );
  // A goal, a rule and a conclusion with no link between them are not a loop.
  assert.deepEqual(
    reactionsIn(world, {}, noComparisons, ["other", "spare", "loose"]).map((r) => r.kind),
    ["verify", "constrain", "contrast"],
  );
  // Only outputs that meet a goal are compared.
  assert.deepEqual(outputsToCompare(graph, ["out", "rule", "goal"]), ["out"]);
  assert.deepEqual(outputsToCompare(graph, ["out", "aside", "rule"]), []);
  // A dragged card lights up only the cards it has something to say with.
  assert.equal(reacts(world, {}, "app", "note"), true);
  assert.equal(reacts(world, {}, "lint", "app"), true);
  assert.equal(reacts(world, {}, "spare", "app"), false);
  assert.equal(reacts(world, {}, "loose", "other"), false);
});

test("mixed kinds read as items; plain facts read as nothing moved, never as all matching", () => {
  const facts: Reaction[] = [
    overlapOf(world, "login", "app"),
    governOf(world, "lint", "style"),
    governOf(world, "lint", "spare"),
  ];
  assert.deepEqual(summaryOf(facts.filter(listed)), {
    mark: "info",
    says: "facts",
    moved: 0,
    unclear: 0,
  });
  const html = renderToStaticMarkup(
    createElement(RegionProduct, { list: facts, nameOf: (id: string) => id }),
  );
  assert.match(html, /2 项|2 items/);
  assert.doesNotMatch(html, /都对得上|All match/);
  const lone = renderToStaticMarkup(
    createElement(RegionProduct, { list: [governOf(world, "lint", "spare")], nameOf: (id) => id }),
  );
  assert.equal(lone, "");
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
