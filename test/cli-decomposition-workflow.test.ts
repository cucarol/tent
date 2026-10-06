import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "cli-decomposition-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "CLI decomposition" });
  await git(path.join(workspace, ".tent"), "init");
  return {
    workspace,
    globals: { workspace, json: true },
    adapter: new NodeFs(path.join(workspace, ".tent")),
  };
}

test("CLI writes a mutually linked batch from stdin and rejects a failed mixed batch without saving", async (t) => {
  const { workspace, globals, adapter } = await fixture(t);
  const create = await runNodeCommand("write-many", ["--input-json", "-"], {
    ...globals,
    stdin: JSON.stringify({
      items: [
        {
          op: "create",
          ref: "child",
          parent: "@parent",
          name: "Child",
          type: "prompt",
          body: "[Parent](@parent)",
        },
        { op: "create", ref: "parent", name: "Parent", type: "goal", body: "[Child](@child)" },
      ],
    }),
  });
  assert.equal(create.exitCode, 0, create.stderr);
  const created = JSON.parse(create.stdout);
  assert.deepEqual(
    created.results.map((item: { path: string }) => item.path),
    ["Parent/Child", "Parent"],
  );
  assert.ok(
    created.results.every((item: { etag: string }) => item.etag && !item.etag.startsWith("read:")),
  );
  const systemRoot = path.join(workspace, ".tent");
  assert.equal((await git(systemRoot, "rev-list", "--count", "HEAD")).trim(), "1");
  const check = await runWorkspaceCommand("check", [], globals);
  assert.equal(check.exitCode, 0, check.stderr || check.stdout);
  assert.deepEqual(JSON.parse(check.stdout), { documents: 2, issues: [], notices: [], errors: [] });
  const parent = created.results[1];
  const complete = await runNodeCommand("get", [parent.nodeId, "--full"], globals);
  assert.equal(complete.exitCode, 0, complete.stderr);
  const original = await adapter.readFile("Parent/Parent.md");
  const head = await git(systemRoot, "rev-parse", "HEAD");
  const failed = await runNodeCommand("write-many", ["--input-json", "-"], {
    ...globals,
    stdin: JSON.stringify({
      items: [
        {
          op: "update",
          nodeId: parent.nodeId,
          baseEtag: JSON.parse(complete.stdout).node.etag,
          body: "would change",
        },
        { op: "create", ref: "broken", parent: "@unknown", name: "Broken", type: "prompt" },
      ],
    }),
  });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /unknown.*ref/i);
  assert.equal(await adapter.readFile("Parent/Parent.md"), original);
  assert.equal(await adapter.exists("Broken"), false);
  assert.equal(await git(systemRoot, "rev-parse", "HEAD"), head);
  const saved = await runNodeCommand(
    "write-many",
    [
      "--input-json",
      JSON.stringify({
        items: [
          {
            op: "update",
            nodeId: parent.nodeId,
            baseEtag: JSON.parse(complete.stdout).node.etag,
            body: "updated decision",
          },
        ],
      }),
    ],
    globals,
  );
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.equal((await git(systemRoot, "rev-list", "--count", "HEAD")).trim(), "2");
  assert.notEqual(JSON.parse(saved.stdout).results[0].etag, parent.etag);
});

test("workspace check reports all three problem kinds as JSON on stdout without touching files or Git", async (t) => {
  const { workspace, globals, adapter } = await fixture(t);
  const raw =
    "---\nid: node-broken\ntype: prompt\nresource: /../spec/invalid.md\nsources:\n  - resource: ../../missing.md\n  - resource: a discussion\n---\n[Missing](../Gone/Gone.md)\n";
  await adapter.writeFile("Broken/Broken.md", raw);
  await git(path.join(workspace, ".tent"), "add", "Broken/Broken.md");
  await git(
    path.join(workspace, ".tent"),
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  );
  const head = await git(path.join(workspace, ".tent"), "rev-parse", "HEAD");
  const status = await git(path.join(workspace, ".tent"), "status", "--porcelain");
  const result = await runWorkspaceCommand("check", [], globals);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.documents, 1);
  assert.deepEqual(report.issues.map((item: { kind: string }) => item.kind).sort(), [
    "invalid-material-address",
    "missing-material-file",
    "unresolved-link",
  ]);
  assert.deepEqual(report.errors, []);
  assert.equal(await adapter.readFile("Broken/Broken.md"), raw);
  assert.equal(await git(path.join(workspace, ".tent"), "rev-parse", "HEAD"), head);
  assert.equal(await git(path.join(workspace, ".tent"), "status", "--porcelain"), status);
  const rejected = await runWorkspaceCommand("check", ["--output", "unused"], globals);
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.stdout, "");
});
