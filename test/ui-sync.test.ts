import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeFixtureWorkspace } from "./scratch.js";
import { createNode } from "../src/core/graph/ops.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { confirmNodeSync } from "../src/core/graph/node-sync.js";
import { inspectCurrentContext, makeContextBrief } from "../src/core/read/context-brief.js";
import { readWorkspaceRevision } from "../src/core/workspace/workspace-revision.js";
import { startUiServer } from "../src/ui-server/server.js";
import { testScratchRoot } from "./scratch.js";

test("sync reads changed materials without a revision change and agrees with brief on both flags", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await initializeFixtureWorkspace(root);
  const tent = new NodeFs(path.join(root, ".tent"));
  await fs.writeFile(path.join(root, "requirements.txt"), "before");
  const goal = await createNode(
    { fs: tent, clock: { now: () => new Date().toISOString() }, tentName: "Sync" },
    { parentPath: "", name: "Goal", type: "goal", resource: "../../requirements.txt" },
  );
  const server = await startUiServer({ workspaceRoot: root, staticDir: root, port: 0 });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice("#token=".length)}` };
  const sync = async () => {
    const response = await fetch(new URL("/api/sync", url), { headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.revision, await readWorkspaceRevision(tent));
    return result.nodes as Record<
      string,
      {
        ahead?: { since?: string; reasons: string[] };
        behind?: { reasons: string[] };
      }
    >;
  };
  const initial = await sync();
  assert.ok(initial[goal]?.ahead);
  assert.equal(initial[goal]?.behind, undefined);
  const revision = await readWorkspaceRevision(tent);
  await fetch(new URL("/api/snapshot", url), { headers });
  await fs.writeFile(path.join(root, "requirements.txt"), "changed requirements");
  assert.equal(await readWorkspaceRevision(tent), revision);
  const flags = await sync();
  assert.ok(flags[goal]?.ahead);
  assert.ok(flags[goal]?.behind?.reasons.length);
  const brief = makeContextBrief(await inspectCurrentContext(tent));
  for (const kind of ["ahead", "behind"] as const) {
    assert.equal(Object.values(flags).filter((flag) => flag[kind]).length, brief.counts[kind]);
    assert.ok(brief[kind].some((item) => item.nodeId === goal));
  }
  const current = await readNodeForEdit(tent, goal);
  await confirmNodeSync(tent, goal, { baseEtag: current.etag });
  const confirmed = await sync();
  assert.ok(confirmed[goal]?.ahead);
  assert.equal(confirmed[goal]?.behind, undefined);
});

test("output comparison HTTP reads current goal facts without capture or snapshot caching", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-output-compare-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await initializeFixtureWorkspace(root);
  const tent = new NodeFs(path.join(root, ".tent"));
  await fs.writeFile(path.join(root, "direction.txt"), "first");
  const env = { fs: tent, clock: { now: () => new Date().toISOString() }, tentName: "Compare" };
  const goal = await createNode(env, {
    parentPath: "",
    name: "Goal",
    type: "goal",
    resource: "../../direction.txt",
  });
  const output = await createNode(env, { parentPath: "Goal", name: "Result", type: "output" });
  const server = await startUiServer({ workspaceRoot: root, staticDir: root, port: 0 });
  t.after(() => server.close());
  const url = new URL(server.url),
    endpoint = new URL(`/api/outputs/compare?nodeId=${output}`, url);
  const headers = { Authorization: `Bearer ${url.hash.slice("#token=".length)}` };
  const revision = await readWorkspaceRevision(tent),
    head = await tent.history.currentCommit();
  assert.equal((await fetch(endpoint)).status, 401);
  const read = async () => {
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await read(), [
    { nodeId: output, goals: [{ goalId: goal, state: "current" }], changedSince: [] },
  ]);
  await fs.writeFile(path.join(root, "direction.txt"), "second");
  assert.deepEqual(await read(), [
    {
      nodeId: output,
      goals: [{ goalId: goal, state: "changed" }],
      changedSince: [{ kind: "goal", nodeId: goal, name: "Goal" }],
    },
  ]);
  await fs.rm(path.join(root, "direction.txt"));
  assert.deepEqual(await read(), [
    { nodeId: output, goals: [{ goalId: goal, state: "unknown" }], changedSince: [] },
  ]);
  assert.equal(
    (await fetch(new URL("/api/outputs/compare?nodeId=node-missing", url), { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(new URL(`/api/outputs/compare?nodeId=${goal}`, url), { headers })).status,
    422,
  );
  assert.equal(await readWorkspaceRevision(tent), revision);
  assert.equal(await tent.history.currentCommit(), head);
});
