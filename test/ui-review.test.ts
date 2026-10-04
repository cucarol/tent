import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError, type NodeDocument } from "../src/ui/data/api.js";
import type { SnapshotNode } from "../src/ui/data/types.js";
import { confirmDisplayedNode, ReviewRow } from "../src/ui/panel/Details.js";

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
