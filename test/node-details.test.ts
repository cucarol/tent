import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import {
  readNodeCardsDetails,
  readNodeHistoryDetails,
  readNodeRelationsDetails,
} from "../src/core/read/node-details.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { createCardDocument } from "../src/core/graph/card-document.js";
import { renameNode } from "../src/core/graph/rename-ops.js";
import { serializeFrontmatter, parseFrontmatter } from "../src/core/base/frontmatter.js";
import { buildSnapshot } from "../src/ui-server/snapshot.js";
import { buildGraph } from "../src/ui/data/store.js";
import { git } from "./helpers.js";
import type { FsAdapter } from "../src/core/store/adapter.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-details-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureWorkspace(root);
  const adapter = openTestFs(path.join(root, ".tent"));
  await adapter.writeFile("Main/Main.md", "---\nid: node-main\ntype: goal\n---\nMain body\n");
  await adapter.writeFile(
    "Other/Other.md",
    "---\nid: node-other\ntype: prompt\n---\nUnrelated body\n",
  );
  await createRoleContext(adapter, {
    roleId: "role-a",
    title: "Role A",
    body: "Links [main](/Main/Main.md).",
  });
  return { root, adapter };
}

function observe(adapter: NodeFs) {
  const bodies: string[] = [];
  const source = new Proxy(adapter, {
    get(target, key) {
      if (key === "readFile" || key === "readBinary")
        return async (file: string) => {
          bodies.push(file);
          return target[key](file);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { source: source as FsAdapter, bodies };
}

test("selected outgoing details match snapshot relations without unrelated Node or Card bodies", async (t) => {
  const { adapter } = await fixture(t);
  await createCardDocument(adapter, {
    cardId: "card-linked",
    title: "Linked Card",
    prompt: "Link target",
  });
  await createCardDocument(adapter, {
    cardId: "card-other",
    title: "Other Card",
    prompt: "Unrelated",
  });
  await adapter.writeFile(
    "cards/card-unpublished.md",
    serializeFrontmatter(
      { id: "card-unpublished", type: "card", schemaVersion: 3, state: "pending", sources: [] },
      "Not published",
    ),
  );
  await adapter.writeFile(
    "Main/Main.md",
    serializeFrontmatter(
      {
        id: "node-main",
        type: "goal",
        resource: "/roles/role-a.md",
        sources: [{ resource: "../docs/out.txt" }],
      },
      "[Other](/Other/Other.md) [Card](/cards/card-linked.md) [Unpublished](/cards/card-unpublished.md) @node-other\n",
    ),
  );
  const snapshot = await buildSnapshot({
    fs: adapter,
    workspace: { id: "test", name: "Test" },
    revision: "one",
  });
  const expected = snapshot.nodes.find((node) => node.id === "node-main")!;
  const { source, bodies } = observe(adapter);
  const details = await readNodeRelationsDetails(source, "node-main", "outgoing");
  assert.deepEqual(details.links, expected.links);
  assert.deepEqual(details.materials, expected.materials);
  assert.deepEqual(
    details.roles.map((role) => role.id),
    buildGraph(snapshot)
      .rolesOf("node-main")
      .map((role) => role.id),
  );
  assert.equal(details.refs.find((ref) => ref.id === "card-linked")?.title, "Linked Card");
  assert.equal(details.refs.find((ref) => ref.id === "card-unpublished")?.exists, false);
  assert.ok(bodies.includes("Main/Main.md"));
  assert.ok(!bodies.includes("Other/Other.md"));
  assert.ok(!bodies.includes("cards/card-other.md"));
  assert.deepEqual(details.incoming, []);
  const incoming = await readNodeRelationsDetails(adapter, "node-main", "incoming");
  assert.deepEqual(
    incoming.incoming.map(({ title: _title, cardState: _state, ...item }) => item),
    expected.incoming,
  );
  assert.equal(incoming.incoming[0]?.title, "Role A");
});

test("related Cards follow retained Node identity through moves and path reuse, with duplicate versions and diagnostics", async (t) => {
  const { adapter, root } = await fixture(t);
  const first = await createCardDocument(adapter, {
    cardId: "card-first",
    prompt: "# **Fallback**",
    target: "role-a",
    sources: [{ resource: "/Main/Main.md" }, { resource: "/Main/Main.md" }],
  });
  await createCardDocument(adapter, {
    cardId: "card-other",
    prompt: "Unrelated",
    sources: [{ resource: "/Other/Other.md" }],
  });
  await renameNode(
    { fs: adapter, clock: { now: () => "test" }, tentName: "test" },
    "node-main",
    "Moved",
  );
  await adapter.writeFile("Main/Main.md", "---\nid: node-reused\ntype: goal\n---\nNew occupant\n");
  const changed = parseFrontmatter(await adapter.readFile(first.path));
  changed.data.status = "deprecated";
  await adapter.writeFile(first.path, serializeFrontmatter(changed.data, changed.body));
  const bad = await createCardDocument(adapter, {
    cardId: "card-bad",
    prompt: "Broken later",
    sources: [{ resource: "/Moved/Moved.md" }],
  });
  const broken = parseFrontmatter(await adapter.readFile(bad.path));
  const sources = broken.data.sources as Array<{
    resource: string;
    version: { commit: string; path: string };
  }>;
  sources[0]!.version.commit = "0".repeat(64);
  sources.push({ ...sources[0]!, resource: "/Main/Main.md" });
  await adapter.writeFile(bad.path, serializeFrontmatter(broken.data, broken.body));
  const malformed = await createCardDocument(adapter, {
    cardId: "card-shape",
    prompt: "Invalid shape",
  });
  const shape = parseFrontmatter(await adapter.readFile(malformed.path));
  shape.data.sources = "invalid";
  await adapter.writeFile(malformed.path, serializeFrontmatter(shape.data, shape.body));
  await adapter.writeFile(
    "cards/card-unpublished.md",
    serializeFrontmatter(
      {
        id: "card-unpublished",
        type: "card",
        schemaVersion: 3,
        state: "pending",
        sources: [{ resource: "/Moved/Moved.md" }],
      },
      "Not published",
    ),
  );
  const { source, bodies } = observe(adapter);
  const tentRoot = path.join(root, ".tent");
  const head = await historyHead(tentRoot);
  const dirty = await fs.readFile(path.join(tentRoot, ".git/history.sqlite"), "hex");
  const details = await readNodeCardsDetails(source, "node-main");
  assert.deepEqual(
    details.items.map((item) => item.id),
    ["card-first"],
  );
  assert.equal(details.items[0]!.title, "Fallback");
  assert.equal(details.items[0]!.status, "deprecated");
  assert.deepEqual(details.items[0]!.lane, { id: "role-a", title: "Role A" });
  assert.equal(details.items[0]!.sources.length, 2);
  assert.equal(details.items[0]!.sources[0]!.version?.path, "Main/Main.md");
  assert.ok(details.diagnostics.some((item) => item.cardId === "card-bad"));
  assert.ok(
    details.diagnostics.some(
      (item) => item.cardId === "card-bad" && item.index === 1 && /must address/.test(item.error),
    ),
  );
  assert.ok(details.diagnostics.some((item) => item.cardId === "card-shape"));
  assert.ok(!bodies.includes("Other/Other.md"));
  assert.ok(!bodies.includes("cards/card-other.md"));
  assert.deepEqual((await readNodeCardsDetails(adapter, "node-reused")).items, []);
  const original = await adapter.readFile(first.path);
  const unknown = parseFrontmatter(original);
  unknown.data.status = "future-status";
  await adapter.writeFile(first.path, serializeFrontmatter(unknown.data, unknown.body));
  const withUnknown = await readNodeCardsDetails(adapter, "node-main");
  assert.equal(withUnknown.items[0]!.status, null);
  assert.ok(
    withUnknown.diagnostics.some(
      (item) => item.cardId === first.cardId && /Unsupported document status/.test(item.error),
    ),
  );
  await adapter.writeFile(first.path, original);
  const racing = new Proxy(adapter, {
    get(target, key) {
      if (key === "readFile")
        return async (file: string) => {
          if (file !== first.path) return target.readFile(file);
          const parsed = parseFrontmatter(original);
          return serializeFrontmatter(
            { ...parsed.data, title: "Changed after header read" },
            parsed.body,
          );
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(readNodeCardsDetails(racing, "node-main"), { code: "SOURCE_CHANGED" });
  assert.equal(await historyHead(tentRoot), head);
  assert.equal(await fs.readFile(path.join(tentRoot, ".git/history.sqlite"), "hex"), dirty);
});

test("selected history retains both paths across a rename and does not load Node bodies", async (t) => {
  const { adapter } = await fixture(t);
  await createCardDocument(adapter, {
    prompt: "Capture",
    sources: [{ resource: "/Main/Main.md" }],
  });
  await renameNode(
    { fs: adapter, clock: { now: () => "test" }, tentName: "test" },
    "node-main",
    "Moved",
  );
  const { source, bodies } = observe(adapter);
  const details = await readNodeHistoryDetails(source, "node-main");
  assert.ok(
    details.items.some(
      (item) =>
        item.file.before?.path === "Main/Main.md" && item.file.after?.path === "Moved/Moved.md",
    ),
  );
  assert.ok(details.items.some((item) => item.file.status === "A"));
  assert.ok(
    !bodies.some(
      (file) =>
        file.endsWith("/Main.md") || file.endsWith("/Moved.md") || file.endsWith("/Other.md"),
    ),
  );
  await assert.rejects(readNodeHistoryDetails(adapter, "node-missing"), { code: "NOT_FOUND" });
  await assert.rejects(readNodeRelationsDetails(adapter, "invalid", "outgoing"), {
    code: "INVALID_INPUT",
  });
});
