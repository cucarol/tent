import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { prepareNodeDocumentWrite, NodeWriteError } from "../src/core/node-document-write.js";
import { contentEtag } from "../src/core/etag.js";
import { incompleteNodeReadEtag } from "../src/core/node-read-basis.js";
import { materialCheck } from "../src/core/material-check.js";

async function fixture(t: TestContext, metadata = "") {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "node-complete-read-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await initializeTentWorkspace(workspace);
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  const body = "正文😀\n".repeat(8000) + "[Peer](../B/B.md)\n";
  const raw = `---\nid: node-alpha\ntype: prompt\n${metadata}---\n${body}`;
  await adapter.writeFile("A/A.md", raw);
  await adapter.writeFile("B/B.md", "---\nid: node-bravo\ntype: prompt\n---\nPeer");
  const globals = { workspace, json: true };
  const cli = async (sub: string, args: string[]) => {
    const result = await runNodeCommand(sub, args, globals);
    assert.equal(result.exitCode, 0, result.stderr);
    if (!args.includes("--full"))
      assert.ok(
        Buffer.byteLength(result.stdout) <= 16 * 1024 + 1,
        `${sub} must fit the CLI page budget`,
      );
    return JSON.parse(result.stdout);
  };
  return { adapter, raw, body, globals, cli };
}

function etags(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(etags);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    (key === "etag" || key === "expectedEtag" || key === "currentEtag") && typeof item === "string"
      ? [item]
      : key === "sources"
        ? []
        : etags(item),
  );
}

function assertIncomplete(value: unknown, raw: string) {
  const bases = etags(value);
  assert.ok(bases.length > 0, "read result must expose a usable continuation/metadata basis");
  for (const baseEtag of bases) {
    assert.equal(baseEtag, incompleteNodeReadEtag(contentEtag(raw)));
    for (const edit of [{ body: "partial" }, { raw: raw.slice(0, 100) }])
      assert.throws(
        () => prepareNodeDocumentWrite({ id: "node-alpha", path: "A" }, raw, { baseEtag, ...edit }),
        (error) => error instanceof NodeWriteError && error.code === "INCOMPLETE_READ",
      );
  }
}

test("a partial CLI Node read cannot silently replace the complete body", async (t) => {
  const { adapter, raw, globals, cli } = await fixture(t);
  const page = (await cli("get", ["node-alpha"])).node;
  assert.equal(page.partial, true);
  const write = await runNodeCommand(
    "write",
    ["node-alpha", "--body", page.text, "--base-etag", page.etag],
    globals,
  );
  assert.equal(write.exitCode, 1, "a partial read must not authorize whole-body replacement");
  assert.match(write.stderr, /incomplete.*read|partial.*read/i);
  assert.match(write.stderr, /--full/);
  assert.equal(await adapter.readFile("A/A.md"), raw);
});

test("every partial page and explicit range remains read-only while full reads permit replacement", async (t) => {
  const { adapter, raw, body, globals, cli } = await fixture(
    t,
    `description: ${"d".repeat(20000)}\nsources: [{resource: 'customer discussion', custom: {etag: keep, expectedEtag: keep}}]\n`,
  );
  const first = (await cli("get", ["node-alpha"])).node;
  assertIncomplete(first, raw);
  assert.ok(first.metadataRead);
  assert.deepEqual(first.sources[0].custom, { etag: "keep", expectedEtag: "keep" });
  let combined = first.text;
  let current = first;
  while (current.page.hasMore) {
    current = (
      await cli("get", [
        "node-alpha",
        "--cursor",
        current.page.nextCursor,
        "--expected-etag",
        current.page.next.expectedEtag,
      ])
    ).node;
    assertIncomplete(current, raw);
    combined += current.text;
  }
  assert.equal(current.partial, true, "the last page is still only a fragment");
  assert.equal(combined, body);
  for (const view of ["body", "raw"]) {
    const range = (
      await cli("get", [
        "node-alpha",
        "--view",
        view,
        "--range",
        JSON.stringify({ unit: "utf16", start: 0, end: 2 }),
      ])
    ).node;
    assert.equal(range.page.hasMore, false);
    assertIncomplete(range, raw);
  }
  const full = (await cli("get", ["node-alpha", "--full"])).node;
  assert.equal(full.text, body);
  assert.equal("body" in full, false);
  assert.equal(full.etag, contentEtag(raw));
  const fullRaw = (await cli("get", ["node-alpha", "--view", "raw", "--full"])).node;
  assert.equal(fullRaw.text, raw);
  assert.equal(fullRaw.partial, false);
  assert.equal(fullRaw.etag, contentEtag(raw));
  assert.equal(
    prepareNodeDocumentWrite({ id: "node-alpha", path: "A" }, raw, {
      baseEtag: fullRaw.etag,
      raw: fullRaw.text,
    }),
    raw,
  );
  const saved = await cli("write", [
    "node-alpha",
    "--body",
    "complete replacement",
    "--base-etag",
    full.etag,
  ]);
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).body, "complete replacement");
  assert.equal(saved.etag, contentEtag(await adapter.readFile("A/A.md")));
  const stale = await runNodeCommand(
    "get",
    ["node-alpha", "--cursor", first.page.nextCursor, "--expected-etag", first.etag],
    globals,
  );
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /changed/i);
  const historicalFirst = (
    await cli("get", [
      "node-alpha",
      "--version-json",
      JSON.stringify(first.version),
      "--expected-etag",
      first.etag,
    ])
  ).node;
  const frozen = (
    await cli("get", [
      "node-alpha",
      "--version-json",
      JSON.stringify(first.version),
      "--cursor",
      historicalFirst.page.nextCursor,
      "--expected-etag",
      first.etag,
    ])
  ).node;
  assertIncomplete(frozen, raw);
  assert.equal(frozen.range.start, historicalFirst.range.end);
});

test("batch, create, read-back and excerpt outputs expose no unrestricted replacement basis", async (t) => {
  const { adapter, raw, body, cli } = await fixture(t);
  const batch = await cli("read-many", ["node-alpha", "node-bravo"]);
  assertIncomplete(batch.items[0], raw);
  assert.equal(batch.items[1].partial, false);
  const search = await cli("search", ["正文"]);
  assertIncomplete(
    search.items.find((item: { nodeId: string }) => item.nodeId === "node-alpha"),
    raw,
  );
  const backlinks = await cli("backlinks", ["node-bravo"]);
  assertIncomplete(backlinks.items[0], raw);
  const full = (await cli("get", ["node-alpha", "--full"])).node;
  const saved = await cli("write", [
    "node-alpha",
    "--body",
    body,
    "--base-etag",
    full.etag,
    "--read-back",
  ]);
  assert.equal(saved.readBack.partial, true);
  assertIncomplete(saved, await adapter.readFile("A/A.md"));
  const created = (await cli("create", ["Large", "--type", "prompt", "--body", body])).node;
  const createdRaw = await adapter.readFile("Large/Large.md");
  assert.equal(created.partial, true);
  assertIncomplete(created, createdRaw);
});

test("incomplete bases support metadata-only edits and retain revision conflict detection", async (t) => {
  const { adapter, raw, body, globals, cli } = await fixture(t);
  const page = (await cli("get", ["node-alpha"])).node;
  const material = {
    resource: "../B/B.md",
    canonicalPath: await fs.realpath(path.join(globals.workspace, ".tent/B/B.md")),
    observedVersion: createHash("sha256")
      .update(await adapter.readFile("B/B.md"))
      .digest("hex"),
  };
  await materialCheck(
    adapter,
    {
      action: "confirm",
      nodeId: "node-alpha",
      expectedPath: "A",
      expectedEtag: page.etag,
      materials: [material],
    },
    async () => material,
  );
  const checked = await cli("check", ["node-alpha"]);
  assert.equal(checked.state, "current");
  assertIncomplete(checked, raw);
  const saved = await cli("write", [
    "node-alpha",
    "--input-json",
    JSON.stringify({
      baseEtag: page.etag,
      frontmatter: { description: "reviewed" },
    }),
  ]);
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).body, body);
  assertIncomplete(saved, await adapter.readFile("A/A.md"));
  const typed = await cli("type", ["node-alpha", "output", "--base-etag", saved.etag]);
  assertIncomplete(typed, await adapter.readFile("A/A.md"));
  const tagged = await cli("tags", ["add", "node-alpha", "reviewed", "--base-etag", typed.etag]);
  assertIncomplete(tagged, await adapter.readFile("A/A.md"));
  const stale = await runNodeCommand(
    "write",
    [
      "node-alpha",
      "--input-json",
      JSON.stringify({
        baseEtag: page.etag,
        frontmatter: { description: "stale" },
      }),
    ],
    globals,
  );
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /conflict/i);
  const conflict = JSON.parse(stale.stderr.split("\n")[1]!);
  assert.equal(
    conflict.currentEtag,
    incompleteNodeReadEtag(contentEtag(await adapter.readFile("A/A.md"))),
  );
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).body, body);
  assert.notEqual(await adapter.readFile("A/A.md"), raw);
});

test("complete bounded body and raw reads retain their ordinary replacement basis", async (t) => {
  const { adapter, cli } = await fixture(t);
  const raw = await adapter.readFile("B/B.md");
  for (const view of ["body", "raw"]) {
    const node = (await cli("get", ["node-bravo", "--view", view])).node;
    assert.equal(node.partial, false);
    assert.equal(node.etag, contentEtag(raw));
    assert.doesNotThrow(() =>
      prepareNodeDocumentWrite({ id: "node-bravo", path: "B" }, raw, {
        baseEtag: node.etag,
        body: "complete",
      }),
    );
  }
});
