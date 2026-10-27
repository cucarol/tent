import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { NodeFs } from "../src/fs/node-fs.js";
import { prepareNodeBatch } from "../src/core/write/node-batch.js";
import { captureReadDocuments } from "../src/core/store/document-history.js";
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
  test(`CLI read-many ${view} pages continue live without capture and reject changed files`, async (t) => {
    const { workspace, adapter, git } = await fixture(t);
    await adapter.writeFile("A/A.md", raw("node-alpha", "Retained body"));
    await adapter.writeFile("B/B.md", raw("node-bravo", "B"));
    await captureReadDocuments(adapter, [
      { path: "A/A.md", raw: await adapter.readFile("A/A.md") },
      { path: "B/B.md", raw: await adapter.readFile("B/B.md") },
    ]);
    const beforeHead = await adapter.history.currentCommit();
    const beforeRecords = await adapter.history.nodeRecords();
    const body = "😀\r\n正文".repeat(8000);
    const document = raw("node-alpha", body);
    const text = view === "body" ? body : document;
    await adapter.writeFile("A/A.md", document);
    const beforeFiles = await tentFiles(workspace);
    const options = { workspace, json: true };
    const result = await runNodeCommand(
      "read-many",
      ["node-alpha", "node-bravo", "--view", view],
      options,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const first = JSON.parse(result.stdout);
    assert.equal(first.agentContext, undefined);
    assert.ok(
      first.items.every((entry: { agentContext?: unknown }) => entry.agentContext === undefined),
    );
    assert.deepEqual(
      first.items.map((item: { nodeId: string }) => item.nodeId),
      ["node-alpha", "node-bravo"],
    );
    const item = first.items[0];
    assert.equal(first.source.kind, "live");
    assert.equal(item.source.kind, "live");
    assert.equal(item.version, undefined);
    assert.equal(item.uncaptured, true);
    assert.equal(first.items[1].uncaptured, undefined);
    assert.equal(item.page.hasMore, true);
    assert.match(item.etag, /^read:/);
    assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024 + 1);
    assert.equal(item.text, text.slice(0, item.range.end));

    const continuationArgs = [
      "node-alpha",
      "--view",
      view,
      "--expected-etag",
      item.etag,
      "--cursor",
      item.page.nextCursor,
    ];
    const continued = await runNodeCommand("get", continuationArgs, options);
    assert.equal(continued.exitCode, 0, continued.stderr);
    const continuation = JSON.parse(continued.stdout);
    assert.equal(continuation.agentContext, undefined);
    assert.equal(continuation.range.start, item.range.end);
    assert.equal(continuation.uncaptured, true);
    assert.equal(continuation.text, text.slice(continuation.range.start, continuation.range.end));
    assert.ok(Buffer.byteLength(continued.stdout) <= 16 * 1024 + 1);
    assert.equal(
      text.charCodeAt(continuation.range.start) >= 0xdc00 &&
        text.charCodeAt(continuation.range.start) <= 0xdfff,
      false,
    );
    assert.notEqual(text.slice(continuation.range.start - 1, continuation.range.start + 1), "\r\n");

    const invalidRange = await runNodeCommand(
      "get",
      [
        "node-alpha",
        "--view",
        view,
        "--expected-etag",
        item.etag,
        "--range",
        JSON.stringify({ unit: "utf16", start: text.indexOf("😀") + 1, end: text.length }),
      ],
      options,
    );
    assert.equal(invalidRange.exitCode, 1);
    assert.match(
      invalidRange.stderr,
      /Range must fit the source and preserve UTF-16\/CRLF boundaries/,
    );
    const wrongEtag = await runNodeCommand(
      "get",
      ["node-alpha", "--view", view, "--expected-etag", "read:" + "0".repeat(64)],
      options,
    );
    assert.equal(wrongEtag.exitCode, 1);
    assert.match(wrongEtag.stderr, /Node ETag changed/);
    const second = await runNodeCommand(
      "read-many",
      ["node-alpha", "node-bravo", "--start", "1", "--view", view],
      options,
    );
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).items[0].nodeId, "node-bravo");
    assert.deepEqual(await tentFiles(workspace), beforeFiles);
    assert.equal(await adapter.history.currentCommit(), beforeHead);
    assert.deepEqual(await adapter.history.nodeRecords(), beforeRecords);

    // Previously the CLI retained selected bytes and resumed a Git version after edits.
    // Pure reads now resume live bytes only: both the ETag and cursor reject stale offsets.
    const edited = raw("node-alpha", "Edited after the batch");
    await adapter.writeFile("A/A.md", edited);
    const editedFiles = await tentFiles(workspace);
    for (const args of [
      continuationArgs,
      ["node-alpha", "--view", view, "--cursor", item.page.nextCursor],
    ]) {
      const rejected = await runNodeCommand("get", args, options);
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr, /(?:Node ETag|Reader source) changed/);
      assert.match(rejected.stderr, /reread|restart/);
    }
    assert.deepEqual(
      await tentFiles(workspace),
      editedFiles,
      "rejected continuations do not assemble or create syntax cache",
    );
    const restarted = await runNodeCommand("get", ["node-alpha", "--view", view], options);
    assert.equal(restarted.exitCode, 0, restarted.stderr);
    assert.equal(
      JSON.parse(restarted.stdout).text,
      view === "body" ? "Edited after the batch" : edited,
    );
    assert.equal(!!JSON.parse(restarted.stdout).agentContext, view === "body");
    const restartedFiles = await tentFiles(workspace);
    if (view === "body") {
      // Only this first default body read assembles references and can persist parsed syntax.
      // read-many/raw/positive cursors above retain the complete earlier file snapshots.
      const syntax = path.join(".git", "tent-material-cache", "markdown-syntax.bin");
      assert.deepEqual(
        restartedFiles.filter((file) => file.path !== syntax),
        editedFiles.filter((file) => file.path !== syntax),
      );
    } else assert.deepEqual(restartedFiles, editedFiles);
    assert.equal(await adapter.history.currentCommit(), beforeHead);
    assert.deepEqual(await adapter.history.nodeRecords(), beforeRecords);
  });
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
