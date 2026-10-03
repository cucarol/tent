import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  materialFields,
  materialLocator,
  materialOccurrences,
  localMaterialPath,
  rewriteMaterialPaths,
} from "../src/core/material.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { createNode, moveNode, renameNode } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { liveContextReader } from "../src/core/context-reader-factory.js";
import { ContextReader } from "../src/core/context-reader.js";
import { contentEtag } from "../src/core/etag.js";

test("standard sources preserve duplicates, spelling, order and unknown values", () => {
  const sources = [
    {
      resource: "./参考.md",
      title: "first",
      custom: { rank: [3, 1] },
      ["__proto__"]: { preserve: true },
    },
    { resource: "访谈结论", id: "scope" },
    { resource: "./参考.md", title: "second" },
  ];
  const raw = serializeFrontmatter({ resource: "./src/main.ts", sources, unrelated: true }, "body");
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(materialFields(parsed.data), { resource: "./src/main.ts", sources });
  assert.deepEqual(
    materialOccurrences(parsed.data).map((o) => [o.field, o.index, o.resource]),
    [
      ["resource", undefined, "./src/main.ts"],
      ["sources", 0, "./参考.md"],
      ["sources", 1, "访谈结论"],
      ["sources", 2, "./参考.md"],
    ],
  );
  assert.equal(serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder), raw);
  for (const data of [
    { resource: 1 },
    { resource: " " },
    { sources: {} },
    { sources: [{ title: "missing resource" }] },
  ]) {
    assert.throws(() => materialFields(data));
  }
});

test("material locations use the declaring document and single Workspace", () => {
  const root = path.resolve(".scratch", "material-resolve");
  const cases = [
    ["../other.md", "A/other.md"],
    ["file.txt", "A/B/file.txt"],
    ["/attachments/file.bin", "attachments/file.bin"],
    ["../../../src/main.ts", "../src/main.ts"],
    ["../../../.tent/A/A.md", "A/A.md"],
  ];
  for (const [resource, target] of cases) {
    const locator = materialLocator(resource!, "A/B/B.md");
    assert.equal(locator.kind, "path");
    assert.equal(localMaterialPath(locator, root), path.resolve(root, ".tent", target!));
  }
  const external = pathToFileURL(path.resolve(root, "..", "external file.bin")).href;
  assert.equal(
    localMaterialPath(materialLocator(external, "A/B/B.md", true), root),
    fileURLToPath(external),
  );
  assert.equal(
    localMaterialPath(materialLocator("https://example.com/a", "A/A.md", true), root),
    undefined,
  );
  for (const description of [
    "访谈结论",
    "all queries in project X",
    "report.md",
    "references/report.md",
  ]) {
    assert.deepEqual(materialLocator(description, "A/A.md", true), {
      kind: "unresolved",
      text: description,
    });
  }
  assert.equal(materialLocator("./访谈结论", "A/A.md", true).kind, "path");
  for (const invalid of [
    "/../../outside",
    "../../../outside",
    "/%2e%2e/outside",
    "./%00name",
    "./bad%zz",
    "C:/outside",
    "/C:/outside",
    "/%43%3a/outside",
    "/%2fC:/outside",
    "/%2f%2fserver/share",
    "\\\\server\\share",
  ]) {
    assert.throws(() => materialLocator(invalid, "A/A.md"), invalid);
  }
});

test("rewrite handles identity files, attachments, unmoved workspace files and URI suffixes", () => {
  const moves = new Map([
    ["A", "Group/New"],
    ["A/A.md", "Group/New/New.md"],
  ]);
  const data = {
    resource: "./image%20one.bin#page=2",
    sources: [
      { resource: "./A.md" },
      { resource: "../../src/main.ts?raw=1" },
      { resource: "/A/A.md#details" },
      { resource: "A/A.md", title: "Unresolved scope" },
      { resource: "file:///outside/A.md" },
      { resource: "https://example.com/A/A.md" },
    ],
  };
  assert.equal(rewriteMaterialPaths(data, "A/A.md", "Group/New/New.md", moves), true);
  assert.equal(data.resource, "./image%20one.bin#page=2");
  assert.deepEqual(
    data.sources.map((source) => source.resource),
    [
      "./New.md",
      "../../../src/main.ts?raw=1",
      "/Group/New/New.md#details",
      "A/A.md",
      "file:///outside/A.md",
      "https://example.com/A/A.md",
    ],
  );
  const unchanged = serializeFrontmatter(data, "");
  assert.equal(
    rewriteMaterialPaths(data, "Group/New/New.md", "Group/New/New.md", new Map()),
    false,
  );
  assert.equal(serializeFrontmatter(data, ""), unchanged);
  const coMoved = { sources: [{ resource: "./%61.txt" }] };
  assert.equal(rewriteMaterialPaths(coMoved, "A/A.md", "Group/New/New.md", moves), false);
  assert.equal(coMoved.sources[0]!.resource, "./%61.txt");
  const encoded = { resource: "/A/A.md" };
  rewriteMaterialPaths(
    encoded,
    "Other/Other.md",
    "Other/Other.md",
    new Map([["A/A.md", "A/Has#Hash.md"]]),
  );
  assert.equal(encoded.resource, "/A/Has%23Hash.md");
  const alias = { sources: [{ resource: "../../.tent/A/A.md" }] };
  rewriteMaterialPaths(alias, "Other/Other.md", "Other/Other.md", moves);
  assert.equal(alias.sources[0]!.resource, "../Group/New/New.md");
});

test("real Node move and rename preserve resource targets, ordered sources and historical bytes", async () => {
  const scratch = fileURLToPath(new URL("../.scratch/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "material-move-"));
  const adapter = new NodeFs(path.join(fixture, ".tent"));
  let n = 0;
  const env = {
    fs: adapter,
    tentName: "test",
    clock: { now: () => "2026-09-28T00:00:00Z" },
    rand: () => ++n / 100,
  };
  try {
    await scaffoldTent(adapter, { name: "test" });
    const sourceId = await createNode(env, { parentPath: "", name: "A", type: "prompt" });
    const parentId = await createNode(env, { parentPath: "", name: "Group", type: "goal" });
    const observerId = await createNode(env, { parentPath: "", name: "Observer", type: "prompt" });
    const sources = [
      { resource: "../../src/main.ts", custom: { preserve: [1, 2] } },
      { resource: "访谈结论" },
      { resource: "../../src/main.ts", title: "another use" },
    ];
    const initial = serializeFrontmatter(
      { id: sourceId, type: "prompt", resource: "./image.bin", sources },
      "[Self](./A.md)\n",
    );
    await adapter.writeFile("A/A.md", initial);
    await adapter.writeBinary("A/image.bin", Buffer.from([0, 255, 8]));
    await adapter.writeFile(
      "Observer/Observer.md",
      serializeFrontmatter(
        {
          id: observerId,
          type: "prompt",
          resource: "/A/A.md",
          sources: [{ resource: "/A/image.bin" }],
        },
        "[A](/A/A.md)",
      ),
    );
    for (const directory of ["roles", "notes"]) {
      await adapter.mkdir(directory);
      await adapter.writeFile(
        `${directory}/reader.md`,
        serializeFrontmatter(
          { type: "context", sources: [{ resource: "/A/A.md", extra: true }] },
          "",
        ),
      );
    }
    await adapter.mkdir("cards");
    const cardRaw = serializeFrontmatter({ type: "card", resource: "/A/A.md" }, "historical input");
    await adapter.writeFile("cards/card-history.md", cardRaw);
    const before = await liveContextReader(adapter, { kind: "live", workspaceId: "ws-test" });
    const first = before.read({ nodeId: sourceId, view: "body" });
    assert.ok("text" in first);
    assert.deepEqual(first.sources, sources);
    assert.equal(first.resource, "./image.bin");
    assert.equal(before.search({ query: "main" }).items[0]?.match.field, "sources");
    assert.equal(before.search({ query: "访谈结论" }).items[0]?.match.field, "sources");
    assert.equal(before.search({ query: "image" }).items[0]?.match.field, "resource");
    await moveNode(env, sourceId, parentId, { mode: "inside" });
    await renameNode(env, sourceId, "New");
    const raw = await adapter.readFile("Group/New/New.md");
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.data.resource, "./image.bin");
    assert.deepEqual(
      parsed.data.sources,
      sources.map((source) =>
        source.resource.startsWith("../")
          ? { ...source, resource: "../../../src/main.ts" }
          : source,
      ),
    );
    assert.equal(parsed.body, "[Self](./New.md)\n");
    assert.deepEqual(
      Buffer.from(await adapter.readBinary("Group/New/image.bin")),
      Buffer.from([0, 255, 8]),
    );
    const observer = parseFrontmatter(await adapter.readFile("Observer/Observer.md"));
    assert.equal(observer.data.resource, "/Group/New/New.md");
    assert.deepEqual(observer.data.sources, [{ resource: "/Group/New/image.bin" }]);
    assert.deepEqual(parseFrontmatter(await adapter.readFile("roles/reader.md")).data.sources, [
      { resource: "/Group/New/New.md", extra: true },
    ]);
    // A plain Markdown file in a grouping directory is not a Node or Role.
    assert.deepEqual(parseFrontmatter(await adapter.readFile("notes/reader.md")).data.sources, [
      { resource: "/A/A.md", extra: true },
    ]);
    assert.equal(await adapter.readFile("cards/card-history.md"), cardRaw);
    assert.equal((await loadTent(adapter)).byId.get(sourceId)?.invalid, false);

    // A bare relative source could be a path or a scope. An affected ambiguity
    // stops before any move or descriptor write; the Agent can clarify a path.
    const child = await createNode(env, { parentPath: "Group/New", name: "Child", type: "prompt" });
    const owner = parseFrontmatter(raw);
    owner.data.sources = [{ resource: "Child/Child.md", custom: "keep" }];
    const ambiguousRaw = serializeFrontmatter(owner.data, owner.body, owner.keyOrder);
    await adapter.writeFile("Group/New/New.md", ambiguousRaw);
    await assert.rejects(
      renameNode(env, child, "Changed"),
      /Unresolved source.*Group\/New\/New.md sources\[0\]/,
    );
    assert.equal(await adapter.readFile("Group/New/New.md"), ambiguousRaw);
    assert.equal(await adapter.exists("Group/New/Child/Child.md"), true);
    assert.equal(await adapter.exists("Group/New/Changed"), false);
    owner.data.sources = [{ resource: "./Child/Child.md", custom: "keep" }];
    await adapter.writeFile(
      "Group/New/New.md",
      serializeFrontmatter(owner.data, owner.body, owner.keyOrder),
    );
    await renameNode(env, child, "Changed");
    assert.deepEqual(parseFrontmatter(await adapter.readFile("Group/New/New.md")).data.sources, [
      { resource: "./Changed/Changed.md", custom: "keep" },
    ]);
  } finally {
    const relative = path.relative(scratch, fixture);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("unresolved source preflight uses only possible path changes and leaves safe spellings alone", () => {
  const sameSubtree = {
    sources: [
      { resource: "references/missing.md" },
      { resource: "sales scope" },
      { resource: "75% of interviews" },
    ],
  };
  assert.equal(
    rewriteMaterialPaths(
      sameSubtree,
      "A/A.md",
      "Group/A/A.md",
      new Map([
        ["A", "Group/A"],
        ["A/A.md", "Group/A/A.md"],
      ]),
    ),
    false,
  );
  const unchanged = structuredClone(sameSubtree);
  assert.throws(
    () => rewriteMaterialPaths(sameSubtree, "A/A.md", "B/B.md", new Map()),
    /Unresolved source/,
  );
  assert.deepEqual(sameSubtree, unchanged);
  assert.equal(
    rewriteMaterialPaths(
      { sources: [{ resource: "Childish/file.md" }] },
      "A/A.md",
      "A/A.md",
      new Map([["A/Child", "A/NewChild"]]),
    ),
    false,
  );
});

test("Core reads disclose complete standard metadata and exact raw bytes", () => {
  for (const sources of [
    [{ resource: "./a", extra: "x".repeat(40000) }],
    [{ resource: "https://example.com/legacy", details: { count: 3 } }],
  ]) {
    const raw = serializeFrontmatter({ id: "node-fields", type: "prompt", sources }, "body");
    const reader = new ContextReader(
      { kind: "git", workspaceId: "ws-test", version: { commit: "a".repeat(40), path: "A/A.md" } },
      [
        {
          nodeId: "node-fields",
          path: "A",
          name: "A",
          type: "prompt",
          raw,
          etag: contentEtag(raw),
          archived: false,
          invalid: false,
          parentNodeId: null,
          childNodeIds: [],
        },
      ],
      ["node-fields"],
    );
    const body = reader.read({ nodeId: "node-fields", view: "body" });
    assert.ok("text" in body);
    assert.deepEqual(body.sources, sources);
    const full = reader.read({ nodeId: "node-fields", view: "raw" });
    assert.ok("text" in full);
    assert.equal(full.text, raw);
  }
});

test("source descriptions are not treated as URI references", () => {
  assert.deepEqual(materialLocator("note: reference", "A/A.md", true), {
    kind: "unresolved",
    text: "note: reference",
  });
  assert.equal(materialLocator("urn:example:1", "A/A.md", true).kind, "uri");
});
