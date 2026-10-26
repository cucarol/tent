import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeDocument } from "../src/ui/data/api.js";
import type { Snapshot, SnapshotFile } from "../src/ui/data/types.js";
import { buildGraph } from "../src/ui/data/store.js";
import { History, ReviewRow } from "../src/ui/panel/Details.js";
import { setLang } from "../src/ui/i18n.js";

const displayed: NodeDocument = {
  nodeId: "node-alpha",
  path: "Alpha",
  etag: "displayed-version",
  body: "The text the reader reviewed",
  raw: "The complete displayed document",
  frontmatter: { verified: { by: "process:codex", at: "2026-10-16T08:00:00Z" } },
  trustTier: "machine-confirmed",
};

test("the review row states who checked the Node, with nothing to press and no behind or ahead", () => {
  setLang("en", false);
  const html = renderToStaticMarkup(createElement(ReviewRow, { doc: displayed }));
  assert.match(html, /Machine-confirmed/);
  assert.match(html, /process:codex/);
  assert.doesNotMatch(html, /Behind|Ahead/);
  assert.doesNotMatch(html, /<button/);
});

test("history follows identity across moves even when another document used the current path", () => {
  setLang("en", false);
  const path = "Current/Current.md";
  const render = (files: SnapshotFile[]) => {
    const snapshot: Snapshot = {
      workspace: { id: "history", name: "History", revision: "r", generatedAt: "" },
      nodes: [],
      roles: [],
      cards: [],
      paths: {},
      commits: [
        { hash: "older", parent: null, date: "2026-10-01T00:00:00Z", objectIds: [], files },
      ],
    };
    return renderToStaticMarkup(
      createElement(History, {
        graph: buildGraph(snapshot),
        id: "node-target",
        path,
        hashes: ["older"],
      }),
    );
  };
  const reused: SnapshotFile = { path, status: "A", ref: { kind: "node", id: "node-other" } };
  const historical: SnapshotFile = {
    path: "Old/Old.md",
    status: "M",
    ref: { kind: "node", id: "node-target" },
  };
  assert.match(render([reused, historical]), /Changed/);
  assert.doesNotMatch(render([reused, historical]), /Created/);
  const foreignHistory = render([reused]);
  assert.doesNotMatch(foreignHistory, /Created/);
  assert.doesNotMatch(foreignHistory, />older</);
  assert.match(render([{ ...reused, ref: null }]), /Created/);
  assert.match(render([{ ...reused, ref: { kind: "node", id: "node-target" } }]), /Created/);
});
