import { openTestService } from "./node-fs.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { readMaterialOverlaps } from "../src/core/read/material-overlaps.js";
import { startUiServer } from "../src/ui-server/server.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "material-overlap-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(root);
  const adapter = openTestFs(path.join(root, ".tent"));
  const node = (name: string, data: Record<string, unknown>) =>
    adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter({ id: `node-${name}`, type: "prompt", ...data }, "Unneeded body"),
    );
  const read = (...ids: string[]) =>
    readMaterialOverlaps(
      adapter,
      root,
      ids.map((id) => `node-${id}`),
    );
  return { root, adapter, node, read };
}

test("shared materials use recursive directory, prefix and file boundaries without observing members", async (t) => {
  const { root, adapter, node, read } = await fixture(t);
  await node("a", { sources: [{ resource: "../../src/core/", track: "structure" }] });
  await node("b", { sources: [{ resource: "../../src/core/foo*", track: "structure" }] });
  await node("c", { resource: "../../src/core/foo.ts#First" });
  await node("d", { resource: "../../src/core-other/" });
  await node("e", { resource: "../../src/core/foo/" });
  await node("f", { resource: "../../" });
  await node("g", { resource: pathToFileURL(path.join(root, "src/core/foo.ts")).href + "#Second" });
  const head = await adapter.history.currentCommit();
  const rawRead = adapter.readFile.bind(adapter);
  t.mock.method(adapter, "readFile", async (file: string) => {
    if (/^[a-g]\/[a-g]\.md$/.test(file)) throw new Error("Query must read headers, not bodies");
    return rawRead(file);
  });
  t.mock.method(adapter, "observeMaterial", async () => {
    throw new Error("Must not inspect directory members");
  });
  const result = await read("a", "b", "c", "d", "e", "f", "g", "a");
  assert.equal(result.nodes.length, 7);
  assert.equal(result.pairs.length, 21);
  assert.ok(result.nodes.every((n) => n.issues.length === 0));
  const pair = (left: string, right: string) =>
    result.pairs.find((p) => p.left === `node-${left}` && p.right === `node-${right}`)!.shared;
  assert.deepEqual(pair("a", "b"), [
    {
      left: { field: "sources", index: 0, resource: "../../src/core/", track: "structure" },
      right: { field: "sources", index: 0, resource: "../../src/core/foo*", track: "structure" },
      intersection: { kind: "prefix", path: "src/core/foo" },
    },
  ]);
  assert.deepEqual(pair("a", "c")[0]!.intersection, { kind: "file", path: "src/core/foo.ts" });
  assert.deepEqual(pair("b", "e")[0]!.intersection, { kind: "directory", path: "src/core/foo/" });
  assert.deepEqual(pair("a", "d"), []);
  assert.deepEqual(pair("d", "f")[0]!.intersection, { kind: "directory", path: "src/core-other/" });
  assert.deepEqual(pair("c", "g")[0]!.intersection, { kind: "file", path: "src/core/foo.ts" });
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await fs.stat(path.join(root, "src")).catch(() => null), null);
});

test("declarations preserve known intersections alongside unresolved inputs and exclude system coverage", async (t) => {
  const { adapter, node, read } = await fixture(t);
  await node("target", {});
  await node("a", {
    sources: [
      { resource: "../target/target.md" },
      { resource: "https://example.test/proof#part" },
      { resource: "a named population" },
      { resource: "../../src/**" },
      { resource: "../../src/x.ts", track: "structure" },
      { resource: "../target/target.md/" },
      { resource: "../canvas.json" },
      { resource: "/cards/card-reply.md" },
    ],
  });
  await node("b", {
    resource: "../target/target.md",
    sources: [
      { resource: "https://example.test/proof#part" },
      { resource: "https://example.test/proof#other" },
      { resource: "/cards/card-reply.md" },
    ],
  });
  await node("root", { resource: "../../" });
  const result = await read("a", "b", "root");
  assert.equal(result.nodes[0]!.issues.length, 5);
  assert.deepEqual(
    result.nodes[0]!.issues.map((x) => x.index),
    [2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    result.pairs[0]!.shared.map((s) => s.intersection),
    [
      { kind: "document", path: "target/target.md" },
      { kind: "uri", uri: "https://example.test/proof#part" },
    ],
  );
  assert.deepEqual(result.pairs[1]!.shared, []);
  assert.deepEqual(result.pairs[2]!.shared, []);
  assert.equal(await adapter.exists("canvas.json"), false);
});

test("latest headers and lifecycle decide declared coverage, with no body or revision cache", async (t) => {
  const { node, read } = await fixture(t);
  await node("a", { resource: "../../src/" });
  await node("b", { resource: "../../src/a.ts" });
  assert.equal((await read("a", "b")).pairs[0]!.shared.length, 1);
  await node("b", { resource: "../../elsewhere/a.ts" });
  assert.equal((await read("a", "b")).pairs[0]!.shared.length, 0);
  await node("b", { resource: "../../src/a.ts", status: "deprecated" });
  assert.equal((await read("a", "b")).pairs[0]!.shared.length, 0);
  await node("b", { resource: "../../src/a.ts", status: "draft" });
  assert.equal((await read("a", "b")).pairs[0]!.shared.length, 1);
  assert.deepEqual(await read(), { nodes: [], pairs: [] });
  await assert.rejects(read("missing"), /Node not found/);
});

test("material overlap HTTP reads are authenticated and fresh without capturing declarations", async (t) => {
  const { root, adapter, node } = await fixture(t);
  await node("a", { resource: "../../src/" });
  await node("b", { resource: "../../src/a.ts" });
  const server = await openTestService({ workspaceRoot: root, staticDir: root, port: 0 });
  t.after(() => server.close());
  const url = new URL(server.url);
  const endpoint = new URL("/api/nodes/material-overlaps?nodeId=node-a&nodeId=node-b", url);
  const headers = { Authorization: `Bearer ${url.hash.slice("#token=".length)}` };
  const head = await adapter.history.currentCommit();
  assert.equal((await fetch(endpoint)).status, 401);
  const read = async () => {
    const res = await fetch(endpoint, { headers });
    assert.equal(res.status, 200);
    return res.json();
  };
  assert.equal((await read()).pairs[0].shared.length, 1);
  await node("b", { resource: "../../other.ts" });
  assert.equal((await read()).pairs[0].shared.length, 0);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(
    (await fetch(new URL("/api/nodes/material-overlaps?nodeId=bad", url), { headers })).status,
    422,
  );
  assert.equal(
    (await fetch(new URL("/api/nodes/material-overlaps?nodeId=node-missing", url), { headers }))
      .status,
    404,
  );
});
