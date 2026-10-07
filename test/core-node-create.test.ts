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

test("Node creation keeps the existing order table when its snapshot read fails", async (t) => {
  const adapter = await fixture(t);
  const env = { fs: adapter, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "test" };
  await createNode(env, { parentPath: "", name: "Existing", type: "prompt", body: "kept" });
  const order = await adapter.readFile("order.json");
  const existing = await adapter.readFile("Existing/Existing.md");
  const exists = adapter.exists.bind(adapter);
  const read = adapter.readFile.bind(adapter);
  const write = adapter.writeFile.bind(adapter);
  // The rollback snapshot is the order read that follows the target path check.
  let armed = false;
  let injected = 0;
  const writes: string[] = [];
  t.mock.method(adapter, "exists", async (file: string) => {
    if (file === "New") armed = true;
    return exists(file);
  });
  t.mock.method(adapter, "readFile", async (file: string) => {
    if (file === "order.json" && armed) {
      armed = false;
      injected++;
      throw Object.assign(new Error("EIO: injected order snapshot failure"), { code: "EIO" });
    }
    return read(file);
  });
  t.mock.method(adapter, "writeFile", async (file: string, raw: string) => {
    writes.push(file);
    if (file === "New/New.md") throw new Error("injected Node write failure");
    await write(file, raw);
  });
  const failure = await createNode(env, { parentPath: "", name: "New", type: "prompt" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(await read("order.json"), order);
  assert.match(String(failure), /EIO: injected order snapshot failure/);
  assert.equal(injected, 1);
  assert.deepEqual(
    writes.filter((file) => file === "order.json" || file.startsWith("New/")),
    [],
  );
  assert.equal(await read("Existing/Existing.md"), existing);
  assert.equal(await exists("New"), false);
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
