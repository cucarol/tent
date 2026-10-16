import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGraph } from "../src/ui/data/store.js";
import { UNREAD } from "../src/ui/data/flags.js";
import type { Snapshot, SnapshotCard, SnapshotNode } from "../src/ui/data/types.js";
import { allot, NowView } from "../src/ui/now/NowView.js";
import { setLang } from "../src/ui/i18n.js";

const snapshot = (nodes: SnapshotNode[]): Snapshot => ({
  workspace: { id: "now-test", name: "Now", revision: "revision", generatedAt: "" },
  nodes,
  roles: [],
  cards: [],
  commits: [
    { hash: "ordinary-edit", parent: null, date: "2026-10-06T00:00:00Z", objectIds: [], files: [] },
  ],
  paths: {},
});
const output = (
  id: string,
  outputAt?: string,
  extra: Partial<SnapshotNode> = {},
): SnapshotNode => ({
  id,
  name: id,
  path: id,
  notePath: `${id}/${id}.md`,
  depth: 0,
  type: "output",
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
  history: ["ordinary-edit"],
  outputAt,
  ...extra,
});
const renderNow = (s: Snapshot, flags = {}) =>
  renderToStaticMarkup(
    createElement(NowView, {
      graph: buildGraph(s),
      flags,
      onOpen: () => {},
      onPage: () => {},
    }),
  );

test("finished since last visit includes attachment and confirmation evidence, not ordinary edits", (t) => {
  setLang("en", false);
  const stored = new Map<string, string>([
    ["tent-last-visit:now-test", JSON.stringify("2026-10-05T00:00:00Z")],
  ]);
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    const values = name === "localStorage" ? stored : new Map<string, string>();
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    t.after(() =>
      descriptor
        ? Object.defineProperty(globalThis, name, descriptor)
        : Reflect.deleteProperty(globalThis, name),
    );
  }
  const page = renderNow(
    snapshot([
      output("old-edited-output", "2026-10-01T00:00:00Z"),
      output("new-attached-output", "2026-10-06T00:00:00Z"),
      output("new-confirmed-output", "2026-10-05T12:00:00Z"),
      output("deprecated-output", "2026-10-06T00:00:00Z", { status: "deprecated" }),
      output("archived-output", "2026-10-06T00:00:00Z", { archived: true }),
      output("uncaptured-output"),
    ]),
  );
  // What was finished is read from the strip along the bottom.
  const rendered = page.slice(page.indexOf('class="now-done"'));
  assert.match(rendered, /Finished since your last visit/);
  assert.match(rendered, /new-attached-output/);
  assert.match(rendered, /new-confirmed-output/);
  for (const id of [
    "old-edited-output",
    "deprecated-output",
    "archived-output",
    "uncaptured-output",
  ])
    assert.doesNotMatch(rendered, new RegExp(id));
  assert.ok(rendered.indexOf("new-attached-output") < rendered.indexOf("new-confirmed-output"));
});

test("the Now page only observes: a draft Node gets no approval control", () => {
  setLang("en", false);
  const html = renderNow(
    snapshot([output("node-draft", undefined, { type: "prompt", status: "draft" })]),
  );
  assert.doesNotMatch(html, /Approve|btn primary/);
});

test("a Card whose outputs wait for review stays in its lane", () => {
  setLang("en", false);
  const s = snapshot([]);
  const review: SnapshotCard = {
    id: "card-review",
    title: "Review me",
    state: "consumed",
    progress: "needs-review",
    goalCount: 0,
    totalGoalCount: 1,
    outputNodeIds: [],
    reviewGoalCount: 1,
    reviewOutputNodeIds: ["result"],
    target: null,
    receivedBy: null,
    status: "stable",
    body: "",
    sources: [],
    path: "cards/card-review.md",
    history: [],
    publishedAt: null,
    updatedAt: null,
  };
  s.cards = [review];
  const rendered = renderNow(s);
  assert.match(rendered, /ns-state is-review.*?Review me.*?Needs review · 1 output/);
  assert.match(rendered, /0 in progress · 1 to review/);
  assert.doesNotMatch(rendered, /Idle/);
});

test("a lane lists its Cards newest first, under its counts", () => {
  setLang("en", false);
  const s = snapshot([]);
  s.cards = Array.from({ length: 5 }, (_, i) => ({
    id: `card-${i}`,
    title: `Work ${i}`,
    state: "consumed" as const,
    progress: "received-no-output" as const,
    goalCount: 0,
    totalGoalCount: 1,
    outputNodeIds: [],
    target: null,
    receivedBy: null,
    status: "stable",
    body: "",
    sources: [],
    path: `cards/card-${i}.md`,
    history: [],
    publishedAt: null,
    updatedAt: `2026-10-0${i + 1}T00:00:00Z`,
  }));
  const rendered = renderNow(s);
  assert.match(rendered, /5 in progress/);
  const at = (n: number) => rendered.indexOf(`Work ${n}`);
  assert.ok(at(4) > 0 && at(4) < at(3) && at(3) < at(0));
});

test("rows go round the groups from the top until the next does not fit", () => {
  // Heading 38; rows 32 each with 6 under the last; a 1px hairline between groups.
  assert.deepEqual(allot([2, 1], 1000), [2, 1]);
  assert.deepEqual(allot([50, 3], 200), [2, 1]);
  // Seventy above three: the big group gets the first row, and the small one's would not fit.
  assert.deepEqual(allot([50, 3], 130), [1, 0]);
  // Not even the headings fit: groups are left off the end, behind a line naming them.
  assert.deepEqual(allot([50, 3, 4], 80), [0]);
});

test("the top line counts behind and ahead once the materials are read, leaving baseline gaps out", () => {
  setLang("en", false);
  const s = snapshot([output("both"), output("only-ahead"), output("only-behind"), output("gap")]);
  assert.match(renderNow(s, UNREAD), /Checking against the materials/);
  const rendered = renderNow(s, {
    both: { ahead: { reasons: [] }, behind: { reasons: ["Material changed: ../source.md"] } },
    "only-ahead": { ahead: { reasons: [] } },
    "only-behind": { behind: { reasons: ["Material changed: ../source.md"] } },
    gap: { behind: { reasons: ["Material ../old.md has no retained baseline"] } },
  });
  assert.match(rendered, /2 behind/);
  assert.match(rendered, /2 ahead/);
});

test("each top-level Node of any type is a group listing what under it is behind or ahead", () => {
  setLang("en", false);
  const nodes = [
    output("results", undefined, { type: "output", childIds: ["r1"] }),
    output("r1", undefined, { parentId: "results" }),
    output("spec", undefined, { type: "prompt", childIds: ["g"] }),
    output("g", undefined, { type: "goal", parentId: "spec" }),
    output("calm", undefined, { type: "prompt" }),
  ];
  const rendered = renderNow(snapshot(nodes), {
    r1: { behind: { reasons: ["Material changed: ../source.md"] } },
    g: { ahead: { reasons: [] } },
  });
  const right = rendered.slice(rendered.indexOf("To look at"));
  assert.equal((right.match(/class="ns-group"/g) ?? []).length, 2);
  assert.match(right, /ns-pill is-behind.{0,40}ns-text">r1</);
  assert.match(right, /ns-pill is-ahead.{0,40}ns-text">g</);
  assert.doesNotMatch(right, />calm</);
});

// The right side, "To look at": one group per top-level Node, one row per Node under it.
const attention = (html: string) => html.slice(html.indexOf("To look at"));
const rowsNamed = (html: string, name: string) =>
  (attention(html).match(new RegExp(`ns-text">${name}<`, "g")) ?? []).length;
const plan = (childIds: string[]) => output("plan", undefined, { type: "prompt", childIds });

test("attention says checking until sync is read, and all in sync only for a known empty result", () => {
  setLang("en", false);
  const s = snapshot([]);
  assert.match(renderNow(s, UNREAD), /Checking against the materials/);
  assert.doesNotMatch(renderNow(s, UNREAD), /All in sync/);
  assert.match(renderNow(s), /All in sync/);
});

test("a Node both behind and ahead is one row, counted under both", () => {
  setLang("en", false);
  const under = (id: string) => output(id, undefined, { parentId: "plan" });
  const rendered = renderNow(
    snapshot([
      plan(["both", "only-ahead", "only-behind"]),
      under("both"),
      under("only-ahead"),
      under("only-behind"),
    ]),
    {
      both: { ahead: { reasons: [] }, behind: { reasons: ["Material changed: ../source.md"] } },
      "only-ahead": { ahead: { reasons: [] } },
      "only-behind": { behind: { reasons: ["Material changed: ../source.md"] } },
    },
  );
  assert.match(rendered, /2 behind/);
  assert.match(rendered, /2 ahead/);
  for (const name of ["both", "only-ahead", "only-behind"])
    assert.equal(rowsNamed(rendered, name), 1);
});

// A goal under the top-level "plan", so its row and the reason on it are on the first screen.
const goalTree = (
  outputs: [id: string, parent: string][],
  goalExtra: Partial<SnapshotNode> = {},
) => {
  const kidsOf = (p: string) => outputs.filter(([, parent]) => parent === p).map(([id]) => id);
  return [
    plan(["goal"]),
    output("goal", undefined, {
      type: "goal",
      parentId: "plan",
      notePath: "Plan/Goal/Goal.md",
      childIds: kidsOf("goal"),
      ...goalExtra,
    }),
    ...outputs.map(([id, parent]) =>
      output(id, undefined, {
        parentId: parent,
        notePath: `Plan/Goal/${id}/${id}.md`,
        ...(id === "sub" ? { type: "goal" as const, childIds: kidsOf("sub") } : {}),
      }),
    ),
  ];
};

test("an ahead goal says whether it has no output or none matches it, without claiming a change", () => {
  setLang("en", false);
  const ahead = (reason: string) =>
    attention(
      renderNow(snapshot(goalTree([["o", "goal"]])), { goal: { ahead: { reasons: [reason] } } }),
    );
  assert.match(
    ahead(
      "No output under this goal was saved or confirmed against its current content and materials",
    ),
    /ns-text">goal<\/span><span class="ns-meta is-long">Ahead: it has outputs, but none was confirmed against it as it is now</,
  );
  assert.match(
    ahead("Goal subtree has no current output Node"),
    /ns-text">goal<\/span><span class="ns-meta is-long">Ahead: no output yet</,
  );
  // The retired reason is not read any more.
  assert.match(ahead("Implementation output is behind"), /Ahead: no output yet/);
});

test("a goal behind and ahead at once gives both reasons on its row and in its title", () => {
  setLang("en", false);
  const rendered = attention(
    renderNow(snapshot(goalTree([["o", "goal"]])), {
      goal: {
        behind: { reasons: ["Material changed: ../source.md"] },
        ahead: {
          reasons: [
            "No output under this goal was saved or confirmed against its current content and materials",
          ],
        },
      },
    }),
  );
  const unmatched = "Ahead: it has outputs, but none was confirmed against it as it is now";
  assert.match(rendered, /ns-pill is-behind is-ahead/);
  assert.match(
    rendered,
    new RegExp(`ns-text">goal</span><span class="ns-meta is-long">[^<]+ · ${unmatched}<`),
  );
  assert.match(rendered, new RegExp(`title="goal · [^"]+ · ${unmatched}"`));
  assert.equal(rowsNamed(rendered, "goal"), 1);
});

test("Nodes that only lack a baseline are counted apart; stale content and real changes stay rows", () => {
  setLang("en", false);
  const under = (id: string) => output(id, undefined, { parentId: "plan" });
  const rendered = renderNow(
    snapshot([
      plan(["changed", "gap-a", "gap-b", "stale"]),
      under("changed"),
      under("gap-a"),
      under("gap-b"),
      under("stale"),
    ]),
    {
      changed: { behind: { reasons: ["Material changed: a.md"] } },
      "gap-a": { behind: { reasons: ["Node record unreadable; no retained baseline"] } },
      "gap-b": {
        behind: {
          reasons: [
            "Remote material version is unknown; no network request was made: https://x.test",
          ],
        },
      },
      stale: { behind: { reasons: ["Content is stale on or after 2026-10-01"] } },
    },
  );
  assert.match(rendered, /now-key is-behind"><i><\/i>2 behind/);
  assert.equal(rowsNamed(rendered, "changed"), 1);
  assert.equal(rowsNamed(rendered, "stale"), 1);
  assert.equal(rowsNamed(rendered, "gap-a"), 0);
  assert.equal(rowsNamed(rendered, "gap-b"), 0);
  assert.match(rendered, /2 more only lack a baseline/);
});

test("idle Roles are not reported as no Roles at all", () => {
  setLang("en", false);
  const s = snapshot([]);
  assert.match(renderNow(s), /No Roles yet/);
  s.roles = [
    {
      id: "role-ui",
      title: "UI",
      status: "stable",
      path: "roles/role-ui.md",
      body: "",
      links: [],
      incoming: [],
      history: [],
    },
  ];
  const rendered = renderNow(s);
  assert.doesNotMatch(rendered, /No Roles yet/);
  assert.match(rendered, /Idle/);
});
