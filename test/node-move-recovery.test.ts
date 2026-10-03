import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { withTentMutation } from "../src/core/adapter.js";
import { createNode, moveNode, renameNode } from "../src/core/ops.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { loadTent } from "../src/core/tree.js";
import { NODE_MOVE_PENDING_PATH } from "../src/core/node-move-recovery.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { MUTATION_LOCK_STALE_MS } from "../src/fs/mutation-lock.js";

async function fixture() {
  const scratch = fileURLToPath(new URL("../.scratch/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "tent-move-recovery-"));
  const root = path.join(workspace, ".tent");
  const fsa = new NodeFs(root);
  await scaffoldTent(fsa, { name: "recovery" });
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
  assert.equal(await f.fsa.exists(NODE_MOVE_PENDING_PATH), true);
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
  assert.equal(await f.fsa.exists(NODE_MOVE_PENDING_PATH), false);
}

for (const [operation, points] of [
  ["move", ["move-1", "hub/hub.md", "order.json", "before-clear"]],
  ["rename", ["move-1", "move-2", "hub/hub.md", "before-clear"]],
] as const) {
  for (const point of points)
    test(`${operation}: real process exit at ${point}, mutation restores and repeated recovery is harmless`, async (t) => {
      const f = await fixture();
      t.after(() => fs.rm(f.workspace, { recursive: true, force: true }));
      await crash(f, operation, point);
      await withTentMutation(f.fsa, async () => undefined);
      await assertRestored(f);
      await withTentMutation(f.fsa, async () => undefined);
      await assertRestored(f);
    });
}

for (const point of ["hub/hub.md", "move-1", "before-clear"])
  test(`recovery interrupted at ${point} remains restartable`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.workspace, { recursive: true, force: true }));
    await crash(f, "move", "order.json");
    await crash(f, "recover", point);
    await withTentMutation(f.fsa, async () => undefined);
    await assertRestored(f);
  });

for (const conflictPath of ["hub/hub.md", "order.json", "dest/child/child.md"])
  test(`external edit to ${conflictPath} blocks whole recovery without overwrites`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.workspace, { recursive: true, force: true }));
    await crash(f, "move", "order.json");
    await f.fsa.writeFile(conflictPath, "external edit\n");
    const paths = ["dest/child/child.md", "hub/hub.md", "order.json", NODE_MOVE_PENDING_PATH];
    const before = await Promise.all(paths.map((p) => f.fsa.readFile(p)));
    let wrote = false;
    await assert.rejects(
      withTentMutation(f.fsa, async () => {
        wrote = true;
      }),
      /Pending Node move conflict/,
    );
    assert.equal(wrote, false);
    assert.deepEqual(await Promise.all(paths.map((p) => f.fsa.readFile(p))), before);
    assert.equal(await f.fsa.exists("parent/child"), false);
  });

test("unsupported journal version and recreated source directory are retained", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.workspace, { recursive: true, force: true }));
  await crash(f, "move", "move-1");
  const pending = await f.fsa.readFile(NODE_MOVE_PENDING_PATH);
  await f.fsa.writeFile(NODE_MOVE_PENDING_PATH, pending.replace('"version":1', '"version":2'));
  await assert.rejects(withTentMutation(f.fsa, async () => undefined));
  await f.fsa.writeFile(NODE_MOVE_PENDING_PATH, pending);
  await f.fsa.mkdir("parent/child");
  await assert.rejects(
    withTentMutation(f.fsa, async () => undefined),
    /directory identity/,
  );
  assert.equal(await f.fsa.readFile(NODE_MOVE_PENDING_PATH), pending);
});

test("ordinary successful move and rename remove their recovery records", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.workspace, { recursive: true, force: true }));
  await moveNode(f.env, f.child, f.dest, { mode: "inside" });
  await renameNode(f.env, f.child, "renamed");
  assert.equal((await loadTent(f.fsa)).byId.get(f.child)?.path, "dest/renamed");
  assert.match(await f.fsa.readFile("hub/hub.md"), /dest\/renamed\/renamed.md/);
  assert.equal(await f.fsa.exists(NODE_MOVE_PENDING_PATH), false);
});

test("rename recovery survives interruption after restoring the identity filename", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.workspace, { recursive: true, force: true }));
  await crash(f, "rename", "before-clear");
  await crash(f, "recover", "move-1");
  await withTentMutation(f.fsa, async () => undefined);
  await assertRestored(f);
});

test("recovery keeps pending until restored contents have been read back", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.workspace, { recursive: true, force: true }));
  await crash(f, "move", "order.json");
  class DroppedWriteFs extends NodeFs {
    override async writeFile(name: string, content: string) {
      if (name !== "hub/hub.md") await super.writeFile(name, content);
    }
  }
  await assert.rejects(
    withTentMutation(new DroppedWriteFs(f.root), async () => undefined),
    /Pending Node move conflict/,
  );
  assert.equal(await f.fsa.exists(NODE_MOVE_PENDING_PATH), true);
  await withTentMutation(f.fsa, async () => undefined);
  await assertRestored(f);
});
