import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError, type NodeDocument } from "../src/ui/data/api.js";
import { buildGraph } from "../src/ui/data/store.js";
import { UNREAD } from "../src/ui/data/flags.js";
import type { Snapshot, SnapshotNode } from "../src/ui/data/types.js";
import { approveProposal, NowView } from "../src/ui/now/NowView.js";
import { setLang } from "../src/ui/i18n.js";

const shown = {
  id: "node-proposal",
  body: "Proposal: keep order.json.",
  description: "",
  name: "Proposal",
  type: "prompt",
} as SnapshotNode;

const live: NodeDocument = {
  nodeId: shown.id,
  path: "Proposal",
  etag: "live-version",
  body: shown.body,
  raw: "",
  frontmatter: { status: "draft", type: "prompt" },
};

const saved = (etag: string) => async (id: string) => ({
  nodeId: id,
  path: live.path,
  etag,
  changed: true,
  body: live.body,
});

test("approving a proposal saves stable and confirms in one CAS write", async (t) => {
  t.mock.method(api, "node", async () => live);
  const save = t.mock.method(api, "saveNode", saved("stable-version"));
  const confirm = t.mock.method(api, "confirmNode", saved("confirmed-version"));
  await approveProposal(shown);
  assert.deepEqual(save.mock.calls[0]!.arguments, [
    shown.id,
    { baseEtag: "live-version", frontmatter: { status: "stable" }, confirm: true },
  ]);
  assert.equal(save.mock.callCount(), 1);
  assert.equal(confirm.mock.callCount(), 0);
});

test("a proposal edited after it was shown conflicts without writing", async (t) => {
  t.mock.method(api, "node", async () => ({ ...live, body: "Proposal: switch to index.md." }));
  const save = t.mock.method(api, "saveNode", saved("unexpected"));
  const confirm = t.mock.method(api, "confirmNode", saved("unexpected"));
  await assert.rejects(
    approveProposal(shown),
    (error) => error instanceof ApiError && error.code === "ETAG_CONFLICT",
  );
  assert.equal(save.mock.callCount(), 0);
  assert.equal(confirm.mock.callCount(), 0);
});

test("withdrawn proposals and changed visible metadata conflict before any write", async (t) => {
  for (const changed of [
    { ...live, frontmatter: { ...live.frontmatter, status: "deprecated" } },
    { ...live, frontmatter: { ...live.frontmatter, status: "stable" } },
    { ...live, frontmatter: { ...live.frontmatter, description: "A different reason" } },
    { ...live, frontmatter: { ...live.frontmatter, type: "goal" } },
    { ...live, path: "Changed name" },
  ]) {
    await t.test(JSON.stringify({ path: changed.path, ...changed.frontmatter }), async (t) => {
      t.mock.method(api, "node", async () => changed);
      const save = t.mock.method(api, "saveNode", saved("unexpected"));
      await assert.rejects(
        approveProposal(shown),
        (error) => error instanceof ApiError && error.code === "ETAG_CONFLICT",
      );
      assert.equal(save.mock.callCount(), 0);
    });
  }
});

test("a concurrent edit rejects the single approval write without a second confirmation", async (t) => {
  t.mock.method(api, "node", async () => live);
  const conflict = new ApiError(409, "ETAG_CONFLICT", "The draft changed");
  const save = t.mock.method(api, "saveNode", async () => {
    throw conflict;
  });
  const confirm = t.mock.method(api, "confirmNode", saved("unexpected"));
  await assert.rejects(approveProposal(shown), (error) => error === conflict);
  assert.equal(save.mock.callCount(), 1);
  assert.equal(confirm.mock.callCount(), 0);
  assert.equal(live.frontmatter.status, "draft");
});

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
      onToast: () => {},
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
