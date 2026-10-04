import assert from "node:assert/strict";
import { test } from "node:test";
import { createNode } from "../src/core/ops.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const scratch = path.resolve(".scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "node-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Create fixture" });
  return new NodeFs(path.join(root, ".tent"));
}

for (const failure of ["none", "body", "order"] as const) {
  test(`Node creation writes initial body and refs once and rolls back ${failure} failure`, async (t) => {
    const adapter = await fixture(t);
    const sources = [
      { resource: "/refs/example.pdf", custom: [2, 1] },
      { resource: "/refs/example.pdf" },
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
