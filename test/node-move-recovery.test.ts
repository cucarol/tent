import { initializeFixtureHistory, testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { withTentMutation } from "../src/core/store/adapter.js";
import { createNode, moveNode, renameNode } from "../src/core/graph/ops.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { loadTent } from "../src/core/store/tree.js";
import { MUTATION_LOCK_STALE_MS } from "../src/fs/mutation-lock.js";

async function fixture(t: TestContext) {
  const scratch = testScratchRoot();
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "tent-move-recovery-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, ".tent");
  const fsa = openTestFs(root);
  await scaffoldTent(fsa, { name: "recovery" });
  await initializeFixtureHistory(root);
  const env = { fs: fsa, clock: { now: () => new Date().toISOString() }, tentName: "recovery" };
  await createNode(env, { parentPath: "", name: "parent", type: "prompt" });
  const child = await createNode(env, { parentPath: "parent", name: "child", type: "prompt" });
  const dest = await createNode(env, { parentPath: "", name: "dest", type: "prompt" });
  await createNode(env, { parentPath: "", name: "hub", type: "prompt" });
  await fsa.writeFile(
    "hub/hub.md",
    (await fsa.readFile("hub/hub.md")).replace(
      "---\n",
      "---\nsources: [{resource: /parent/child/child.md, custom: keep}]\n",
    ) + "See [Child](../parent/child/child.md) and [[parent/child]].\n",
  );
  await fsa.writeFile(
    "parent/child/child.md",
    (await fsa.readFile("parent/child/child.md")).replace(
      "---\n",
      "---\nresource: ../../hub/hub.md\n",
    ) + "[Hub](../../hub/hub.md)\n",
  );
  const originals = new Map(
    await Promise.all(
      ["parent/parent.md", "parent/child/child.md", "dest/dest.md", "hub/hub.md", "order.json"].map(
        async (name) => [name, await fsa.readFile(name)] as const,
      ),
    ),
  );
  return { workspace, root, fsa, env, child, dest, originals };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function crash(f: Fixture, operation: string, point: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/node-move-crash.ts", import.meta.url)),
      f.root,
      operation,
      f.child,
      f.dest,
      point,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 77, result.stderr || String(result.error));
  // 保留真实退出进程的锁和 PID，只推进已有锁的过期时间，避免每个用例等待两分钟。
  const expired = new Date(Date.now() - MUTATION_LOCK_STALE_MS - 1000);
  await fs.utimes(path.join(f.root, "mutation.lock"), expired, expired);
}

async function assertRestored(f: Fixture) {
  for (const [name, content] of f.originals)
    assert.equal(await f.fsa.readFile(name), content, name);
  assert.equal((await loadTent(f.fsa)).byId.get(f.child)?.path, "parent/child");
  assert.equal(await f.fsa.exists("dest/child"), false);
  assert.equal(await f.fsa.exists("parent/renamed"), false);
}

for (const [operation, points] of [
  ["move", ["move-1", "hub/hub.md", "order.json"]],
  ["rename", ["move-1", "move-2", "hub/hub.md"]],
] as const) {
  for (const point of points)
    test(`${operation}: real process exit at ${point}, the next write restores the old state`, async (t) => {
      const f = await fixture(t);
      await crash(f, operation, point);
      await withTentMutation(f.fsa, async () => undefined);
      await assertRestored(f);
    });
}

test("ordinary successful move and rename rewrite links to the new path", async (t) => {
  const f = await fixture(t);
  await moveNode(f.env, f.child, f.dest, { mode: "inside" });
  await renameNode(f.env, f.child, "renamed");
  assert.equal((await loadTent(f.fsa)).byId.get(f.child)?.path, "dest/renamed");
  assert.match(await f.fsa.readFile("hub/hub.md"), /dest\/renamed\/renamed.md/);
});
