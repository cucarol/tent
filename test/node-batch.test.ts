import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prepareNodeBatch } from "../src/core/write/node-batch.js";
import { initializeFixtureWorkspace } from "./scratch.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { contentEtag } from "../src/core/base/etag.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

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
  return { workspace, adapter };
}

test("prepared batch returns each selected body without capturing", async (t) => {
  const { adapter } = await fixture(t);
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
  assert.equal((await prepared.read("node-bravo", "raw")).item.text, raw("node-bravo", body));
  assert.equal(await adapter.history.currentCommit(), null);
});

test("CLI creation returns a pointer while retaining the complete large document", async (t) => {
  const { workspace, adapter } = await fixture(t);
  const body = "x".repeat(40000);
  const created = await runNodeCommand("create", ["Large", "--type", "prompt", "--body", body], {
    workspace,
    json: true,
  });
  assert.equal(created.exitCode, 0, created.stderr);
  const pointer = JSON.parse(created.stdout).node;
  const saved = await adapter.readFile("Large/Large.md");
  assert.equal(pointer.path, ".tent/Large/Large.md");
  assert.equal(pointer.etag, contentEtag(saved));
  assert.equal("text" in pointer, false);
  assert.equal(parseFrontmatter(saved).body, body);
  const version = (await adapter.history.pathVersions("Large/Large.md")).latest!;
  assert.ok(version);
  assert.equal(await adapter.history.read(version), saved);
});
