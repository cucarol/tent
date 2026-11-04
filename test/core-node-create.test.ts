import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNode } from "../src/core/graph/ops.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/store/tree.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { scaffoldInWorkspace } from "./scaffold.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { initializeFixtureHistory } from "./scratch.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const scratch = path.resolve(testScratchRoot());
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "node-create-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(root, { name: "Create fixture" });
  return openTestFs(path.join(root, ".tent"));
}

for (const failure of ["none", "body", "order"] as const) {
  test(`Node creation writes initial body and refs once and rolls back ${failure} failure`, async (t) => {
    const adapter = await fixture(t);
    const sources = [
      { resource: "../../refs/example.pdf", custom: [2, 1] },
      { resource: "../../refs/example.pdf" },
    ];
    const write = adapter.writeFile.bind(adapter);
    let nodeWrites = 0;
    adapter.writeFile = async (file, raw) => {
      if (file === "created/created.md") {
        nodeWrites++;
        assert.ok(raw.includes("initial body😀"));
        assert.deepEqual(parseFrontmatter(raw).data.sources, sources);
        if (failure === "body") throw new Error("injected body failure");
      }
      if (file.endsWith("order.json") && failure === "order")
        throw new Error("injected order failure");
      await write(file, raw);
    };
    const env = { fs: adapter, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "test" };
    const create = () =>
      createNode(env, {
        parentPath: "",
        name: "created",
        type: "output",
        body: "initial body😀\n",
        sources,
      });
    if (failure === "none") {
      const id = await create();
      assert.equal((await loadTent(adapter)).byId.get(id)?.body, "initial body😀\n");
    } else {
      await assert.rejects(create, /injected/);
      assert.equal(await adapter.exists("created"), false);
      assert.equal((await loadTent(adapter)).byPath.has("created"), false);
    }
    assert.equal(nodeWrites, 1);
  });
}

test("a failed Node creation leaves the graph as it was", async (t) => {
  const adapter = await fixture(t);
  const env = { fs: adapter, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "test" };
  await createNode(env, { parentPath: "", name: "Existing", type: "prompt", body: "kept" });
  const order = await adapter.readFile("order.json");
  const existing = await adapter.readFile("Existing/Existing.md");
  const write = adapter.writeFile.bind(adapter);
  t.mock.method(adapter, "writeFile", async (file: string, raw: string) => {
    if (file === "order.json") throw new Error("injected order write failure");
    await write(file, raw);
  });
  await assert.rejects(
    createNode(env, { parentPath: "", name: "New", type: "prompt" }),
    /injected order write failure/,
  );
  assert.equal(await adapter.readFile("order.json"), order);
  assert.equal(await adapter.readFile("Existing/Existing.md"), existing);
  assert.equal(await adapter.exists("New"), false);
  assert.deepEqual([...(await loadTent(adapter)).byPath.keys()], ["Existing"]);
});

test("invalid initial references never publish a partial Node", async (t) => {
  const adapter = await fixture(t);
  const env = { fs: adapter, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "test" };
  await assert.rejects(
    createNode(env, {
      parentPath: "",
      name: "invalid",
      type: "output",
      body: "fact",
      sources: [{ resource: "" }],
    }),
    /Resource must not be empty/,
  );
  assert.equal(await adapter.exists("invalid"), false);
  assert.equal((await loadTent(adapter)).byPath.has("invalid"), false);
});

for (const state of ["missing", "duplicate", "invalid"] as const) {
  test(`creation by parent ID rejects a ${state} parent without writing`, async (t) => {
    const adapter = await fixture(t);
    await initializeFixtureHistory(path.join(adapter.workspaceRoot!, ".tent"));
    const env = { fs: adapter, clock: { now: () => "2026-10-22T00:00:00.000Z" }, tentName: "test" };
    if (state !== "missing") {
      await adapter.writeFile(
        "Parent/Parent.md",
        `---\nid: node-parent\ntype: ${state === "invalid" ? "unknown" : "goal"}\n---\nParent\n`,
      );
    }
    if (state === "duplicate")
      await adapter.writeFile("Copy/Copy.md", "---\nid: node-parent\ntype: goal\n---\nCopy\n");
    const head = await adapter.history.currentCommit();
    const writes: string[] = [];
    const write = adapter.writeFile.bind(adapter);
    t.mock.method(adapter, "writeFile", async (file: string, raw: string) => {
      writes.push(file);
      await write(file, raw);
    });
    await assert.rejects(
      createNode(env, { parentId: "node-parent", name: "Child", type: "prompt" }),
      /not found|Duplicate|invalid/i,
    );
    assert.deepEqual(writes, []);
    assert.equal(await adapter.history.currentCommit(), head);
    assert.equal(await adapter.exists("Parent/Child"), false);
  });
}
