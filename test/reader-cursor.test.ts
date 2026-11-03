import assert from "node:assert/strict";
import test from "node:test";
import { pageItems } from "../src/cli/reader-page.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === expected;

test("CLI cursors validate source and revision", () => {
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
});
