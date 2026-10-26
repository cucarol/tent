import { openTestService } from "./node-fs.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { isHistoryFile } from "../src/core/store/document-history.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeFs } from "../src/fs/node-fs.js";
import type { DocumentVersion } from "../src/core/store/history-port.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { readNodeTimes } from "../src/core/read/node-times.js";
import { startUiServer } from "../src/ui-server/server.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

const stamp = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-times-"));
  t.after(async () => {
    await adapter.close();
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await initializeFixtureWorkspace(root);
  const adapter = openTestFs(path.join(root, ".tent"));
  const save = (name: string, data: Record<string, unknown>, body = "Rule") =>
    adapter.writeFile(`${name}/${path.posix.basename(name)}.md`, serializeFrontmatter(data, body));
  const commit = async (n: number) => {
    const files: string[] = [];
    async function visit(directory: string) {
      for (const entry of await adapter.listDir(directory)) {
        const file = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDir) {
          if (![".git", "temp"].includes(entry.name)) await visit(file);
        } else if (isHistoryFile(file)) files.push(file);
      }
    }
    await visit("");
    const retained = (await adapter.retainedDocumentPaths()) ?? [];
    const changes = await Promise.all(
      [...new Set([...retained, ...files])].map(async (file) => ({
        path: file,
        raw: files.includes(file) ? await adapter.readFile(file) : null,
      })),
    );
    const saved = await adapter.withLock("mutation.lock", () =>
      adapter.history.captureUnlocked(changes, { operation: "test.timestamp-fixture" }),
    );
    const db = new DatabaseSync(path.join(root, ".tent/.git/history.sqlite"));
    try {
      db.prepare("UPDATE events SET time=? WHERE id=?").run(stamp(n), saved.commit!);
    } finally {
      db.close();
    }
  };
  return { root, adapter, save, commit };
}

test("content time ignores confirmation and metadata, tracks body/address edits and retained reverts", async (t) => {
  const { adapter, save, commit } = await fixture(t);
  const base = { id: "node-rule", type: "prompt", resource: "../../a.txt" };
  const out = { id: "node-out", type: "output", generated: { by: "test/1", at: stamp(1) } };
  await save("Rule", base);
  await save("Out", out, "Conclusion");
  await commit(1);
  const read = () => readNodeTimes(adapter, ["node-rule", "node-out", "node-rule"]);
  assert.deepEqual(await read(), [
    { nodeId: "node-rule", contentChangedAt: stamp(1), recordedAt: null },
    { nodeId: "node-out", contentChangedAt: stamp(1), recordedAt: stamp(1) },
  ]);
  await save("Rule", {
    ...base,
    description: "metadata",
    tags: ["spec"],
    status: "draft",
    generated: { by: "test/1", at: stamp(2) },
    verified: [{ by: "human:reader", at: stamp(2) }],
  });
  await save(
    "Out",
    { ...out, verified: [{ by: "human:reader", at: "2026-01-02T08:00:00+08:00" }] },
    "Conclusion",
  );
  await commit(2);
  assert.deepEqual(await read(), [
    { nodeId: "node-rule", contentChangedAt: stamp(1), recordedAt: null },
    { nodeId: "node-out", contentChangedAt: stamp(1), recordedAt: stamp(2) },
  ]);
  await save("Rule", base, "New rule");
  await commit(3);
  assert.equal((await read())[0]!.contentChangedAt, stamp(3));
  await save("Rule", { ...base, resource: "../../b.txt" }, "New rule");
  await commit(4);
  assert.equal((await read())[0]!.contentChangedAt, stamp(4));
  await save("Rule", base);
  await commit(5);
  assert.equal((await read())[0]!.contentChangedAt, stamp(5));
  const head = await adapter.history.currentCommit();
  const index = await fs.readFile(path.join(adapter.workspaceRoot!, ".tent/.git/history.sqlite"));
  await save("Rule", base, "Uncaptured body");
  assert.equal((await read())[0]!.contentChangedAt, null);
  assert.equal((await read())[1]!.contentChangedAt, stamp(1));
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(
    await fs.readFile(path.join(adapter.workspaceRoot!, ".tent/.git/history.sqlite")),
    index,
  );
  await save("Rule", base);
  assert.equal((await read())[0]!.contentChangedAt, stamp(5));
});

test("recorded time preserves valid confirmations beside invalid native declarations", async (t) => {
  const { adapter, save, commit } = await fixture(t);
  const base = { id: "node-out", type: "output", generated: { by: "test/1", at: stamp(1) } };
  await save("Out", base);
  await commit(4);
  const head = await adapter.history.currentCommit();
  for (const verified of [
    [
      { by: "human:a", at: stamp(3) },
      { by: "human:b", at: "not-a-timestamp" },
    ],
    [null, { by: "human:a", at: stamp(3) }, { by: "invalid", at: stamp(9) }],
    [[{ by: "human:nested", at: stamp(9) }], { by: "human:a", at: stamp(3) }],
    { by: "human:a", at: "2026-01-03T08:00:00+08:00" },
  ]) {
    await save("Out", { ...base, verified });
    assert.deepEqual(await readNodeTimes(adapter, ["node-out"]), [
      { nodeId: "node-out", contentChangedAt: stamp(4), recordedAt: stamp(3) },
    ]);
  }
  await save("Out", { ...base, verified: [null, { by: "human:a", at: "bad" }] });
  assert.equal((await readNodeTimes(adapter, ["node-out"]))[0]!.recordedAt, stamp(1));
  assert.equal(await adapter.history.currentCommit(), head);
});

test("moves and canonical address rewrites retain content times across historical identities", async (t) => {
  const { adapter, save, commit } = await fixture(t);
  await save("Target", { id: "node-target", type: "goal" });
  await save(
    "Rule",
    {
      id: "node-rule",
      type: "prompt",
      sources: [{ resource: "../Target/Target.md" }],
      resource: "../../file.txt",
    },
    "See [target](../Target/Target.md)",
  );
  await commit(1);
  await adapter.remove("Target");
  await save("Moved", { id: "node-target", type: "goal" });
  await save(
    "Rule",
    {
      id: "node-rule",
      type: "prompt",
      sources: [{ resource: "../Moved/Moved.md" }],
      resource: "../../file.txt",
    },
    "See [target](../Moved/Moved.md)",
  );
  await commit(2);
  assert.ok(
    (await readNodeTimes(adapter, ["node-rule", "node-target"])).every(
      (x) => x.contentChangedAt === stamp(1),
    ),
  );
  await save("Parent", { id: "node-parent", type: "goal" });
  await adapter.remove("Rule");
  await save(
    "Parent/Rule",
    {
      id: "node-rule",
      type: "prompt",
      sources: [{ resource: "../../Moved/Moved.md" }],
      resource: "../../../file.txt",
    },
    "See [target](../../Moved/Moved.md)",
  );
  await commit(3);
  assert.equal((await readNodeTimes(adapter, ["node-rule"]))[0]!.contentChangedAt, stamp(1));
});

test("missing or partial history cannot invent times or discard another Node's readable history", async (t) => {
  const { adapter, save, commit } = await fixture(t);
  await save("A", { id: "node-a", type: "prompt" });
  await save("B", { id: "node-b", type: "output", generated: { by: "test/1", at: stamp(1) } });
  await commit(1);
  const real = adapter.history.readVersions.bind(adapter.history);
  t.mock.method(adapter.history, "readVersions", async (versions: readonly DocumentVersion[]) =>
    (await real(versions)).map((row, i) =>
      versions[i]!.path === "A/A.md" ? new Error("unreadable historical blob") : row,
    ),
  );
  assert.deepEqual(await readNodeTimes(adapter, ["node-a", "node-b"]), [
    { nodeId: "node-a", contentChangedAt: null, recordedAt: null },
    { nodeId: "node-b", contentChangedAt: stamp(1), recordedAt: stamp(1) },
  ]);
  t.mock.method(adapter.history, "changesInRange", async () => {
    throw new Error("unavailable history");
  });
  assert.deepEqual(await readNodeTimes(adapter, ["node-b"]), [
    { nodeId: "node-b", contentChangedAt: null, recordedAt: stamp(1) },
  ]);
  assert.deepEqual(await readNodeTimes(adapter, []), []);
  await assert.rejects(readNodeTimes(adapter, ["../A"]), /canonical Node/);
  await assert.rejects(readNodeTimes(adapter, ["node-missing"]), /Node not found/);
});

test("time HTTP query is authenticated, selected, fresh for native edits and read-only", async (t) => {
  const { root, adapter, save, commit } = await fixture(t);
  await save("Rule", { id: "node-rule", type: "prompt" });
  await commit(1);
  const server = await openTestService({ workspaceRoot: root, staticDir: root, port: 0 });
  t.after(() => server.close());
  const url = new URL(server.url);
  const endpoint = new URL("/api/nodes/times?nodeId=node-rule", url);
  const headers = { Authorization: `Bearer ${url.hash.slice("#token=".length)}` };
  assert.equal((await fetch(endpoint)).status, 401);
  const read = async () => {
    const res = await fetch(endpoint, { headers });
    assert.equal(res.status, 200);
    return res.json();
  };
  assert.deepEqual(await read(), [
    { nodeId: "node-rule", contentChangedAt: stamp(1), recordedAt: null },
  ]);
  const head = await adapter.history.currentCommit();
  await save("Rule", { id: "node-rule", type: "prompt" }, "Edited natively");
  assert.deepEqual(await read(), [
    { nodeId: "node-rule", contentChangedAt: null, recordedAt: null },
  ]);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal((await fetch(new URL("/api/nodes/times?nodeId=bad", url), { headers })).status, 422);
  assert.equal(
    (await fetch(new URL("/api/nodes/times?nodeId=node-missing", url), { headers })).status,
    404,
  );
  assert.equal(
    await adapter.readFile("Rule/Rule.md"),
    serializeFrontmatter({ id: "node-rule", type: "prompt" }, "Edited natively"),
  );
});
