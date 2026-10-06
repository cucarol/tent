import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGraph } from "../src/ui/data/store.js";
import { UNREAD } from "../src/ui/data/flags.js";
import type { Snapshot, SnapshotCard, SnapshotNode } from "../src/ui/data/types.js";
import { NowView } from "../src/ui/now/NowView.js";
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
  const rendered = renderNow(
    snapshot([
      output("old-edited-output", "2026-10-01T00:00:00Z"),
      output("new-attached-output", "2026-10-06T00:00:00Z"),
      output("new-confirmed-output", "2026-10-05T12:00:00Z"),
      output("deprecated-output", "2026-10-06T00:00:00Z", { status: "deprecated" }),
      output("archived-output", "2026-10-06T00:00:00Z", { archived: true }),
      output("uncaptured-output"),
    ]),
  );
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

test("attention shows checking until sync is read, and all in sync only for a known empty result", () => {
  setLang("en", false);
  const s = snapshot([]);
  assert.match(renderNow(s, UNREAD), /Checking against the materials/);
  assert.doesNotMatch(renderNow(s, UNREAD), /All in sync/);
  assert.match(renderNow(s), /All in sync/);
});

test("attention counts dual flags in both categories while listing each Node once", () => {
  setLang("en", false);
  const rendered = renderNow(
    snapshot([output("both"), output("only-ahead"), output("only-behind")]),
    {
      both: { ahead: { reasons: [] }, behind: { reasons: ["source.md"] } },
      "only-ahead": { ahead: { reasons: [] } },
      "only-behind": { behind: { reasons: ["source.md"] } },
    },
  );
  assert.match(rendered, /2 behind/);
  assert.match(rendered, /2 ahead/);
  assert.equal((rendered.match(/>both</g) ?? []).length, 1);
  assert.equal((rendered.match(/>only-ahead</g) ?? []).length, 1);
  assert.equal((rendered.match(/>only-behind</g) ?? []).length, 1);
});

test("the Now page only observes: a draft Node gets no approval control", () => {
  setLang("en", false);
  const html = renderNow(
    snapshot([output("node-draft", undefined, { type: "prompt", status: "draft" })]),
  );
  assert.doesNotMatch(html, /Approve|btn primary/);
});

test("a goal edit is listed once on each changed goal, with the outputs it leaves to review", () => {
  setLang("en", false);
  const goal = output("goal", undefined, {
    type: "goal",
    notePath: "Goal/Goal.md",
    childIds: ["sub", "o1", "o3"],
  });
  const sub = output("sub", undefined, {
    type: "goal",
    parentId: "goal",
    notePath: "Goal/sub/sub.md",
    childIds: ["o2"],
  });
  const under = (id: string, parentId = "goal") =>
    output(id, undefined, { parentId, notePath: `Goal/${id}/${id}.md` });
  const changed = (goal: string, at: string) => `Goal ${goal}: Material changed: ${at}`;
  const rendered = renderNow(
    snapshot([goal, sub, under("o1"), under("o2", "sub"), under("o3"), under("o4", "sub")]),
    {
      goal: { ahead: { reasons: [] } },
      o1: { behind: { reasons: [changed("goal", "/Goal/Goal.md")] } },
      // An ancestor goal changed: the output folds into that goal, not its nearest one.
      o2: { behind: { reasons: [changed("goal", "/Goal/Goal.md")] } },
      o3: {
        behind: { reasons: [changed("goal", "/Goal/Goal.md"), "Material changed: /src/a.ts"] },
      },
      // The goal named by the reason is not ahead, so nothing explains it away.
      o4: { behind: { reasons: [changed("sub", "/Goal/sub/sub.md")] } },
    },
  );
  assert.match(rendered, /2 outputs to review/);
  assert.doesNotMatch(rendered, />o1</);
  assert.doesNotMatch(rendered, />o2</);
  // Also behind for its own material, so it still needs its own line.
  assert.equal((rendered.match(/>o3</g) ?? []).length, 1);
  assert.equal((rendered.match(/>o4</g) ?? []).length, 1);
  assert.match(rendered, /4 behind/);
});

test("baseline gaps under a changed goal stay listed", () => {
  setLang("en", false);
  const goal = output("goal", undefined, {
    type: "goal",
    notePath: "Goal/Goal.md",
    childIds: ["o"],
  });
  const rendered = renderNow(
    snapshot([goal, output("o", undefined, { parentId: "goal", notePath: "Goal/o/o.md" })]),
    {
      goal: { ahead: { reasons: [] } },
      o: {
        behind: {
          reasons: [
            "Goal goal: Output has no retained baseline for this ancestor goal: /Goal/Goal.md",
          ],
        },
      },
    },
  );
  assert.match(rendered, />o</);
  assert.doesNotMatch(rendered, /outputs? to review/);
});

test("attention keeps same-named external materials and unknown causes visible", () => {
  setLang("en", false);
  const goal = output("goal", undefined, {
    type: "goal",
    notePath: "Goal/Goal.md",
    childIds: ["same-name", "unknown"],
  });
  const under = (id: string) =>
    output(id, undefined, { parentId: "goal", notePath: `Goal/${id}/${id}.md` });
  const rendered = renderNow(snapshot([goal, under("same-name"), under("unknown")]), {
    goal: { ahead: { reasons: [] } },
    "same-name": { behind: { reasons: ["Material changed: /Other/Goal.md"] } },
    unknown: { behind: { reasons: [] } },
  });
  assert.match(rendered, />same-name</);
  assert.match(rendered, />unknown</);
  assert.doesNotMatch(rendered, /outputs? to review/);
});

test("a goal's material warning and folded output review both remain visible", () => {
  setLang("en", false);
  const goal = output("goal", undefined, {
    type: "goal",
    notePath: "Goal/Goal.md",
    childIds: ["result"],
  });
  const result = output("result", undefined, {
    parentId: "goal",
    notePath: "Goal/result/result.md",
  });
  const rendered = renderNow(snapshot([goal, result]), {
    goal: {
      ahead: { reasons: [] },
      behind: { reasons: ["Material changed: ../requirements.md"] },
    },
    result: { behind: { reasons: ["Goal goal: Material changed: /Goal/Goal.md"] } },
  });
  assert.match(rendered, /requirements.md/);
  assert.match(rendered, /1 output to review/);
  assert.doesNotMatch(rendered, />result</);
  assert.match(rendered, /2 behind/);
  assert.match(rendered, /1 ahead/);
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
  // Folded to one line per lane until opened, so old Cards do not bury current work.
  assert.match(rendered, /Needs review/);
  assert.match(rendered, /1 Card with output to review/);
  assert.doesNotMatch(rendered, /Review me/);
  assert.doesNotMatch(rendered, /Idle/);
});
