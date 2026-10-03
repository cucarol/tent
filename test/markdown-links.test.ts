import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractOutLinksDetailed,
  normalizeTarget,
  resolveOutLink,
  rewriteMarkdownDestinations,
} from "../src/markdown/links.js";
import { buildOkfNodeIndex, resolveNode } from "../src/core/okf-index.js";

test("Markdown parser handles links, reference definitions, escapes and exact source spans", () => {
  const body =
    '[**Alpha**](<../Alpha/Alpha.md#heading> "title") [B][ref] [C][] [D]\n\n[ref]: ./foo(bar).md\n[C]: ./baz\\).md\n[D]: ./a%20b.md';
  const links = extractOutLinksDetailed(body, true);
  assert.deepEqual(
    links.map((l) => l.raw),
    ["../Alpha/Alpha.md#heading", "./foo(bar).md", "./baz).md", "./a%20b.md"],
  );
  assert.equal(links[0]!.label, "Alpha");
  assert.equal(links[0]!.fragment, "heading");
  for (const link of links)
    assert.ok(body.slice(link.range!.start, link.range!.end).startsWith("["));
  assert.deepEqual(
    extractOutLinksDetailed("[a](x.md) [a](x.md)").map((l) => l.raw),
    ["x.md"],
  );
  assert.equal(extractOutLinksDetailed("[a](x.md) [a](x.md)", true).length, 2);
});

test("code, HTML, images, escapes, wiki prose and attachment links are not Node edges", () => {
  const body = [
    "[yes](./real.md)",
    "[[Old]] ![[Embed]]",
    "\\[escaped](./no.md)",
    "Inline `[code](./code.md)`",
    "",
    "```md",
    "[code](./fenced.md)",
    "```",
    "",
    "    [code](./indented.md)",
    "",
    "<div>",
    "[html](./html.md)",
    "</div>",
    "",
    "![image](./image.md) [only](#anchor) [attachment](../attachments/a.png)",
  ].join("\n");
  assert.deepEqual(
    extractOutLinksDetailed(body).map((l) => l.raw),
    ["./real.md"],
  );
});

test("external references remain artifacts", () => {
  const links = extractOutLinksDetailed(
    "[a](https://example.com) [b](mailto:a@b.c) [c](ftp://h/x)",
  );
  assert.equal(links.length, 3);
  assert.ok(links.every((l) => l.kind === "artifact"));
});

test("Node identity resolution is exact and duplicate names stay ambiguous", () => {
  const nodes = [
    {
      id: "A/Alpha",
      nodeId: "node-alpha",
      path: "A/Alpha",
      notePath: "A/Alpha/Alpha.md",
      name: "Alpha Policy",
    },
    {
      id: "B/Alpha",
      nodeId: "node-other",
      path: "B/Alpha",
      notePath: "B/Alpha/Alpha.md",
      name: "Alpha Policy",
    },
  ];
  const index = buildOkfNodeIndex(nodes);
  assert.equal(resolveNode(index, "node-alpha")?.nodeId, "node-alpha");
  assert.equal(resolveNode(index, "A/Alpha/Alpha.md")?.nodeId, "node-alpha");
  for (const name of ["Alpha", "alpha policy", "AlphaPolicy", "Alpha Policy"])
    assert.equal(resolveNode(index, name), undefined);
  assert.equal(
    resolveOutLink(index, { raw: "../A/Alpha/Alpha.md", kind: "md" }, "Hub/Hub.md").targetNodeId,
    "node-alpha",
  );
  assert.equal(
    resolveOutLink(index, { raw: "./Missing.md", kind: "md" }, "Hub/Hub.md").kind,
    "unresolved",
  );
});

test("links leaving .tent keep their workspace path namespace", () => {
  const index = buildOkfNodeIndex([
    {
      id: "Alpha/Alpha",
      nodeId: "node-alpha",
      path: "Alpha",
      notePath: "Alpha/Alpha.md",
      name: "Alpha",
    },
  ]);
  for (const [url, source] of [
    ["../../Alpha/Alpha.md", "Beta/Beta.md"],
    ["../Alpha/Alpha.md", "Root.md"],
    ["../../Alpha/A%20B%23C.md#heading", "Beta/Beta.md"],
  ] as const) {
    assert.equal(resolveOutLink(index, { raw: url, kind: "md" }, source).kind, "unresolved");
  }
  assert.equal(normalizeTarget("../../Alpha/Alpha.md", "Beta/Beta.md"), "../Alpha/Alpha");
  assert.equal(normalizeTarget("../Alpha/Alpha.md", "Root.md"), "../Alpha/Alpha");
  assert.equal(
    normalizeTarget("../../Alpha/A%20B%23C.md#heading", "Beta/Beta.md"),
    "../Alpha/A B#C",
  );
  assert.equal(
    resolveOutLink(index, { raw: "../../.tent/Alpha/Alpha.md", kind: "md" }, "Beta/Beta.md")
      .targetNodeId,
    "node-alpha",
  );
});

test("destination edits preserve labels, titles, references and untouched examples", () => {
  const body = [
    '[label [nested]](../Alpha/Alpha.md "do not ]( change")',
    '[angle](<../Alpha/Alpha.md#part> "title")',
    "[one][ref] [two][ref]",
    "",
    "[ref]:",
    "  ../Alpha/Alpha.md",
    "  'next line title'",
    "",
    "`[inline](../Alpha/Alpha.md)`",
    "",
    "```md",
    "[fence](../Alpha/Alpha.md)",
    "```",
    "",
    "    [indent](../Alpha/Alpha.md)",
    "",
    "<div>",
    "[html](../Alpha/Alpha.md)",
    "</div>",
    "",
    "[[Alpha]] ![image](../Alpha/Alpha.md)",
  ].join("\r\n");
  const edited = rewriteMarkdownDestinations(body, (url) =>
    url.startsWith("../Alpha/") ? url.replaceAll("Alpha", "Gamma") : undefined,
  );
  assert.equal(
    edited,
    body
      .replace("[label [nested]](../Alpha/Alpha.md", "[label [nested]](../Gamma/Gamma.md")
      .replace("<../Alpha/Alpha.md#part>", "<../Gamma/Gamma.md#part>")
      .replace("  ../Alpha/Alpha.md", "  ../Gamma/Gamma.md"),
  );
  assert.equal(
    rewriteMarkdownDestinations(edited, () => undefined),
    edited,
  );
});

test("destination spans handle balanced parentheses, escapes, empty labels and encoded names", () => {
  for (const source of [
    "[x](foo(bar).md)",
    "[x](foo\\).md)",
    "[](foo.md)",
    "[x](<foo bar.md>)",
    "[**x**](foo.md)",
  ]) {
    const edited = rewriteMarkdownDestinations(source, () => "../new name/new(name).md#section");
    assert.equal(
      extractOutLinksDetailed(edited)[0]?.raw,
      source.includes("<")
        ? "../new name/new(name).md#section"
        : "../new%20name/new(name).md#section",
    );
  }
  assert.equal(
    normalizeTarget("../sibling/sibling.md#part", "parent/child/child.md"),
    "parent/sibling/sibling",
  );
  assert.equal(normalizeTarget("./a%20b.md", "p/p.md"), "p/a b");
  assert.equal(normalizeTarget("./a%23b.md#section", "p/p.md"), "p/a#b");
});
