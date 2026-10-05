import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError, type NodeDocument } from "../src/ui/data/api.js";
import type { Snapshot, SnapshotFile, SnapshotNode } from "../src/ui/data/types.js";
import { buildGraph } from "../src/ui/data/store.js";
import { confirmDisplayedNode, History, ReviewRow } from "../src/ui/panel/Details.js";
import { setLang } from "../src/ui/i18n.js";

const displayed: NodeDocument = {
  nodeId: "node-alpha",
  path: "Alpha",
  etag: "displayed-version",
  body: "The text the reader reviewed",
  raw: "The complete displayed document",
  frontmatter: {},
};

test("confirmation submits the displayed document's etag without reading a newer version", async (t) => {
  t.mock.method(api, "node", async () => {
    throw new Error("A hidden reread must not replace the displayed basis");
  });
  const confirm = t.mock.method(api, "confirmNode", async (id: string, baseEtag: string) => ({
    nodeId: id,
    path: displayed.path,
    etag: "confirmed-version",
    changed: true,
    body: displayed.body,
  }));
  await confirmDisplayedNode(displayed);
  assert.deepEqual(confirm.mock.calls[0]!.arguments, [displayed.nodeId, displayed.etag]);
});

test("an external edit conflicts instead of confirming the unseen version", async (t) => {
  const conflict = new ApiError(409, "ETAG_CONFLICT", "Read and review the changed document");
  t.mock.method(api, "node", async () => ({
    ...displayed,
    etag: "unseen-version",
    body: "Unseen",
  }));
  const confirm = t.mock.method(api, "confirmNode", async (_id: string, baseEtag: string) => {
    assert.equal(baseEtag, displayed.etag);
    throw conflict;
  });
  await assert.rejects(confirmDisplayedNode(displayed), (error) => error === conflict);
  assert.equal(confirm.mock.callCount(), 1);
  assert.equal(displayed.etag, "displayed-version");
});

test("confirmation stays disabled before a full read and while unsaved content is displayed", () => {
  const node = { id: displayed.nodeId } as SnapshotNode;
  const render = (doc: NodeDocument | null, disabled = false) =>
    renderToStaticMarkup(
      createElement(ReviewRow, { node, doc, disabled, onRead: () => {}, onToast: () => {} }),
    );
  assert.match(render(null), /disabled=""/);
  assert.match(render(displayed, true), /disabled=""/);
  assert.doesNotMatch(render(displayed), /disabled=""/);
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
  assert.doesNotMatch(render([reused]), /version-row/);
  assert.match(render([{ ...reused, ref: null }]), /Created/);
  assert.match(render([{ ...reused, ref: { kind: "node", id: "node-target" } }]), /Created/);
});
