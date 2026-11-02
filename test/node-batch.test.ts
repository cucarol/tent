import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { prepareNodeBatch } from "../src/core/write/node-batch.js";
import { initializeFixtureWorkspace } from "./scratch.js";
import { runNodeCommand } from "../src/cli/node-commands.js";

const raw = (id: string, body: string) => `---\nid: ${id}\ntype: prompt\n---\n${body}`;
async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-batch-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const workspace = path.join(root, "workspace");
  await initializeFixtureWorkspace(workspace);
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)("git", ["-C", path.join(workspace, ".tent"), ...args], {
        windowsHide: true,
      })
    ).stdout.trim();
  return { workspace, adapter, git };
}

async function tentFiles(workspace: string) {
  const root = path.join(workspace, ".tent");
  // SPEC permits these disposable caches on ordinary reads, including errors.
  // They are not document captures; all other bytes and mtimes stay fixed.
  const derivedCaches = new Set([
    path.join(".git", "tent-history-index.json"),
    path.join(".git", "tent-material-cache", "document-headers.bin"),
    path.join(".git", "tent-material-cache", "file-state.json"),
    path.join(".git", "tent-material-cache", "semantic-content.bin"),
  ]);
  const files: Array<{ path: string; sha256: string; mtimeMs: number }> = [];
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        if (derivedCaches.has(path.relative(root, file))) continue;
        const stat = await fs.stat(file);
        files.push({
          path: path.relative(root, file),
          sha256: createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex"),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  await visit(root);
  return files;
}

test("prepared batch returns each selected body without capturing", async (t) => {
  const { adapter, git } = await fixture(t);
  const body = "😀\r\n正文".repeat(8000);
  await adapter.writeFile("A/A.md", raw("node-alpha", "Short A"));
  await adapter.writeFile("B/B.md", raw("node-bravo", body));
  await adapter.writeFile("C/C.md", raw("node-charlie", "Short C"));
  const ids = ["node-alpha", "node-bravo", "node-charlie"];
  const prepared = await prepareNodeBatch(adapter, "ws-batch");
  const ordinary = {
    items: await Promise.all(ids.map(async (id) => (await prepared.read(id, "body")).item)),
  };
  assert.deepEqual(
    ordinary.items.map((item) => item.nodeId),
    ids,
  );
  assert.ok("text" in ordinary.items[1]!);
  assert.equal(ordinary.items[1]!.text, body);
  assert.equal(await adapter.history.currentCommit(), null);
});

for (const view of ["body", "raw"] as const) {
}

test("CLI summaries and creation responses stay bounded for large documents", async (t) => {
  const { workspace, adapter } = await fixture(t);
  await adapter.writeFile(
    "A/A.md",
    `---\nid: node-alpha\ntype: prompt\ntags: ${JSON.stringify(Array.from({ length: 500 }, (_, i) => `tag-${i}-${"d".repeat(80)}`))}\n---\nShort body`,
  );
  const summary = await runNodeCommand("get", ["node-alpha", "--view", "summary"], {
    workspace,
    json: true,
  });
  assert.equal(summary.exitCode, 0, summary.stderr);
  assert.ok(Buffer.byteLength(summary.stdout) <= 16 * 1024 + 1);
  const metadata = JSON.parse(summary.stdout);
  assert.equal(metadata.tagsTruncated, true);
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
