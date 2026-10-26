import assert from "node:assert/strict";
import test from "node:test";
import { lineEdits, unifiedLineDiff } from "../src/core/store/line-diff.js";

test("line diff preserves unchanged context, separate hunks and exact line endings", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
  const after = before.replace("line 2\n", "changed 2\n").replace("line 17\n", "changed 17\n");
  const diff = unifiedLineDiff(before, after, "A/A.md", "A/A.md");
  assert.equal((diff.match(/^@@/gm) ?? []).length, 2);
  assert.equal((diff.match(/^-[^-]/gm) ?? []).length, 2);
  assert.equal((diff.match(/^\+[^+]/gm) ?? []).length, 2);
  assert.ok(!diff.includes("line 10"));
  assert.match(unifiedLineDiff("", "one", "a", "a"), /@@ -0,0 \+1 @@/);
  assert.match(unifiedLineDiff("one\r\nlast", "one\nlast", "a", "a"), /-one\r\n\+one\n/);
  assert.match(unifiedLineDiff("last", "last\n", "a", "a"), /\\ No newline at end of file/);
});

test("shortest line edit scripts reconstruct both inputs and match an independent LCS oracle", () => {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 150; sample++) {
    const a = Array.from({ length: random() % 12 }, () => `${random() % 5}\n`),
      b = Array.from({ length: random() % 12 }, () => `${random() % 5}\n`);
    const edits = lineEdits(a.join(""), b.join(""));
    assert.equal(
      edits
        .filter((e) => e.kind !== "+")
        .map((e) => e.text)
        .join(""),
      a.join(""),
    );
    assert.equal(
      edits
        .filter((e) => e.kind !== "-")
        .map((e) => e.text)
        .join(""),
      b.join(""),
    );
    const lengths = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        lengths[i]![j] =
          a[i - 1] === b[j - 1]
            ? lengths[i - 1]![j - 1]! + 1
            : Math.max(lengths[i - 1]![j]!, lengths[i]![j - 1]!);
    assert.equal(
      edits.filter((e) => e.kind !== " ").length,
      a.length + b.length - 2 * lengths[a.length]![b.length]!,
    );
  }
});
