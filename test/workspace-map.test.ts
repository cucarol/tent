import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { readWorkspaceMap } from "../src/core/read/workspace-map.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { listWorkspaceRelations } from "../src/core/graph/workspace-relations.js";
import { testScratchRoot } from "./scratch.js";

test("workspace map reads headers once and omits bodies, Cards, Roles and history", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "workspace-map-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const adapter = openTestFs(path.join(root, ".tent"));
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
    basis: { head: null },
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

test("map resource marks use declarations without reading materials or reclassifying native details", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "workspace-map-marks-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const adapter = openTestFs(path.join(root, ".tent"));
  const cases = [
    ["local", "../../assets/private.png", "file"],
    ["suffix", "../../assets/name%20with%20space.md#part", "file"],
    ["remote", "https://example.com/private.png", "uri"],
    ["file-uri", "file:///C:/private/file.png", "uri"],
    ["folder", "../../assets/", null],
    ["encoded-folder", "../../assets%2F", null],
    ["prefix", "../../assets/*", null],
    ["internal", "../private.json", null],
    ["node", "../local/local.md", null],
    ["missing-node", "../missing/missing.md", null],
    ["role-good", "../roles/role-good.md", null],
    ["role-missing", "../roles/role-missing.md", null],
    ["role-damaged", "../roles/role-damaged.md", null],
    ["card-good", "../cards/card-good.md", null],
    ["card-missing", "../cards/card-missing.md", null],
    ["card-damaged", "../cards/card-damaged.md", null],
    ["invalid", "../../bad%ZZ", null],
    ["sources-only", undefined, null],
  ] as const;
  for (const [name, resource] of cases)
    await adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter(
        {
          id: `node-${name.replaceAll("-", "")}`,
          type: "prompt",
          ...(resource ? { resource } : {}),
          sources: [
            { resource: "../../extra/private.txt" },
            { resource: "https://example.com/source" },
          ],
        },
        "Private document body",
      ),
    );
  await adapter.writeFile(
    "roles/role-good.md",
    serializeFrontmatter({ type: "role", id: "role-good" }, "Role"),
  );
  await adapter.writeFile(
    "cards/card-good.md",
    serializeFrontmatter(
      { type: "card", id: "card-good", schemaVersion: 3, state: "pending", sources: [] },
      "Card",
    ),
  );
  for (const file of ["roles/role-damaged.md", "cards/card-damaged.md"])
    await adapter.writeFile(file, "---\ninvalid: [\n---\nDamaged native document");
  const detailsBefore = await listWorkspaceRelations(adapter);
  const headers: string[] = [];
  const guarded = new Proxy(adapter, {
    get(target, key) {
      if (key === "history") throw new Error("Map must not consult history");
      if (key === "readBinary")
        return () => assert.fail("Map must not read material or native bytes");
      if (key === "readFile")
        return (file: string) => {
          assert.ok(!file.endsWith(".md"), `Map read full document: ${file}`);
          return target.readFile(file);
        };
      if (key === "readFrontmatter")
        return (file: string) => {
          assert.ok(!/^(roles|cards)\//.test(file), "No extra native header read");
          headers.push(file);
          return target.readFrontmatter(file);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const map = await readWorkspaceMap(guarded, { id: "map-marks", name: "Map" }, root, {
    basis: { head: null },
    sources: [],
  });
  assert.equal(headers.length, cases.length);
  assert.equal(new Set(headers).size, cases.length, "Each header read only once");
  for (const [name, , kind] of cases)
    assert.equal(
      map.nodes.find((n) => n.id === `node-${name.replaceAll("-", "")}`)!.resourceKind,
      kind,
      name,
    );
  const serialized = JSON.stringify(map);
  for (const privateText of [
    "Private document body",
    "private.png",
    "private.txt",
    "example.com",
    "workspacePath",
  ])
    assert.equal(serialized.includes(privateText), false, privateText);
  for (const n of map.nodes) {
    assert.equal("materials" in n, false);
    assert.equal("resource" in n, false);
  }
  const detailsAfter = await listWorkspaceRelations(adapter);
  assert.deepEqual(
    detailsAfter,
    detailsBefore,
    "The map projection changes no detailed identity or diagnostic",
  );
  const target = (name: string) =>
    detailsAfter.find(
      (r) => r.from.id === `node-${name.replaceAll("-", "")}` && r.via === "resource",
    )!.target;
  assert.deepEqual(target("role-good"), { kind: "role", id: "role-good" });
  assert.deepEqual(target("card-good"), { kind: "card", id: "card-good" });
  for (const name of ["role-missing", "role-damaged", "card-missing", "card-damaged"])
    assert.equal(target(name).kind, "file", `Existing detail classification retained: ${name}`);
  assert.equal(target("invalid").kind, "invalid");
  // A later declaration is fresh map metadata, independent of source existence or full details.
  await adapter.writeFile(
    "local/local.md",
    serializeFrontmatter(
      { id: "node-local", type: "prompt", resource: "https://example.com/new" },
      "Same body",
    ),
  );
  const changed = await readWorkspaceMap(guarded, { id: "map-marks", name: "Map" }, root, {
    basis: { head: null },
    sources: [],
  });
  assert.equal(changed.nodes.find((n) => n.id === "node-local")!.resourceKind, "uri");
  assert.notEqual(changed.workspace.revision, map.workspace.revision);
});
