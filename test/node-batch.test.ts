import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeFs } from "../src/fs/node-fs.js";
import { prepareNodeBatch, readNodeBatch } from "../src/core/node-batch.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { runNodeCommand } from "../src/cli/node-commands.js";

const raw = (id: string, body: string) => `---\nid: ${id}\ntype: prompt\n---\n${body}`;
async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const workspace = path.join(root, "workspace");
  await initializeTentWorkspace(workspace);
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)("git", ["-C", path.join(workspace, ".tent"), ...args], {
        windowsHide: true,
      })
    ).stdout.trim();
  return { workspace, adapter, git };
}

test("Core batch returns every selected body and captures only on explicit request", async (t) => {
  const { adapter, git } = await fixture(t);
  const body = "😀\r\n正文".repeat(8000);
  await adapter.writeFile("A/A.md", raw("node-alpha", "Short A"));
  await adapter.writeFile("B/B.md", raw("node-bravo", body));
  await adapter.writeFile("C/C.md", raw("node-charlie", "Short C"));
  const ids = ["node-alpha", "node-bravo", "node-charlie"];
  const ordinary = await readNodeBatch(adapter, "ws-batch", { nodeIds: ids });
  assert.deepEqual(
    ordinary.items.map((item) => item.nodeId),
    ids,
  );
  assert.ok("text" in ordinary.items[1]!);
  assert.equal(ordinary.items[1]!.text, body);
  await assert.rejects(git("rev-parse", "--verify", "HEAD"));
  const retained = await readNodeBatch(adapter, "ws-batch", { nodeIds: ids, capture: true });
  assert.deepEqual(
    retained.items.map((item) => ("version" in item ? item.version?.path : undefined)),
    ["A/A.md", "B/B.md", "C/C.md"],
  );
  assert.equal(await git("rev-list", "--count", "HEAD"), "1");
});

test("CLI read-many returns a bounded page in machine mode", async (t) => {
  const { workspace, adapter } = await fixture(t);
  await adapter.writeFile("A/A.md", raw("node-alpha", "A".repeat(40000)));
  await adapter.writeFile("B/B.md", raw("node-bravo", "B"));
  const result = await runNodeCommand("read-many", ["node-alpha", "node-bravo"], {
    workspace,
    json: true,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const first = JSON.parse(result.stdout);
  assert.deepEqual(
    first.items.map((item: { nodeId: string }) => item.nodeId),
    ["node-alpha", "node-bravo"],
  );
  assert.equal(first.items[0].page.hasMore, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024 + 1);
  await adapter.writeFile("A/A.md", raw("node-alpha", "Edited after the batch"));
  const continued = await runNodeCommand(
    "get",
    [
      "node-alpha",
      "--version-json",
      JSON.stringify(first.items[0].version),
      "--cursor",
      first.items[0].page.nextCursor,
    ],
    { workspace, json: true },
  );
  assert.equal(continued.exitCode, 0, continued.stderr);
  const continuation = JSON.parse(continued.stdout);
  assert.equal(continuation.range.start, first.items[0].range.end);
  assert.ok(/^A+$/.test(continuation.text));
  const second = await runNodeCommand("read-many", ["node-alpha", "node-bravo", "--start", "1"], {
    workspace,
    json: true,
  });
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).items[0].nodeId, "node-bravo");
});

test("prepared batch capture retains the exact bytes selected before an external edit", async (t) => {
  const { adapter } = await fixture(t);
  const original = raw("node-alpha", "observed");
  await adapter.writeFile("A/A.md", original);
  const prepared = await prepareNodeBatch(adapter, "ws-batch");
  const selected = await prepared.read("node-alpha", "body");
  await adapter.writeFile("A/A.md", raw("node-alpha", "changed later"));
  const [captured] = await prepared.capture([selected]);
  assert.equal(captured!.text, "observed");
  assert.equal(await adapter.history.read(captured!.version!), original);
});

test("CLI summaries and creation responses stay bounded for large documents", async (t) => {
  const { workspace, adapter } = await fixture(t);
  await adapter.writeFile(
    "A/A.md",
    `---\nid: node-alpha\ntype: prompt\ndescription: ${"d".repeat(40000)}\n---\nShort body`,
  );
  const summary = await runNodeCommand("get", ["node-alpha", "--view", "summary"], {
    workspace,
    json: true,
  });
  assert.equal(summary.exitCode, 0, summary.stderr);
  assert.ok(Buffer.byteLength(summary.stdout) <= 16 * 1024 + 1);
  const metadata = JSON.parse(summary.stdout);
  assert.equal(metadata.descriptionTruncated, true);
  assert.equal(metadata.metadataRead.nodeId, "node-alpha");
  const created = await runNodeCommand(
    "create",
    ["Large", "--type", "prompt", "--body", "x".repeat(40000)],
    { workspace, json: true },
  );
  assert.equal(created.exitCode, 0, created.stderr);
  assert.ok(Buffer.byteLength(created.stdout) <= 16 * 1024 + 1);
  const body = JSON.parse(created.stdout).node;
  assert.equal(body.page.hasMore, true);
  assert.ok(body.version);
});
