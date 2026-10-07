import { readNodeForEdit, readNode } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { readWorkspaceSettings } from "../src/core/workspace-settings.js";
import { git } from "./helpers.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "everyday-workflow-"));
  const workspace = path.join(root, "graph");
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "context",
    nodes: [{ id: "node-rule", name: "Import", type: "prompt", body: "Confirmed rule" }],
  });
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  await git(path.join(workspace, ".tent"), "init");
  const { workspaceId: savedId } = await readWorkspaceSettings(adapter),
    workspaceId = savedId!;
  const globals = { workspace, cwd: root, env: {}, json: true },
    edit = () => readNodeForEdit(adapter, "node-rule");
  return { root, workspace, workspaceId, adapter, globals, edit };
}

function parsed(result: { exitCode: number; stdout: string; stderr: string }) {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("one CLI write saves body and references with same-revision readback, preserving metadata and CAS", async (t) => {
  const { adapter, workspaceId, globals, edit } = await fixture(t);
  await writeNodeDocument(adapter, "node-rule", {
    baseEtag: (await edit()).etag,
    frontmatter: { custom: { preserve: true } },
  });
  const before = await edit();
  const refs = [
    { resource: "https://example.org/z", title: "original" },
    { resource: "https://example.org/a", title: "reference" },
  ];
  const input = {
    baseEtag: before.etag,
    body: "Confirmed local-only rule\n",
    frontmatter: { sources: refs },
    readBack: true,
  };
  const saved = parsed(
    await runNodeCommand("write", ["node-rule", "--input-json", "-"], {
      ...globals,
      stdin: JSON.stringify(input),
    }),
  );
  const after = await edit();
  assert.equal(saved.etag, after.etag);
  assert.equal(saved.readBack.etag, after.etag);
  assert.equal(saved.readBack.text, after.body);
  assert.equal(saved.readBack.partial, false);
  assert.deepEqual(saved.readBack.sources, after.frontmatter.sources);
  assert.equal(saved.readBack.sources.length, 2);
  assert.deepEqual(after.frontmatter.custom, { preserve: true });
  assert.equal(after.frontmatter.type, "prompt");
  assert.ok(saved.version);
  assert.ok(Buffer.byteLength(JSON.stringify(saved.readBack)) <= 16 * 1024);

  const conflict = await runNodeCommand(
    "write",
    [
      "node-rule",
      "--input-json",
      JSON.stringify({ ...input, body: "stale", frontmatter: { sources: [] } }),
    ],
    globals,
  );
  assert.equal(conflict.exitCode, 1);
  assert.match(conflict.stderr, /etag conflict/);
  assert.equal(
    (await edit()).raw,
    after.raw,
    "body and references must both remain unchanged on stale CAS",
  );
  for (const illegal of [
    { ...input, baseEtag: after.etag, type: "output" },
    { ...input, baseEtag: after.etag, readBack: "yes" },
  ]) {
    assert.equal(
      (
        await runNodeCommand(
          "write",
          ["node-rule", "--input-json", JSON.stringify(illegal)],
          globals,
        )
      ).exitCode,
      1,
    );
    assert.equal((await edit()).raw, after.raw);
  }
  const bodyOnly = parsed(
    await runNodeCommand(
      "write",
      ["node-rule", "--body", "New finding", "--base-etag", after.etag, "--read-back"],
      globals,
    ),
  );
  assert.deepEqual(
    bodyOnly.readBack.sources,
    after.frontmatter.sources,
    "omitted sources are preserved",
  );
  const defaults = (await writeNodeDocument(adapter, "node-rule", {
    baseEtag: bodyOnly.etag,
    body: "metadata-only reply",
  })) as Record<string, unknown>;
  assert.ok(!("readBack" in defaults));
});

test("saved readback is bounded, continues with the common reader and rejects later bytes", async (t) => {
  const { globals, edit, adapter, workspaceId } = await fixture(t);
  const body = "中文😀\r\n".repeat(5000);
  const saved = parsed(
    await runNodeCommand("write", ["node-rule", "--input-json", "-"], {
      ...globals,
      stdin: JSON.stringify({ baseEtag: (await edit()).etag, body, readBack: true }),
    }),
  );
  assert.ok(saved.readBack.partial);
  assert.ok(saved.readBack.page.hasMore);
  let joined = saved.readBack.text,
    page = saved.readBack;
  while (page.page.hasMore) {
    const result = parsed(
      await runNodeCommand(
        "get",
        ["node-rule", "--expected-etag", saved.etag, "--cursor", page.page.nextCursor],
        globals,
      ),
    );
    page = result.node;
    joined += page.text;
  }
  const complete = await edit();
  assert.equal(joined, complete.body);
  assert.equal(joined, body);
  await writeNodeDocument(adapter, "node-rule", {
    baseEtag: complete.etag,
    body: "concurrent change",
  });
  const stale = await runNodeCommand(
    "get",
    ["node-rule", "--expected-etag", saved.etag, "--cursor", saved.readBack.page.nextCursor],
    globals,
  );
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /ETag changed|source changed/i);
  const current = await edit();
  assert.equal(
    (
      await runNodeCommand(
        "write",
        [
          "node-rule",
          "--input-json",
          JSON.stringify({ baseEtag: current.etag, body: "must not write", readBack: "yes" }),
        ],
        globals,
      )
    ).exitCode,
    1,
  );
  assert.equal((await edit()).raw, current.raw);
});

test("workspace export help has no discovery or file effects", async () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = await runWorkspaceCommand("export", args, { workspace: "missing-fixture" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /--output/);
  }
});
