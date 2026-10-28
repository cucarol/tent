import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { git } from "./helpers.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "cli-decomposition-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(workspace), { name: "CLI decomposition" });
  await initializeFixtureHistory(path.join(workspace, ".tent"));
  return {
    workspace,
    globals: { workspace, json: true },
    adapter: openTestFs(path.join(workspace, ".tent")),
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
    [".tent/Parent/Child/Child.md", ".tent/Parent/Parent.md"],
  );
  assert.ok(
    created.results.every((item: { etag: string }) => item.etag && !item.etag.startsWith("read:")),
  );
  const systemRoot = path.join(workspace, ".tent");
  assert.equal((await adapter.history.changesInRange()).length, 1);
  const check = await runWorkspaceCommand("check", [], globals);
  assert.equal(check.exitCode, 0, check.stderr || check.stdout);
  assert.deepEqual(JSON.parse(check.stdout), { documents: 2, issues: [], notices: [], errors: [] });
  const parent = created.results[1];
  const complete = await runNodeCommand("get", [parent.nodeId, "--full"], globals);
  assert.equal(complete.exitCode, 0, complete.stderr);
  const original = await adapter.readFile("Parent/Parent.md");
  const head = await historyHead(systemRoot);
  const failed = await runNodeCommand("write-many", ["--input-json", "-"], {
    ...globals,
    stdin: JSON.stringify({
      items: [
        {
          op: "update",
          nodeId: parent.nodeId,
          baseEtag: JSON.parse(complete.stdout).etag,
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
  assert.equal(await historyHead(systemRoot), head);
  const saved = await runNodeCommand(
    "write-many",
    [
      "--input-json",
      JSON.stringify({
        items: [
          {
            op: "update",
            nodeId: parent.nodeId,
            baseEtag: JSON.parse(complete.stdout).etag,
            body: "updated decision",
          },
        ],
      }),
    ],
    globals,
  );
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.equal((await adapter.history.changesInRange()).length, 2);
  assert.notEqual(JSON.parse(saved.stdout).results[0].etag, parent.etag);
});

test("workspace check reports all three problem kinds as JSON on stdout without touching files or Git", async (t) => {
  const { workspace, globals, adapter } = await fixture(t);
  const raw =
    "---\nid: node-broken\ntype: prompt\nresource: /../spec/invalid.md\nsources:\n  - resource: ../../missing.md\n  - resource: a discussion\n---\n[Missing](../Gone/Gone.md)\n";
  await adapter.writeFile("Broken/Broken.md", raw);
  await adapter.history.captureUnlocked([{ path: "Broken/Broken.md", raw }], {
    operation: "document.external-capture",
  });
  const head = await historyHead(path.join(workspace, ".tent"));
  const db = await fs.readFile(path.join(workspace, ".tent/.git/history.sqlite"));
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
  assert.equal(await historyHead(path.join(workspace, ".tent")), head);
  assert.deepEqual(await fs.readFile(path.join(workspace, ".tent/.git/history.sqlite")), db);
  const rejected = await runWorkspaceCommand("check", ["--output", "unused"], globals);
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.stdout, "");
});

test("workspace check reuses native discovery and observes later native edits", async (t) => {
  const { workspace, globals, adapter } = await fixture(t);
  const documents = [
    {
      path: "Target/Target.md",
      raw: serializeFrontmatter(
        { id: "node-target", type: "prompt", status: "deprecated" },
        "Target",
      ),
    },
    {
      path: "Owner/Owner.md",
      raw: serializeFrontmatter(
        {
          id: "node-owner",
          type: "prompt",
          status: "draft",
          sources: Array.from({ length: 8 }, () => ({ resource: "../Target/Target.md" })),
        },
        "[target](node-target)",
      ),
    },
  ];
  for (const document of documents) await adapter.writeFile(document.path, document.raw);
  await adapter.history.captureUnlocked(documents, { operation: "document.external-capture" });
  const directories = new Map<string, number>();
  const listDir = NodeFs.prototype.listDir;
  t.mock.method(NodeFs.prototype, "listDir", async function (this: NodeFs, dir: string) {
    directories.set(dir, (directories.get(dir) ?? 0) + 1);
    return listDir.call(this, dir);
  });
  const check = () => runWorkspaceCommand("check", [], globals);
  const first = await check();
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  assert.deepEqual(JSON.parse(first.stdout), { documents: 2, issues: [], notices: [], errors: [] });
  assert.equal(directories.get("Target"), 1);
  assert.equal(directories.get("Owner"), 1);
  const head = await historyHead(path.join(workspace, ".tent"));
  const owner = documents[1]!;
  const file = path.join(workspace, ".tent", owner.path);
  await fs.writeFile(file, owner.raw.replace("[target](node-target)", "[missing](node-missing)"));
  const edited = await check();
  assert.equal(edited.exitCode, 1, edited.stderr);
  assert.deepEqual(
    JSON.parse(edited.stdout).issues.map((issue: { kind: string }) => issue.kind),
    ["unresolved-link"],
  );
  assert.notEqual(await historyHead(path.join(workspace, ".tent")), head);
  await fs.writeFile(file, owner.raw);
  assert.equal((await check()).stdout, first.stdout);
  await fs.writeFile(file, owner.raw.replace("node-owner", "node-renamed"));
  const invalid = await check();
  assert.equal(invalid.exitCode, 1, invalid.stderr);
  assert.ok(
    JSON.parse(invalid.stdout).errors.some(
      (error: { path: string }) => error.path === ".tent/Owner/Owner.md",
    ),
  );
});
