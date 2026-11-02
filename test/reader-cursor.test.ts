import assert from "node:assert/strict";
import test from "node:test";
import { pageItems, pageText } from "../src/cli/reader-page.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === expected;

test("CLI cursors validate source, revision and text boundaries", () => {
  const items = { revision: "original", items: Array.from({ length: 50 }, (_, i) => ({ id: i })) };
  const first = pageItems(items, "list", { limit: 4 });
  assert.equal(first.items.length, 4);
  const cursor = first.page.nextCursor!;
  assert.equal(pageItems(items, "list", { limit: 4, cursor }).items[0]!.id, 4);
  assert.throws(() => pageItems(items, "search", { cursor }), code("INVALID_CURSOR"));
  assert.throws(
    () => pageItems({ ...items, revision: "changed" }, "list", { cursor }),
    code("SOURCE_CHANGED"),
  );
  assert.throws(() => pageItems(items, "list", { cursor: cursor + "x" }), code("INVALID_CURSOR"));

  const text = "😀\r\n".repeat(6000);
  const document = {
    text,
    etag: "etag",
    view: "body",
    range: { unit: "utf16" as const, start: 0, end: text.length },
    total: text.length,
  };
  const page = pageText(document, "read");
  assert.equal(page.page.hasMore, true);
  const next = pageText(document, "read", { cursor: page.page.nextCursor });
  assert.equal(next.range.start, page.range.end);
  assert.throws(
    () =>
      pageText(
        {
          text: "😀x",
          etag: "e",
          view: "body",
          range: { unit: "utf16", start: 0, end: 3 },
          total: 3,
        },
        "read",
        { end: 1 },
      ),
    code("INVALID_RANGE"),
  );
  const altered = (position: number) => {
    const data = JSON.parse(Buffer.from(page.page.nextCursor!, "base64url").toString());
    data.position = position;
    return Buffer.from(JSON.stringify(data)).toString("base64url");
  };
  for (const position of [1, 3, text.length + 1])
    assert.throws(
      () => pageText(document, "read", { cursor: altered(position) }),
      code(position > text.length ? "INVALID_RANGE" : "INVALID_RANGE"),
    );
  const diffA = {
    ...document,
    view: "diff",
    from: { commit: "a", path: "A" },
    to: { commit: "b", path: "A" },
  };
  const diffB = { ...diffA, from: { commit: "c", path: "A" } };
  const diffPage = pageText(diffA, "node.diff");
  assert.throws(
    () => pageText(diffB, "node.diff", { cursor: diffPage.page.nextCursor }),
    code("INVALID_CURSOR"),
  );
});

test("CLI previews oversized metadata and keeps later records reachable", () => {
  const items = {
    revision: "same",
    items: [
      { nodeId: "node-large", description: "x".repeat(40000) },
      { nodeId: "node-later", description: "next" },
    ],
  };
  const first = pageItems(items, "node.list", { limit: 1 });
  assert.equal((first.items[0] as Record<string, unknown>)?.descriptionTruncated, true);
  assert.deepEqual((first.items[0] as Record<string, unknown>)?.metadataRead, {
    nodeId: "node-large",
    view: "raw",
  });
  const second = pageItems(items, "node.list", { limit: 1, cursor: first.page.nextCursor });
  assert.equal(second.items[0]?.nodeId, "node-later");
  const document = {
    cardId: "card-large",
    view: "body",
    etag: "etag",
    text: "content".repeat(5000),
    sources: [{ resource: "https://example.com/" + "a".repeat(40000) }],
    range: { unit: "utf16" as const, start: 0, end: 35000 },
    total: 35000,
  };
  const page = pageText(document, "card.get:card-large");
  assert.equal((page as Record<string, unknown>).sourcesOmitted, true);
  assert.deepEqual((page as Record<string, unknown>).metadataRead, {
    cardId: "card-large",
    view: "raw",
    expectedEtag: "etag",
  });
  assert.equal(page.page.hasMore, true);
});
