import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGraph } from "../src/ui/data/store.js";
import { UNREAD } from "../src/ui/data/flags.js";
import type { Snapshot, SnapshotNode } from "../src/ui/data/types.js";
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
