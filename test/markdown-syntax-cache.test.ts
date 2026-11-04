import { captureFixtureDocuments } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { test, type TestContext } from "node:test";
import { extractOutLinksDetailed, rewriteMarkdownDestinations } from "../src/core/base/links.js";
import { withMarkdownSyntaxCache } from "../src/core/base/markdown-syntax.js";
import { testScratchRoot } from "./scratch.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { findSection, selectSection } from "../src/core/base/markdown-section.js";

const body = [
  "😀 node-abcdef [**node-ghijkl**](<../A/A.md#part> 'title')",
  "[one][r] [two][r] ![image][r] [repeat](x.md) [repeat](x.md)",
  "",
  "[r]: ../B/B.md",
  "[r]: ../C/C.md",
  "",
  "`[code](code.md)` node-ghijkl",
  "![picture](image.md) [fragment](#anchor)",
  "",
  "```md",
  "[fence](ignored.md)",
  "```",
].join("\r\n");

function observe(text: string) {
  return {
    links: extractOutLinksDetailed(text),
    occurrences: extractOutLinksDetailed(text, true),
    rewritten: rewriteMarkdownDestinations(text, (url) =>
      url.startsWith("../") ? url.replace("../", "../new space/") : undefined,
    ),
    ranged: rewriteMarkdownDestinations(text, () => "changed.md", {
      start: 0,
      end: text.indexOf("\r\n"),
    }),
  };
}

test("one exact-body parse serves links, spans and rewrites without sharing output mutations", async () => {
  const expected = observe(body);
  const cold = await withMarkdownSyntaxCache(new Map(), async () => observe(body));
  assert.deepEqual(cold.result, expected);
  assert.equal(cold.used.size, 1);
  const warm = await withMarkdownSyntaxCache(cold.used, async () => {
    const result = observe(body);
    assert.deepEqual(result, expected);
    result.links[0]!.raw = "mutated";
    result.occurrences[0]!.range!.start = -1;
    assert.deepEqual(observe(body), expected);
    assert.equal(
      rewriteMarkdownDestinations(body, () => undefined),
      body,
    );
  });
  assert.equal([...warm.used.values()][0], [...cold.used.values()][0]);
  assert.deepEqual(
    expected.links.map((link) => link.raw),
    ["../A/A.md#part", "../B/B.md", "../B/B.md", "x.md"],
  );
  assert.ok(expected.rewritten.includes("[r]: ../new%20space/B/B.md"));
  assert.ok(expected.rewritten.includes("[r]: ../C/C.md"));
  assert.ok(expected.rewritten.includes("![picture](image.md)"));
});

test("body edits replace only their syntax; current catalog and address context always apply", async () => {
  const neighbor = "[neighbor](../A/A.md)";
  const cold = await withMarkdownSyntaxCache(new Map(), async () => {
    observe(body);
    observe(neighbor);
  });
  const neighborKey = createHash("sha256").update(neighbor).digest("hex");
  const changed = body.replace("x.md", "y.md");
  const expectedChanged = observe(changed);
  const warm = await withMarkdownSyntaxCache(cold.used, async () => {
    assert.deepEqual(observe(changed), expectedChanged);
    observe(neighbor);
  });
  assert.equal(warm.used.get(neighborKey), cold.used.get(neighborKey));
  assert.equal(warm.used.has(createHash("sha256").update(body).digest("hex")), false);
  assert.equal(warm.used.size, 2);
});

test("autolink rewrite failures, reference order and empty destinations match uncached behavior", async () => {
  const corpus = [
    "[x](foo(bar).md) [](foo.md) [x](foo\\).md) [**x**](<a b.md>)",
    "[b][later] [a](a.md) [b][later]\n\n[later]: b.md\n",
    "<https://example.com> [x]()",
    "\\[escaped](no.md)\n\n<div>\n[html](no.md)\n</div>",
  ];
  for (const text of corpus) {
    const direct = extractOutLinksDetailed(text, true);
    const cold = await withMarkdownSyntaxCache(new Map(), async () =>
      extractOutLinksDetailed(text, true),
    );
    const mapped: string[] = [];
    const expectedMapped: string[] = [];
    const run = (seen: string[]) => () =>
      rewriteMarkdownDestinations(text, (url) => {
        seen.push(url);
        return url.startsWith("https:") ? undefined : "new (name).md";
      });
    const expected = run(expectedMapped)();
    await withMarkdownSyntaxCache(cold.used, async () => {
      assert.deepEqual(extractOutLinksDetailed(text, true), direct);
      assert.equal(run(mapped)(), expected);
      assert.deepEqual(mapped, expectedMapped);
      if (text.startsWith("<")) {
        assert.throws(() => rewriteMarkdownDestinations(text, () => "other"), /Cannot locate/);
      }
    });
  }
});

test("cached heading spans preserve literal labels, root scope, nesting, duplicates and CRLF bytes", async () => {
  const text = [
    "# 😀 ![Picture](image.png) **Title**",
    "intro",
    "## Child",
    "child body",
    "> # Quote",
    "",
    "```",
    "# Example",
    "```",
    "",
    "# Next",
    "tail",
  ].join("\r\n");
  const expected = selectSection(text, "😀 Picture Title");
  assert.equal(expected.text, text.slice(0, text.indexOf("# Next")));
  const cold = await withMarkdownSyntaxCache(new Map(), async () => {
    extractOutLinksDetailed(text);
    return selectSection(text, "😀 Picture Title");
  });
  assert.deepEqual(cold.result, expected);
  await withMarkdownSyntaxCache(cold.used, async () => {
    assert.deepEqual(selectSection(text, "😀 Picture Title"), expected);
    assert.equal(findSection(text, "Quote"), undefined);
    assert.equal(findSection(text, "Example"), undefined);
    assert.equal(selectSection(text, "Child").end, text.indexOf("# Next"));
    const duplicate = "# Same\none\n\nSame\n====\ntwo";
    assert.throws(() => selectSection(duplicate, "Same"), /duplicated/);
    assert.throws(() => selectSection(duplicate, "Same"), /duplicated/);
  });
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "markdown-cache-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await fs.mkdir(path.join(root, ".git"));
  return { root, file: path.join(root, ".git", "tent-material-cache", "markdown-syntax.bin") };
}

test("parallel syntax scopes are isolated", async () => {
  const results = await Promise.all(
    ["a.md", "b.md"].map((url) =>
      withMarkdownSyntaxCache(new Map(), async () => {
        await Promise.resolve();
        return extractOutLinksDetailed(`[link](${url})`);
      }),
    ),
  );
  assert.equal(results[0]!.result[0]!.raw, "a.md");
  assert.equal(results[1]!.result[0]!.raw, "b.md");
  assert.equal(results[0]!.used.size, 1);
  assert.equal(results[1]!.used.size, 1);
});

test("CLI check installs syntax reuse around the outer document read scope", async (t) => {
  const { root } = await fixture(t);
  await scaffoldInWorkspace(root, {
    name: "Syntax",
    nodes: [
      { id: "node-abcdef", name: "Fact", type: "prompt", body: "[ref](https://example.com)" },
    ],
  });
  const system = path.join(root, ".tent");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(system, "Fact", "Fact.md"),
    serializeFrontmatter(
      { id: "node-abcdef", type: "goal", resource: "../../src/" },
      "[ref](https://example.com)\n",
    ),
  );
  await initializeFixtureHistory(system);
  await captureFixtureDocuments(system);
  const file = path.join(system, ".git", "tent-material-cache", "markdown-syntax.bin");
  const check = async () => {
    const result = await runWorkspaceCommand("check", ["--json"], { workspace: root });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  };
  const first = await check();
  const bytes = await fs.readFile(file);
  assert.ok(deserialize(bytes).entries.size > 0);
  const head = await historyHead(system);
  const stat = await fs.stat(file);
  assert.equal(await check(), first);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.equal(await historyHead(system), head);
  await fs.rm(file);
  assert.equal(await check(), first);
  assert.equal(await historyHead(system), head);
});
