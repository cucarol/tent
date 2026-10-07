import assert from "node:assert/strict";
import test from "node:test";
import { extractNodeMentions } from "../src/markdown/links.js";
import { ContextReader, type ReaderDocument } from "../src/core/context-reader.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { contentEtag } from "../src/core/etag.js";
import { nodeSemanticFingerprint } from "../src/core/node-sync-record.js";

test("mentions retain each bare known token range, including code and HTML text, outside Markdown links", () => {
  const body =
    "node-abc123 and `node-abc123`，node-def456\n" +
    "[node-def456](node-abc123) [named][node-abc123]\n\n[node-abc123]: node-def456\n" +
    "node-unknown node-abc123x xnode-def456 node-def456-other node-self00 NODE-abc123\n" +
    "```\nnode-abc123\n```\n<div>node-def456</div>";
  const mentions = extractNodeMentions(
    body,
    new Set(["node-abc123", "node-def456", "node-self00"]),
    "node-self00",
  );
  assert.deepEqual(
    mentions.map((m) => m.targetNodeId),
    ["node-abc123", "node-abc123", "node-def456", "node-abc123", "node-def456"],
  );
  assert.deepEqual(
    mentions.map((m) => body.slice(m.range.start, m.range.end)),
    mentions.map((m) => m.targetNodeId),
  );
  const before = nodeSemanticFingerprint({ type: "prompt" }, body);
  extractNodeMentions(body, new Set());
  assert.equal(nodeSemanticFingerprint({ type: "prompt" }, body), before);
});

test("materialized Node readers expose mentions in both directions with exact read addresses", () => {
  const document = (id: string, body: string): ReaderDocument => {
    const raw = serializeFrontmatter({ id, type: "prompt" }, body);
    return {
      nodeId: id,
      name: id,
      path: id,
      raw,
      etag: contentEtag(raw),
      archived: false,
      invalid: false,
      parentNodeId: null,
      childNodeIds: [],
    };
  };
  const from = document("node-abc123", "Read node-def456 twice: node-def456.");
  const target = document("node-def456", "Target");
  const reader = new ContextReader(
    { kind: "live", workspaceId: "ws-mentions" },
    [from, target],
    [from.nodeId, target.nodeId],
  );
  const incoming = reader.relations({ nodeId: target.nodeId, direction: "incoming" }).items;
  const outgoing = reader.relations({ nodeId: from.nodeId, direction: "outgoing" }).items;
  assert.deepEqual(incoming, outgoing);
  assert.equal(incoming.length, 2);
  assert.equal(incoming[0]!.kind, "mention");
  assert.deepEqual(incoming[0]!.read, {
    nodeId: from.nodeId,
    view: "body",
    expectedEtag: from.etag,
    range: { unit: "utf16", start: 5, end: 16 },
  });
});
