import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, canonicalSha256 } from "../src/core/canonical-digest.js";

test("canonical digest sorts object keys by locale-independent UTF-16 code units", () => {
  const first = { z: 1, Z: 2, ä: 3, a: 4, 中: 5 };
  const second = { 中: 5, a: 4, ä: 3, Z: 2, z: 1 };

  assert.equal(canonicalJson(first), '{"Z":2,"a":4,"z":1,"ä":3,"中":5}');
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalSha256(first), canonicalSha256(second));
});

test("canonical digest applies the same ordering recursively without reordering arrays", () => {
  assert.equal(
    canonicalJson({ outer: { b: 1, A: 2 }, rows: [{ y: 1, X: 2 }, "ä", "a"] }),
    '{"outer":{"A":2,"b":1},"rows":[{"X":2,"y":1},"ä","a"]}',
  );
});
