import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tableModel } from "../src/ui/components/livePreview.js";
import { Patch } from "../src/ui/panel/Details.js";
import { plainLine } from "../src/ui-server/snapshot.js";
import { inlineDiff, lineDiff, trimSegments } from "../src/ui/util.js";

test("a conflict shows the lines that differ, with a little context", () => {
  const theirs = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
  const mine = ["one", "two", "three", "4", "five", "six", "seven", "eight"].join("\n");
  assert.deepEqual(lineDiff(theirs, mine, 1).split("\n"), [
    "@@ …",
    " three",
    "-four",
    "+4",
    " five",
    "@@ …",
    " seven",
    "+eight",
  ]);
  assert.equal(lineDiff("same", "same"), "@@ …");
});

test("an edited paragraph shows once, with the changed characters and words marked", () => {
  assert.deepEqual(
    inlineDiff("端口随机，启动时生成 token。", "端口按工作区固定，启动时生成 token。"),
    [
      { kind: "same", text: "端口" },
      { kind: "del", text: "随机" },
      { kind: "ins", text: "按工作区固定" },
      { kind: "same", text: "，启动时生成 token。" },
    ],
  );
  // Words change whole rather than letter by letter.
  assert.deepEqual(inlineDiff("run the fast tests", "run the full tests"), [
    { kind: "same", text: "run the " },
    { kind: "del", text: "fast" },
    { kind: "ins", text: "full" },
    { kind: "same", text: " tests" },
  ]);
  // A rewritten line reads better as a removed line and an added one.
  assert.equal(inlineDiff("完全不同的一句话", "another sentence entirely"), null);
});

test("a small edit in a long paragraph keeps only the text next to it", () => {
  const long = "长".repeat(100);
  assert.deepEqual(
    trimSegments(
      [
        { kind: "same", text: long },
        { kind: "ins", text: "新" },
        { kind: "same", text: long },
        { kind: "del", text: "旧" },
        { kind: "same", text: "短" },
      ],
      3,
    ).map((s) => s.text),
    ["…长长长", "新", "长长长 … 长长长", "旧", "短"],
  );
});

test("mixed rewritten and lightly edited lines keep their document order", () => {
  const before = "old heading\nrun the fast tests\nold ending";
  const after = "new title\nrun the full tests\nnew conclusion\nextra line";
  const html = renderToStaticMarkup(createElement(Patch, { patch: lineDiff(before, after) }));
  const rows = [...html.matchAll(/<div class="(del|add|edit)">(.*?)<\/div>/g)].map(
    ([, kind, text]) => [kind, text!.replace(/<[^>]*>/g, "")],
  );
  assert.deepEqual(rows, [
    ["del", "old heading"],
    ["add", "new title"],
    ["edit", "run the fastfull tests"],
    ["del", "old ending"],
    ["add", "new conclusion"],
    ["add", "extra line"],
  ]);
});

test("a Card named by its first line shows that line as plain text", () => {
  assert.equal(
    plainLine("请把分支 `claude/web-ui` 并入，并把 **`tent ui`** 接到[服务](../x.md)上。"),
    "请把分支 claude/web-ui 并入，并把 tent ui 接到服务上。",
  );
  assert.equal(plainLine("## - 补充 *一点* 说明"), "补充 一点 说明");
  assert.equal(plainLine("a*b*c stays"), "a*b*c stays");
});

test("a table's cells keep their place in the source, so a click lands in the right cell", () => {
  const source = "| Name | Size |\n|:-----|-----:|\n| tent | 3 |";
  const { rows, align } = tableModel(source);
  assert.deepEqual(
    rows.map((r) => r.map((c) => c.text)),
    [
      ["Name", "Size"],
      ["tent", "3"],
    ],
  );
  assert.deepEqual(align, ["left", "right"]);
  for (const row of rows)
    for (const cell of row)
      assert.equal(source.slice(cell.offset, cell.offset + cell.text.length), cell.text);
});

test("outer pipes are optional and an escaped pipe stays in its cell", () => {
  const { rows, align } = tableModel("a | b \\| c\n:-:|--\n1 | 2");
  assert.deepEqual(
    rows.map((r) => r.map((c) => c.text)),
    [
      ["a", "b \\| c"],
      ["1", "2"],
    ],
  );
  assert.deepEqual(align, ["center", ""]);
});

test("rows follow the header's width", () => {
  const { rows } = tableModel("|a|b|\n|-|-|\n|1|\n|1|2|3|");
  assert.deepEqual(
    rows.map((r) => r.map((c) => c.text)),
    [
      ["a", "b"],
      ["1", ""],
      ["1", "2"],
    ],
  );
});
