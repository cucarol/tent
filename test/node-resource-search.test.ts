import { captureFixtureDocuments } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { initializeFixtureHistory, initializeFixtureRepository } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scaffoldInWorkspace } from "./scaffold.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { searchNodes } from "../src/core/read/node-query.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.resolve(testScratchRoot(), "resource-search-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  initializeFixtureRepository(root);
  await scaffoldInWorkspace(openTestFs(root), { name: "resource lookup" });
  const adapter = openTestFs(path.join(root, ".tent"));
  const add = async (name: string, fields: Record<string, unknown>, body = "Unneeded body") => {
    await adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter({ id: `node-${name.toLowerCase()}`, type: "prompt", ...fields }, body),
    );
  };
  const search = (resource: string, uncaptured = false) =>
    searchNodes(adapter, "ws-lookup", root, { resource }, { uncaptured });
  return { root, adapter, add, search };
}

test("resource lookup keeps every matching Node, ordered by the most specific material", async (t) => {
  const { root, add, search } = await fixture(t);
  await add("Broad", { resource: "../../src/" });
  await add("Directory", { sources: [{ resource: "../../src/core/" }] });
  await add("Prefix", { sources: [{ resource: "../../src/core/card*" }] });
  await add("Exact", { resource: "../../src/core/card.ts", sources: [{ resource: "../../src/" }] });
  await add("Tie", { sources: [{ resource: "../../src/core/card.ts" }] });
  await add("Uri", {
    sources: [{ resource: pathToFileURL(path.join(root, "src/core/")).href + "/" }],
  });
  await add("Boundary", { resource: "../../src/core/cards/" });
  await add("Deprecated", { resource: "../../src/", status: "deprecated" });
  await add("Unknown", { resource: "../../src/", status: "future-state" });
  await add("Invalid", { resource: "../../src/", type: "unsupported" });
  const result = await search("../src/core/card.ts");
  assert.deepEqual(
    result.items.map((item) => item.nodeId),
    ["node-exact", "node-tie", "node-prefix", "node-directory", "node-uri", "node-broad"],
  );
  assert.deepEqual(result.items[0]!.match, {
    kind: "exact",
    field: "resource",
    resource: "../../src/core/card.ts",
  });
  assert.deepEqual(result.items[2]!.match, {
    kind: "coverage",
    field: "sources",
    index: 0,
    resource: "../../src/core/card*",
  });
  assert.ok(result.items.every((item) => !("etag" in item) && !("read" in item.match)));
  assert.deepEqual(
    (await search("../src/core-other/card.ts")).items.map((item) => item.nodeId),
    ["node-broad", "node-exact"],
  );
  assert.equal((await search("./Exact/Exact.md")).items.length, 0);
});

test("lookup never reads bodies, captures changes or derives a full-document uncaptured flag", async (t) => {
  const { root, adapter, add, search } = await fixture(t);
  await add(
    "Kept",
    { resource: "../../src/a.ts", description: "Unknown YAML stays in the file" },
    "large body\n".repeat(5000),
  );
  await add("Moved", { resource: "../../src/a.ts" });
  const systemRoot = path.join(root, ".tent");
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  const head = await adapter.history.currentCommit();
  const initial = await search("../src/a.ts", true);
  const kept = await adapter.readFile("Kept/Kept.md");
  await adapter.writeFile("Kept/Kept.md", kept + "body-only edit");
  await fs.rename(path.join(root, ".tent/Moved"), path.join(root, ".tent/Renamed"));
  await fs.rename(
    path.join(root, ".tent/Renamed/Moved.md"),
    path.join(root, ".tent/Renamed/Renamed.md"),
  );
  await add("Newone", { resource: "../../src/a.ts" });
  const read = adapter.readFile.bind(adapter);
  adapter.readFile = async (filename) => {
    if (/\/(?:Kept|Renamed|Newone)\.md$/.test(filename)) throw new Error("Body read during lookup");
    return read(filename);
  };
  const result = await search("../src/a.ts", true);
  assert.deepEqual(
    result.items.map((item) => [item.nodeId, item.uncaptured ?? false]),
    [
      ["node-kept", false],
      ["node-newone", true],
      ["node-moved", true],
    ],
  );
  assert.ok(result.items.every((item) => !("description" in item)));
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await read("Kept/Kept.md"), kept + "body-only edit");
  assert.notEqual(result.revision, initial.revision);
  await adapter.writeFile("Kept/Kept.md", kept + "another body-only edit");
  assert.equal((await search("../src/a.ts", true)).revision, result.revision);
});

test("resource lookup preserves remote exact references and rejects free-text Core requests", async (t) => {
  const { root, adapter, add, search } = await fixture(t);
  await add("Remote", { sources: [{ resource: "https://example.com/proof#part" }] });
  assert.equal((await search("https://example.com/proof#part")).items[0]?.nodeId, "node-remote");
  assert.equal((await search("https://example.com/proof#other")).items.length, 0);
  await assert.rejects(searchNodes(adapter, "ws-lookup", root, { query: "proof" }));
});
