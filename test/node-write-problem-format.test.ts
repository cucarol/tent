import assert from "node:assert/strict";
import test from "node:test";
import {
  formatNodeWriteProblems,
  type NodeWriteProblem,
} from "../src/core/check/node-write-problems.js";

const problem = (reason: string, path = ".tent/Node/Node.md"): NodeWriteProblem => ({
  category: "error",
  path,
  reason,
});
const group = (path: string, details: string[], omitted = 0) =>
  `Tent: ${path} has problems:\n${details.map((detail) => `- ${detail}`).join("\n")}${omitted ? `\n${omitted} more problems: tent workspace check --json` : ""}\nFix them before you end this turn.`;

test("problem formatter keeps unlimited output and complete structured diagnostics", () => {
  const problems: NodeWriteProblem[] = [
    problem("First"),
    {
      category: "issue",
      kind: "unresolved-link",
      path: ".tent/Other/Other.md",
      target: "node-missing",
      reason: "Missing target",
    },
    {
      category: "notice",
      path: ".tent/Other/Other.md",
      field: "resource",
      resource: "./file.txt",
      reason: "Check material",
    },
  ];
  const original = structuredClone(problems);
  const expected =
    group(".tent/Node/Node.md", ["First"]) +
    "\n\n" +
    group(".tent/Other/Other.md", [
      "unresolved-link: node-missing — Missing target",
      "./file.txt — Check material",
    ]);
  assert.equal(formatNodeWriteProblems(problems), expected);
  assert.equal(formatNodeWriteProblems(problems, Buffer.byteLength(expected)), expected);
  assert.deepEqual(problems, original);
  assert.equal(formatNodeWriteProblems([], 0), "");
});

test("problem budget keeps complete problems across Nodes and counts the rest before the final instruction", () => {
  const problems = [
    problem("First", ".tent/A/A.md"),
    problem("Second", ".tent/B/B.md"),
    problem("Last", ".tent/C/C.md"),
  ];
  const expected = group(".tent/A/A.md", ["First"]) + "\n\n" + group(".tent/B/B.md", ["Second"], 1);
  const limit = Buffer.byteLength(expected);
  assert.ok(Buffer.byteLength(formatNodeWriteProblems(problems)) > limit);
  assert.equal(formatNodeWriteProblems(problems, limit), expected);
  assert.ok(!expected.includes(".tent/C/"));
});

test("a later problem that does not fit stays whole and all following problems are counted", () => {
  const problems = [
    problem("First"),
    problem("Very long ".repeat(1000)),
    ...Array.from({ length: 98 }, (_, index) => problem(`Later ${index}`)),
  ];
  const expected = group(".tent/Node/Node.md", ["First"], 99);
  assert.equal(formatNodeWriteProblems(problems, Buffer.byteLength(expected)), expected);
  assert.ok(!expected.includes("…"));
});

test("an oversized first problem truncates at Unicode code points with an ellipsis and counts later problems", () => {
  const problems = [problem("A😀你".repeat(1000)), problem("Later", ".tent/Other/Other.md")];
  const expected = group(".tent/Node/Node.md", ["A😀你A😀你A…"], 1);
  const limit = Buffer.byteLength(expected);
  const output = formatNodeWriteProblems(problems, limit);
  assert.equal(output, expected);
  assert.equal(Buffer.byteLength(output), limit);
  assert.doesNotMatch(
    output,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
  assert.equal(formatNodeWriteProblems(problems, 1), "");
  const single = [problem("你".repeat(1000))];
  const oneExpected = group(".tent/Node/Node.md", ["你你…"]);
  assert.equal(formatNodeWriteProblems(single, Buffer.byteLength(oneExpected)), oneExpected);
});

test("problem text budgets preserve quotes, backslashes and control characters for host serialization", () => {
  const reason = '"quoted"\\path\nline\t\u0001 😀';
  const problems = [problem(reason), problem("Second ".repeat(100))];
  const expected = group(".tent/Node/Node.md", [reason], 1);
  const output = formatNodeWriteProblems(problems, Buffer.byteLength(expected));
  assert.equal(output, expected);
  assert.equal(JSON.parse(JSON.stringify({ text: output })).text, expected);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: output })) > Buffer.byteLength(output));
});

test("actual JSON byte measurement keeps fitting escaped problems whole and cuts an oversized first problem within 8 KiB", () => {
  const measureBytes = (text: string) =>
    Buffer.byteLength(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
      }),
    );
  const first = '"\\\n'.repeat(900);
  const second = "你".repeat(400);
  const problems = [problem(first), problem(second), problem("Too long".repeat(2000))];
  const expected = group(".tent/Node/Node.md", [first, second], 1);
  assert.ok(measureBytes(expected) <= 8192);
  assert.equal(formatNodeWriteProblems(problems, 8192, measureBytes), expected);
  assert.ok(!expected.includes("…"));
  const oversized = formatNodeWriteProblems(
    [problem('"\\\n😀'.repeat(4000)), problem("Later problem")],
    8192,
    measureBytes,
  );
  assert.ok(measureBytes(oversized) <= 8192);
  assert.match(
    oversized,
    /…\n1 more problems: tent workspace check --json\nFix them before you end this turn\.$/,
  );
  assert.doesNotMatch(oversized, /Later problem/);
  assert.doesNotMatch(
    oversized,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
});
