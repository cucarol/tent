import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { deleteNode } from "../src/core/ops.js";
import { loadTent } from "../src/core/tree.js";
import { nodeNotePath } from "../src/core/paths.js";
import { DELETE_PENDING_PATH, executeDeleteUnlocked } from "../src/core/delete-recovery.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "delete-recovery-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true });
  });
  await scaffoldInWorkspace(new NodeFs(root), {
    name: "delete",
    nodes: [{ id: "node-remove", name: "remove", type: "prompt", body: "original" }],
  });
  const adapter = new NodeFs(path.join(root, ".tent"));
  const env = { fs: adapter, tentName: "delete", clock: { now: () => "2026-09-21T00:00:00.000Z" } };
  await adapter.writeFile("order.json", JSON.stringify({ root: ["node-remove"] }));
  return { adapter, env, root };
}

test("unsupported deletion plans fail without changing original bytes", async (t) => {
  const { adapter, env } = await fixture(t);
  const pending = JSON.stringify({
    kind: "card",
    id: "card-old",
    source: "cards/card-old.md",
    committed: false,
  });
  await adapter.writeFile("cards/card-old.md", "historical input");
  await adapter.writeFile("card-consumptions/card-old.json", "historical receipt");
  await adapter.writeFile(DELETE_PENDING_PATH, pending);
  const nodeBefore = await adapter.readFile("remove/remove.md");
  await assert.rejects(deleteNode(env, "node-remove"), /Invalid input/);
  assert.equal(await adapter.readFile(DELETE_PENDING_PATH), pending);
  assert.equal(await adapter.readFile("cards/card-old.md"), "historical input");
  assert.equal(await adapter.readFile("card-consumptions/card-old.json"), "historical receipt");
  assert.equal(await adapter.readFile("remove/remove.md"), nodeBefore);
});

test("new deletion plans cannot introduce retired Canvas writes", async (t) => {
  const { adapter } = await fixture(t);
  await assert.rejects(
    executeDeleteUnlocked(adapter, {
      kind: "node",
      id: "node-remove",
      source: "remove",
      raw: await adapter.readFile("remove/remove.md"),
      nodeIds: ["node-remove"],
      writes: [{ path: "canvas.json", before: null, after: "{}" }],
    }),
    /associated write/,
  );
  assert.equal(await adapter.exists(DELETE_PENDING_PATH), false);
});

for (const point of [
  "before-move",
  "after-move",
  "commit",
  "order",
  "cleanup",
  "journal",
] as const) {
  test(`Node deletion resumes after ${point} I/O failure without losing the Node before its commit`, async (t) => {
    const { adapter, env, root } = await fixture(t);
    const move = adapter.move.bind(adapter),
      write = adapter.writeFile.bind(adapter),
      remove = adapter.remove.bind(adapter);
    adapter.move = async (from, to) => {
      if (point === "before-move") throw new Error("injected");
      await move(from, to);
      if (point === "after-move") throw new Error("injected");
    };
    adapter.writeFile = async (file, raw) => {
      if (
        (point === "commit" && file === DELETE_PENDING_PATH && JSON.parse(raw).committed) ||
        (point === "order" && file === "order.json")
      )
        throw new Error("injected");
      await write(file, raw);
    };
    adapter.remove = async (file) => {
      if (
        (point === "cleanup" && file === "temp/delete-pending") ||
        (point === "journal" && file === DELETE_PENDING_PATH)
      )
        throw new Error("injected");
      await remove(file);
    };
    await assert.rejects(() => deleteNode(env, "node-remove"), /injected/);
    assert.equal(await adapter.exists(DELETE_PENDING_PATH), true);
    if (point === "before-move") assert.ok((await loadTent(adapter)).byId.has("node-remove"));
    const restarted = new NodeFs(path.join(root, ".tent"));
    await deleteNode({ ...env, fs: restarted }, "node-remove");
    assert.equal(await restarted.exists(DELETE_PENDING_PATH), false);
    assert.equal((await loadTent(restarted)).byId.has("node-remove"), false);
  });
}

test("old Node deletion refuses a reused identity or changed order", async (t) => {
  const { adapter, env } = await fixture(t);
  const old = (await loadTent(adapter)).byId.get("node-remove")!;
  const raw = await adapter.readFile(nodeNotePath(old.path));
  const write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (file, value) => {
    if (file === "order.json") throw new Error("interrupted");
    await write(file, value);
  };
  await assert.rejects(() => deleteNode(env, old.id), /interrupted/);
  adapter.writeFile = write;
  const before = await adapter.readFile("order.json");
  const changed = JSON.stringify({ root: ["node-replacement"] });
  await adapter.writeFile("order.json", changed);
  await assert.rejects(() => deleteNode(env, old.id), /Pending deletion conflict/);
  assert.equal(await adapter.readFile("order.json"), changed);
  await adapter.writeFile("order.json", before);
  await adapter.mkdir("replacement");
  await adapter.writeFile(
    nodeNotePath("replacement"),
    raw.replace("original", "new identity content"),
  );
  await assert.rejects(() => deleteNode(env, old.id), /reused Node identity/);
  assert.match(await adapter.readFile(nodeNotePath("replacement")), /new identity content/);
  assert.equal(await adapter.readFile("order.json"), before);
});
