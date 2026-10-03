import assert from "node:assert/strict";
import test from "node:test";
import { ContextReader, ReaderError, type ReaderDocument } from "../src/core/context-reader.js";
import { contentEtag } from "../src/core/etag.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";

const source = { kind: "live" as const, workspaceId: "ws-reader" };
function doc(id: string, body: string, fields: Record<string, unknown> = {}): ReaderDocument {
  const raw = serializeFrontmatter({ id, type: "prompt", ...fields }, body);
  return {
    nodeId: id,
    name: id,
    path: id,
    type: "prompt",
    etag: contentEtag(raw),
    raw,
    archived: false,
    invalid: false,
    parentNodeId: null,
    childNodeIds: [],
  };
}
const reader = (docs: ReaderDocument[]) =>
  new ContextReader(
    source,
    docs,
    docs.map((doc) => doc.nodeId),
  );

test("Core returns complete body, raw, and metadata without output paging", () => {
  const body = "Context 😀\r\n".repeat(6000);
  const tags = Array.from({ length: 150 }, (_, i) => `tag-${i}-${"界".repeat(40)}`);
  const d = doc("node-large", body, {
    description: "Detailed overview",
    tags,
    sources: [{ resource: "https://example.com/" + "long".repeat(7000) }],
  });
  const r = reader([d]);
  const read = r.read({ nodeId: d.nodeId, view: "body" });
  assert.ok("text" in read);
  assert.equal(read.text, body);
  assert.equal(read.partial, false);
  assert.deepEqual(read.tags, tags);
  assert.deepEqual(read.sources, [{ resource: "https://example.com/" + "long".repeat(7000) }]);
  assert.equal(read.description, "Detailed overview");
  const raw = r.read({ nodeId: d.nodeId, view: "raw" });
  assert.ok("text" in raw);
  assert.equal(raw.text, d.raw);
  assert.equal(r.read({ nodeId: d.nodeId, view: "summary" }).description, "Detailed overview");
  assert.equal(r.list().items[0]!.description, "Detailed overview");
  assert.equal(r.search({ query: "overview" }).items[0]!.description, "Detailed overview");
});

test("Core keeps range and ETag checks while returning every selected code unit", () => {
  const d = doc("node-range", "😀\r\n汉字");
  const r = reader([d]);
  const read = r.read({ nodeId: d.nodeId, range: { unit: "utf16", start: 0, end: 2 } });
  assert.ok("text" in read);
  assert.equal(read.text, "😀");
  assert.equal(read.partial, true);
  assert.throws(
    () => r.read({ nodeId: d.nodeId, range: { unit: "utf16", start: 1, end: 2 } }),
    (error) => error instanceof ReaderError && error.code === "INVALID_RANGE",
  );
  assert.throws(
    () => r.read({ nodeId: d.nodeId, expectedEtag: "old" }),
    (error) => error instanceof ReaderError && error.code === "SOURCE_CHANGED",
  );
});

test("search and relations return complete result sets", () => {
  const target = doc("node-target", "Target");
  const body = "[first](../node-target/node-target.md)\n[second](../node-target/node-target.md)\n";
  const from = doc("node-from", body, { resource: "../../src/a.ts" });
  const r = reader([target, from]);
  assert.equal(r.search({ resource: "../src/a.ts" }).items[0]!.nodeId, from.nodeId);
  assert.equal(r.relations({ nodeId: target.nodeId, direction: "incoming" }).items.length, 2);
  assert.equal(r.relations({ nodeId: from.nodeId, direction: "outgoing" }).items.length, 3);
  assert.equal(r.search({ query: "Target" }).items.length, 2);
  const many = reader(
    Array.from({ length: 81 }, (_, i) =>
      doc(`node-many${i}`, "ACP cancellation preserves drafts."),
    ),
  );
  assert.equal(many.search({ query: "ACP drafts" }).items.length, 81);
});
