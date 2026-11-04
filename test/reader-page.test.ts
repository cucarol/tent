import assert from "node:assert/strict";
import test from "node:test";
import { pageBounds, pageItems } from "../src/cli/reader-page.js";

test("a page continues at page.next and the last one has none", () => {
  const items = Array.from({ length: 5 }, (_, id) => ({ id }));
  const first = pageItems(items.slice(0, 2), 0, items.length);
  assert.deepEqual(first.page, { hasMore: true, next: 2 });
  const last = pageItems(items.slice(4, 6), 4, items.length);
  assert.deepEqual(last.items, [{ id: 4 }]);
  assert.deepEqual(last.page, { hasMore: false });
});

test("a page shrinks to the output budget and always holds a record", () => {
  const items = Array.from({ length: 20 }, (_, id) => ({ id, text: "x".repeat(2000) }));
  const page = pageItems(items, 0, items.length);
  assert.ok(page.items.length > 1 && page.items.length < 20);
  assert.equal(page.page.next, page.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16 * 1024);
  const large = [{ id: 0, text: "x".repeat(40000) }, { id: 1 }];
  const alone = pageItems(large, 0, large.length);
  assert.deepEqual(alone.items, [large[0]]);
  assert.equal(alone.page.next, 1);
});

test("bounds name the flag a bad value came from", () => {
  assert.deepEqual(pageBounds(), { start: 0, limit: 20 });
  assert.deepEqual(pageBounds(3, 100), { start: 3, limit: 100 });
  assert.throws(() => pageBounds(-1), /--start/);
  assert.throws(() => pageBounds(Number("x")), /--start/);
  assert.throws(() => pageBounds(0, 0), /--limit/);
  assert.throws(() => pageBounds(0, 101), /--limit/);
});
