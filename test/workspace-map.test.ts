import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { readWorkspaceMap } from "../src/core/read/workspace-map.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";

test("workspace map reads headers once and omits bodies, Cards, Roles and history", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "workspace-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const adapter = new NodeFs(path.join(root, ".tent"));
  const workspace = { id: "ws-map", name: "Map" };
  const parent = {
    id: "node-parent",
    type: "goal",
    tags: ["spec"],
    stale_after: "2026-10-19T00:00:00Z",
    sources: [{ resource: "../../src/a/", track: "structure" }],
  };
  await adapter.writeFile("Parent/Parent.md", serializeFrontmatter(parent, "Private body"));
  await adapter.writeFile(
    "Parent/Child/Child.md",
    serializeFrontmatter(
      {
        id: "node-child",
        type: "prompt",
        sources: [{ resource: "../../../src/b/", track: "structure" }],
      },
      "Private child body",
    ),
  );
  await adapter.writeFile("cards/card-broken.md", "---\ninvalid: [\n---\nPrivate Card");
  await adapter.writeFile("roles/role-broken.md", "---\ninvalid: [\n---\nPrivate Role");
  const headers: string[] = [];
  const guarded = new Proxy(adapter, {
    get(target, key) {
      if (key === "history") throw new Error("Map must not consult history");
      if (key === "readBinary") return () => assert.fail("Map must not read document bytes");
      if (key === "readFile")
        return (file: string) => {
          assert.ok(!file.endsWith(".md"), `Map read full document: ${file}`);
          return target.readFile(file);
        };
      if (key === "readFrontmatter")
        return (file: string) => {
          assert.ok(!/^(cards|roles)\//.test(file));
          headers.push(file);
          return target.readFrontmatter(file);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const repository = {
    basis: { head: null, dirty: true },
    sources: [
      { path: "src/a/index.ts", content: 'import "../b/index.js";' },
      { path: "src/b/index.ts", content: "export const n = 1;" },
    ],
  };
  const read = (now = "2026-10-20T00:00:00Z") =>
    readWorkspaceMap(guarded, workspace, root, repository, now);
  const first = await read();
  assert.deepEqual(headers.sort(), ["Parent/Child/Child.md", "Parent/Parent.md"]);
  assert.deepEqual(
    first.nodes.map(({ id, parentId, childIds, stale }) => ({ id, parentId, childIds, stale })),
    [
      { id: "node-parent", parentId: null, childIds: ["node-child"], stale: true },
      { id: "node-child", parentId: "node-parent", childIds: [], stale: false },
    ],
  );
  assert.deepEqual(first.modules.edges, [{ from: "node-parent", to: "node-child", imports: 1 }]);
  assert.equal(JSON.stringify(first).includes("Private"), false);
  assert.deepEqual(Object.keys(first).sort(), ["modules", "nodes", "workspace"]);
  await adapter.writeFile("Parent/Parent.md", serializeFrontmatter(parent, "Another private body"));
  await adapter.writeFile("cards/card-broken.md", "Changed Card");
  assert.equal((await read()).workspace.revision, first.workspace.revision);
  assert.notEqual(
    (await read("2026-10-18T00:00:00Z")).workspace.revision,
    first.workspace.revision,
  );
  await adapter.writeFile(
    "Parent/Parent.md",
    serializeFrontmatter({ ...parent, tags: ["updated"] }, "Body"),
  );
  assert.notEqual((await read()).workspace.revision, first.workspace.revision);
  repository.sources = [
    { path: "src/a/index.ts", content: "export const n = 0;" },
    { path: "src/b/index.ts", content: "export const n = 1;" },
  ];
  assert.deepEqual((await read()).modules.edges, []);
});
