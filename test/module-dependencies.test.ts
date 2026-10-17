import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readModuleDependencies } from "../src/core/graph/module-dependencies.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";
import type { RepositorySource } from "../src/core/base/repository-imports.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "module-dependencies-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const adapter = new NodeFs(path.join(root, ".tent"));
  await adapter.mkdir("");
  const node = (name: string, prefixes: string[], extra: Record<string, unknown> = {}) =>
    adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter(
        {
          id: `node-${name}`,
          type: "prompt",
          sources: prefixes.map((prefix) => ({ resource: `../../${prefix}`, track: "structure" })),
          ...extra,
        },
        "Rules.",
      ),
    );
  const read = (sources: RepositorySource[]) =>
    readModuleDependencies(adapter, root, {
      basis: { head: "a".repeat(40), dirty: true },
      sources,
    });
  return { node, read };
}

test("module dependencies aggregate imports in both directions without self edges", async (t) => {
  const { node, read } = await fixture(t);
  await node("a", ["src/a/"]);
  await node("b", ["src/b/"]);
  const sources = [
    { path: "src/a/one.ts", content: 'import "../b/one.js"; import "../b/two.js";' },
    { path: "src/a/two.ts", content: 'import "./one.js"; import "../b/one.js";' },
    { path: "src/b/one.ts", content: 'import "../a/one.js";' },
    { path: "src/b/two.ts", content: "export const n = 1;" },
    { path: "src/a/one.test.ts", content: 'import "../missing.js";' },
  ];
  const result = await read(sources);
  assert.deepEqual(result, {
    basis: { head: "a".repeat(40), dirty: true },
    modules: [
      { nodeId: "node-a", files: 3 },
      { nodeId: "node-b", files: 2 },
    ],
    edges: [
      { from: "node-a", to: "node-b", imports: 3 },
      { from: "node-b", to: "node-a", imports: 1 },
    ],
    cycles: [["node-a", "node-b"]],
    uncovered: 0,
    unresolved: 0,
  });
  assert.deepEqual(await read([...sources].reverse()), result);
});

test("most-specific membership preserves equal ties and counts each file once per module", async (t) => {
  const { node, read } = await fixture(t);
  await node("parent", ["src/"]);
  await node("a", ["src/a/", "src/a/"]);
  await node("shared", ["src/a/"]);
  await node("b", ["src/b-*"]);
  await node("retired", ["src/a/"], { status: "deprecated" });
  await node("invalid", ["src/a/"], { id: "not-a-node" });
  await node("unknown", ["src/a/"], { status: "mystery" });
  await node("content", [], { resource: "../../src/a/", tags: ["spec"] });
  const result = await read([
    { path: "src/a/x.ts", content: 'import "../b-one.js";' },
    { path: "src/b-one.ts", content: 'import "./a/x.js";' },
    { path: "src/b-two.ts", content: "" },
    { path: "src/other.txt" },
  ]);
  assert.deepEqual(result.cycles, [["node-a", "node-b", "node-shared"]]);
  assert.deepEqual(result.modules, [
    { nodeId: "node-a", files: 1 },
    { nodeId: "node-b", files: 2 },
    { nodeId: "node-parent", files: 1 },
    { nodeId: "node-shared", files: 1 },
  ]);
  assert.deepEqual(result.edges, [
    { from: "node-a", to: "node-b", imports: 1 },
    { from: "node-b", to: "node-a", imports: 1 },
    { from: "node-b", to: "node-shared", imports: 1 },
    { from: "node-shared", to: "node-b", imports: 1 },
  ]);
});

test("uncovered counts unique participating files, unresolved counts local import issues", async (t) => {
  const { node, read } = await fixture(t);
  await node("a", ["src/a/"]);
  const result = await read([
    { path: "src/a/x.ts", content: 'import "../outside.js"; import "../missing.js";' },
    {
      path: "src/outside.ts",
      content: 'import "./a/x.js"; import "./missing.js"; import "external-package";',
    },
    { path: "src/unused.ts", content: "" },
  ]);
  assert.deepEqual(result.cycles, []);
  assert.deepEqual(result.edges, []);
  assert.equal(result.uncovered, 1);
  assert.equal(result.unresolved, 2);
});

test("no modules is an empty graph, and current declarations are reread", async (t) => {
  const { node, read } = await fixture(t);
  const sources = [
    { path: "a.ts", content: 'import "./b.js";' },
    { path: "b.ts", content: "" },
  ];
  assert.deepEqual((await read(sources)).modules, []);
  assert.equal((await read(sources)).uncovered, 2);
  await node("all", ["./"]);
  assert.deepEqual((await read(sources)).modules, [{ nodeId: "node-all", files: 2 }]);
  await node("all", [], { status: "deprecated" });
  assert.deepEqual((await read(sources)).modules, []);
});

test("Go packages count one import per target module without inventing file imports", async (t) => {
  const { node, read } = await fixture(t);
  await node("a", ["a/"]);
  await node("b", ["b/"]);
  const result = await read([
    { path: "go.mod", content: "module example.test/app" },
    { path: "a/main.go", content: 'package a\nimport "example.test/app/b"' },
    { path: "b/one.go", content: "package b" },
    { path: "b/two.go", content: "package b" },
    { path: "b/three_test.go", content: 'package b\nimport "example.test/app/a"' },
  ]);
  assert.deepEqual(result.edges, [{ from: "node-a", to: "node-b", imports: 1 }]);
  assert.equal(result.uncovered, 0);
});

test("Go package ownership requires complete coverage and distinguishes partial from uncovered", async (t) => {
  const { node, read } = await fixture(t);
  await node("a", ["a/"]);
  const sources = [
    { path: "go.mod", content: "module example.test/app" },
    { path: "a/main.go", content: 'package a\nimport "example.test/app/b"' },
    { path: "b/one.go", content: "package b" },
    { path: "b/two.go", content: "package b" },
  ];
  const uncovered = await read(sources);
  assert.deepEqual(uncovered.edges, []);
  assert.equal(uncovered.uncovered, 2);
  assert.equal(uncovered.unresolved, 0);
  await node("one", ["b/one*"]);
  const partial = await read(sources);
  assert.deepEqual(partial.edges, []);
  assert.equal(partial.uncovered, 1);
  assert.equal(partial.unresolved, 1);
  await node("two", ["b/two*"]);
  const split = await read(sources);
  assert.deepEqual(split.edges, []);
  assert.equal(split.uncovered, 0);
  assert.equal(split.unresolved, 1);
  await node("one", ["b/one*", "b/two*"]);
  await node("two", ["b/one*", "b/two*"]);
  const shared = await read(sources);
  assert.deepEqual(shared.edges, [
    { from: "node-a", to: "node-one", imports: 1 },
    { from: "node-a", to: "node-two", imports: 1 },
  ]);
  assert.equal(shared.unresolved, 0);
});

test("split Go packages retain directory import owners while files belong to finer modules", async (t) => {
  const { node, read } = await fixture(t);
  await node("root", ["./"]);
  await node("a", ["a/"]);
  await node("package", ["b/"], { type: "goal" });
  await node("one", ["b/one*"]);
  await node("two", ["b/two*"]);
  const sources = [
    { path: "go.mod", content: "module example.test/app" },
    { path: "a/main.go", content: 'package a\nimport "example.test/app/b"' },
    { path: "b/one.go", content: "package b" },
    { path: "b/two.go", content: "package b" },
  ];
  const result = await read(sources);
  assert.deepEqual(result.edges, [{ from: "node-a", to: "node-package", imports: 1 }]);
  assert.deepEqual(result.modules, [
    { nodeId: "node-a", files: 1 },
    { nodeId: "node-one", files: 1 },
    { nodeId: "node-package", files: 0 },
    { nodeId: "node-root", files: 1 },
    { nodeId: "node-two", files: 1 },
  ]);
  assert.equal(result.unresolved, 0);
  assert.equal(result.uncovered, 0);
  assert.deepEqual(await read([...sources].reverse()), result);

  await node("shared", ["b/", "b/"]);
  assert.deepEqual((await read(sources)).edges, [
    { from: "node-a", to: "node-package", imports: 1 },
    { from: "node-a", to: "node-shared", imports: 1 },
  ]);
  await node("package", ["b/"], { status: "deprecated" });
  await node("shared", ["b/"], { status: "deprecated" });
  const fallback = await read(sources);
  assert.deepEqual(fallback.edges, [{ from: "node-a", to: "node-root", imports: 1 }]);
  assert.equal(fallback.unresolved, 0);
});

test("Go imports to the root package preserve its directory owner after prefix splitting", async (t) => {
  const { node, read } = await fixture(t);
  await node("root", ["./"]);
  await node("command", ["command*"]);
  await node("flags", ["flags*"]);
  await node("cli", ["cmd/"]);
  const result = await read([
    { path: "go.mod", content: "module example.test/app" },
    { path: "command.go", content: "package app" },
    { path: "flags.go", content: "package app" },
    { path: "cmd/main.go", content: 'package main\nimport "example.test/app"' },
  ]);
  assert.deepEqual(result.edges, [{ from: "node-cli", to: "node-root", imports: 1 }]);
  assert.equal(result.unresolved, 0);
  assert.equal(result.uncovered, 0);
});

test("package directory ownership ignores ordinary materials and sibling path prefixes", async (t) => {
  const { node, read } = await fixture(t);
  await node("a", ["a/"]);
  await node("sibling", ["b-other/"]);
  await node("ordinary", [], { resource: "../../b/" });
  await node("one", ["b/one*"]);
  await node("two", ["b/two*"]);
  const sources = [
    { path: "go.mod", content: "module example.test/app" },
    { path: "a/main.go", content: 'package a\nimport "example.test/app/b"' },
    { path: "b/one.go", content: "package b" },
    { path: "b/two.go", content: "package b" },
  ];
  const split = await read(sources);
  assert.deepEqual(split.edges, []);
  assert.equal(split.unresolved, 1);
  assert.equal(split.uncovered, 0);
  if (process.platform === "win32") {
    await node("package", ["B/"]);
    const result = await read(sources);
    assert.deepEqual(result.edges, [{ from: "node-a", to: "node-package", imports: 1 }]);
    assert.equal(result.unresolved, 0);
  }
});

test("aliases reuse scan extraction and malformed configuration fails instead of a false graph", async (t) => {
  const { node, read } = await fixture(t);
  await node("a", ["src/a/"]);
  await node("b", ["src/b/"]);
  const sources = [
    {
      path: "tsconfig.json",
      content: '{"compilerOptions":{"baseUrl":".","paths":{"@b/*":["src/b/*"]}}}',
    },
    { path: "src/a/x.ts", content: 'import "@b/y";' },
    { path: "src/b/y.ts", content: "" },
  ];
  assert.deepEqual((await read(sources)).edges, [{ from: "node-a", to: "node-b", imports: 1 }]);
  await assert.rejects(
    read([{ path: "tsconfig.json", content: "{ broken" }, ...sources.slice(1)]),
    { code: "INVALID_INPUT" },
  );
});

test("cycles group strongly connected modules and refresh with current inputs", async (t) => {
  const { node, read } = await fixture(t);
  for (const name of ["f", "e", "d", "c", "b", "a", "isolated"]) await node(name, [name + "/"]);
  const sources = [
    { path: "a/x.ts", content: 'import "../b/x.js"; import "../d/x.js";' },
    { path: "b/x.ts", content: 'import "../c/x.js";' },
    { path: "c/x.ts", content: 'import "../a/x.js";' },
    { path: "d/x.ts", content: 'import "../e/x.js";' },
    { path: "e/x.ts", content: 'import "../d/x.js"; import "../f/x.js";' },
    { path: "f/x.ts", content: 'import "./x.js";' },
  ];
  const result = await read(sources);
  assert.deepEqual(result.cycles, [
    ["node-a", "node-b", "node-c"],
    ["node-d", "node-e"],
  ]);
  assert.deepEqual((await read([...sources].reverse())).cycles, result.cycles);
  assert.deepEqual(
    (
      await read(
        sources.map((source) => ({
          ...source,
          content: source.path === "c/x.ts" || source.path === "e/x.ts" ? "" : source.content,
        })),
      )
    ).cycles,
    [],
  );
  await node("b", ["b/"], { status: "archived" });
  assert.deepEqual((await read(sources)).cycles, [["node-d", "node-e"]]);
});
