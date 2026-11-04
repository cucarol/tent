import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { initializeFixtureHistory } from "./scratch.js";
import { deleteNode } from "../src/core/graph/ops.js";
import { loadTent } from "../src/core/store/tree.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "delete-recovery-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await removeTestFixture(root, { recursive: true, force: true });
  });
  await scaffoldInWorkspace(root, {
    name: "delete",
    nodes: [{ id: "node-remove", name: "remove", type: "prompt", body: "original" }],
  });
  await initializeFixtureHistory(path.join(root, ".tent"));
  const adapter = openTestFs(path.join(root, ".tent"));
  const env = { fs: adapter, tentName: "delete", clock: { now: () => "2026-09-21T00:00:00.000Z" } };
  await adapter.writeFile("order.json", JSON.stringify({ root: ["node-remove"] }));
  return { adapter, env, root };
}

for (const point of ["order", "capture"] as const) {
  test(`a Node deletion failing at ${point} restores the Node, and a retry deletes it`, async (t) => {
    const { adapter, env, root } = await fixture(t);
    const node = await adapter.readFile("remove/remove.md");
    const order = await adapter.readFile("order.json");
    const write = adapter.writeFile.bind(adapter),
      capture = adapter.history.captureUnlocked.bind(adapter.history);
    adapter.writeFile = async (file, raw) => {
      if (point === "order" && file === "order.json") throw new Error("injected");
      await write(file, raw);
    };
    adapter.history.captureUnlocked = async (changes, metadata) => {
      if (point === "capture" && metadata?.operation === "node.delete") throw new Error("injected");
      return capture(changes, metadata);
    };
    await assert.rejects(() => deleteNode(env, "node-remove"), /injected/);
    assert.equal(await adapter.readFile("remove/remove.md"), node);
    assert.equal(await adapter.readFile("order.json"), order);
    assert.ok((await loadTent(adapter)).byId.has("node-remove"));
    assert.ok(
      (await adapter.history.changesInRange()).every((entry) => entry.operation !== "node.delete"),
    );
    const restarted = openTestFs(path.join(root, ".tent"));
    await deleteNode({ ...env, fs: restarted }, "node-remove");
    assert.equal((await loadTent(restarted)).byId.has("node-remove"), false);
    assert.equal(await restarted.exists("remove"), false);
  });
}
