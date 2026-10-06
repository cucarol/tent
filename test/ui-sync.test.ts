import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { confirmNodeSync } from "../src/core/node-sync.js";
import { inspectCurrentContext, makeContextBrief } from "../src/core/context-brief.js";
import { readWorkspaceRevision } from "../src/core/workspace-revision.js";
import { startUiServer } from "../src/ui-server/server.js";
import { testScratchRoot } from "./scratch.js";

test("sync reads changed materials without a revision change and agrees with brief on both flags", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeTentWorkspace(root);
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
  const brief = makeContextBrief(await inspectCurrentContext(tent, root));
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
