import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory, testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { nodeHelpText, runNodeCommand } from "../src/cli/node-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-cli-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(root, {
    name: "Node commands",
    nodes: [{ id: "node-parent", name: "Parent", type: "goal", body: "Parent body" }],
  });
  const tent = openTestFs(path.join(root, ".tent"));
  await initializeFixtureHistory(path.join(root, ".tent"));
  const cli = async (sub: string, args: string[], stdin?: string) => {
    const result = await runNodeCommand(sub, args, { workspace: root, json: true, stdin });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const read = async (file: string) =>
    parseFrontmatter(await fs.readFile(path.join(root, file), "utf8"));
  return { root, tent, cli, read };
}

test("create stores description, repeated sources and stdin under the selected parent", async (t) => {
  const { root, cli, read } = await fixture(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs/spec.md"), "# Part\nFacts");
  const created = (
    await cli(
      "create",
      [
        "Child",
        "--id",
        "node-child",
        "--parent",
        "node-parent",
        "--type",
        "output",
        "--description",
        "Reusable facts.",
        "--body",
        "-",
        "--resource",
        "docs/spec.md#Part",
        "--source",
        "docs/spec.md",
        "--source",
        "customer discussion",
        "--tags",
        "evidence,ui",
      ],
      "Exact body\n",
    )
  ).node;
  assert.equal(created.nodeId, "node-child");
  assert.equal(created.path, ".tent/Parent/Child/Child.md");
  const saved = await read(created.path);
  assert.equal(saved.body, "Exact body\n");
  assert.equal(saved.data.description, "Reusable facts.");
  assert.equal(saved.data.resource, "../../../docs/spec.md#Part");
  assert.deepEqual(saved.data.sources, [
    { resource: "../../../docs/spec.md" },
    { resource: "customer discussion" },
  ]);
  assert.deepEqual(saved.data.tags, ["evidence", "ui"]);
});

test("create validates identity, parent and safe names before publishing a Node", async (t) => {
  const { root, cli, read } = await fixture(t);
  await cli("create", ["Existing", "--id", "node-existing", "--type", "prompt"]);
  for (const args of [
    ["Duplicate", "--id", "node-existing", "--type", "goal"],
    ["Missing parent", "--parent", "node-missing", "--type", "prompt"],
    ["../Escape", "--type", "prompt"],
    ["cards", "--type", "prompt"],
    ["Invalid type", "--type", "output-asset"],
    ["Missing type"],
  ]) {
    const result = await runNodeCommand("create", args, { workspace: root });
    assert.equal(result.exitCode, 1, JSON.stringify(args));
  }
  assert.equal((await read(".tent/Existing/Existing.md")).data.id, "node-existing");
  const entries = await fs.readdir(path.join(root, ".tent"));
  for (const absent of ["Duplicate", "Missing parent", "Escape", "Invalid type", "Missing type"])
    assert.equal(entries.includes(absent), false, absent);
});

test("all three Node types use the same explicit material creation path", async (t) => {
  const { cli, read } = await fixture(t);
  for (const type of ["goal", "prompt", "output"]) {
    const created = (
      await cli("create", [type, "--type", type, "--source", "./src/", "--body", "Facts"])
    ).node;
    const saved = await read(created.path);
    assert.equal(saved.data.type, type);
    assert.deepEqual(saved.data.sources, [{ resource: "../../src/" }]);
    assert.equal(saved.body, "Facts");
  }
});

test("rename, move, archive and delete preserve native document edits and retain history", async (t) => {
  const { root, cli, read } = await fixture(t);
  const created = (
    await cli("create", [
      "Child",
      "--parent",
      "node-parent",
      "--type",
      "prompt",
      "--body",
      "Original",
    ])
  ).node;
  const filename = path.join(root, created.path);
  await fs.writeFile(
    filename,
    (await fs.readFile(filename, "utf8")).replace("Original", "Native update"),
  );
  const renamed = await cli("rename", [created.nodeId, "Renamed"]);
  assert.equal(renamed.path, ".tent/Parent/Renamed/Renamed.md");
  assert.equal((await read(renamed.path)).body, "Native update");
  await cli("move", [created.nodeId, "--parent", "root"]);
  const moved = ".tent/Renamed/Renamed.md";
  assert.equal((await read(moved)).body, "Native update");
  await cli("archive", [created.nodeId]);
  assert.equal((await read(moved)).data.status, "deprecated");
  const history = await cli("history", [created.nodeId, "--limit", "1"]);
  assert.equal(history.items.length, 1);
  assert.equal(history.page.next, 1);
  assert.equal(
    (await cli("history", [created.nodeId, "--limit", "1", "--start", String(history.page.next)]))
      .items.length,
    1,
  );
  await cli("delete", [created.nodeId]);
  await assert.rejects(fs.stat(path.join(root, ".tent/Renamed")), { code: "ENOENT" });
});

test("removed Node commands and creation flags reject without capturing or rewriting native edits", async (t) => {
  const { root, tent, cli } = await fixture(t);
  const created = (
    await cli("create", ["Kept", "--id", "node-kept", "--type", "prompt", "--body", "Before"])
  ).node;
  const filename = path.join(root, created.path);
  await fs.writeFile(
    filename,
    (await fs.readFile(filename, "utf8")).replace("Before", "Native edit awaiting capture"),
  );
  const before = await fs.readFile(filename, "utf8");
  const head = await tent.history.currentCommit();
  const calls: Array<[string, string[]]> = [
    ...[
      "get",
      "list",
      "read-many",
      "search",
      "tags",
      "write",
      "write-many",
      "append",
      "create-many",
      "link-output",
      "get-section",
      "write-section",
      "type",
      "diff",
    ].map((command): [string, string[]] => [command, ["node-kept"]]),
    ...["--sources-json", "--card", "--role"].map((flag): [string, string[]] => [
      "create",
      ["Rejected", "--type", "output", flag, "{}"],
    ]),
  ];
  for (const [command, args] of calls) {
    const result = await runNodeCommand(command, args, { workspace: root });
    assert.equal(result.exitCode, 1, command);
    assert.equal(result.stdout, "", command);
    assert.equal(await fs.readFile(filename, "utf8"), before, command);
    assert.equal(await tent.history.currentCommit(), head, command);
  }
  await assert.rejects(fs.stat(path.join(root, ".tent/Rejected")), { code: "ENOENT" });
  assert.doesNotMatch(
    nodeHelpText(),
    /tent node (?:get|list|write|append|search|tags|link-output)\b/,
  );
});

test("history --version prints exact complete bytes after moves and deletion and rejects missing paths", async (t) => {
  const { root, tent, cli } = await fixture(t);
  const body = "A full retained paragraph.\r\n".repeat(6000) + "trailing spaces  \r\n\r\n";
  const created = (await cli("create", ["Historical", "--type", "output", "--body", body])).node;
  const raw = await fs.readFile(path.join(root, created.path), "utf8");
  const listing = await cli("history", [created.nodeId]);
  const original = listing.items.find(
    (item: { operation: string }) => item.operation === "node.create",
  ).changes[0].after;
  const selector = JSON.stringify(original);
  await cli("rename", [created.nodeId, "Moved"]);
  await cli("move", [created.nodeId, "--parent", "node-parent"]);
  const result = await runNodeCommand("history", [created.nodeId, "--version", selector], {
    workspace: root,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, raw);
  const json = await cli("history", [created.nodeId, "--version", selector]);
  assert.equal(json.text, raw);
  await cli("delete", [created.nodeId]);
  const deleted = (await cli("history", [created.nodeId])).items.find(
    (item: { operation: string }) => item.operation === "node.delete",
  ).commit;
  const missing = await runNodeCommand(
    "history",
    [created.nodeId, "--version", JSON.stringify({ ...original, commit: deleted })],
    { workspace: root },
  );
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /Document absent at SQLite event/);
  assert.equal(
    (await runNodeCommand("history", [created.nodeId, "--version", selector], { workspace: root }))
      .stdout,
    raw,
  );
  const head = await tent.history.currentCommit();
  for (const args of [
    [created.nodeId, "--version", "f".repeat(64)],
    [created.nodeId, "--version", original.commit],
    [created.nodeId, "--version", JSON.stringify({ commit: original.commit })],
    [created.nodeId, "--version", JSON.stringify({ ...original, path: "Absent/Absent.md" })],
    [created.nodeId, "--version", selector, "--limit", "1"],
  ]) {
    assert.equal((await runNodeCommand("history", args, { workspace: root })).exitCode, 1);
    assert.equal(await tent.history.currentCommit(), head);
  }
});

test("history --version reads an unchanged Node in another event and verifies its identity", async (t) => {
  const { root, cli } = await fixture(t);
  const created = (await cli("create", ["Original", "--type", "prompt", "--body", "Facts"])).node;
  const original = (await cli("history", [created.nodeId])).items[0].changes[0].after;
  const raw = await fs.readFile(path.join(root, created.path), "utf8");
  const other = (await cli("create", ["Other", "--type", "goal", "--body", "Other facts"])).node;
  const otherVersion = (await cli("history", [other.nodeId])).items[0].changes[0].after;
  assert.equal(
    (
      await cli("history", [
        created.nodeId,
        "--version",
        JSON.stringify({
          ...original,
          commit: otherVersion.commit,
        }),
      ])
    ).text,
    raw,
  );
  const wrong = await runNodeCommand(
    "history",
    [created.nodeId, "--version", JSON.stringify(otherVersion)],
    { workspace: root },
  );
  assert.equal(wrong.exitCode, 1);
  assert.equal(wrong.stdout, "");
  assert.match(wrong.stderr, /belongs to another Node/);
});

test("history --version returns exact bytes, retired fields included", async (t) => {
  const { tent, cli } = await fixture(t);
  const created = (await cli("create", ["Old", "--id", "node-old", "--type", "prompt"])).node;
  const historical =
    "---\r\nid: node-old\r\ntype: custom\r\ncustom: true\r\n---\r\nHistorical bytes  \r\n\r\n";
  const saved = await tent.history.captureUnlocked([{ path: "Old/Old.md", raw: historical }], {
    operation: "test.old-document",
  });
  assert.equal(
    (await cli("history", [created.nodeId, "--version", JSON.stringify(saved.versions[0])])).text,
    historical,
  );
});
