import { captureFixtureDocuments } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runCardCommand } from "../src/cli/card-commands.js";
import { nodeHelpText, runNodeCommand } from "../src/cli/node-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";

test("Node help is offline and does not parse or read requested content", async () => {
  const globals = {
    workspace: path.resolve(testScratchRoot(), "missing-help-workspace"),
  };
  for (const [sub, args] of [
    ["help", []],
    ["--help", []],
    ["-h", []],
    ["create", ["-h", "--source", "unfinished"]],
    ["history", ["--help"]],
  ] as Array<[string, string[]]>) {
    const result = await runNodeCommand(sub, args, globals);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, nodeHelpText(sub) + "\n");
    assert.ok(!result.stdout.endsWith("\n\n"), sub);
  }
  assert.equal((await runNodeCommand("fork", ["node-unused"], globals)).exitCode, 1);
});

test("CLI validation errors name the command, argument and field instead of issue JSON", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "cli-validation-"));
  t.after(() =>
    removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    }),
  );
  const workspace = path.join(root, "workspace");
  await scaffoldInWorkspace(openTestFs(workspace), { name: "Validation" });
  const globals = { workspace };
  const validItem = { op: "create", ref: "ok", name: "Valid", type: "prompt" };
  for (const [item, field, message] of [
    [{ op: "create", name: "Missing ref", type: "prompt" }, "ref", "ref is required"],
    [{ op: "create", ref: "bad", type: "prompt" }, "name", "name is required"],
    [{ op: "create", ref: "bad", name: "Missing type" }, "type", "type is required"],
    [{ op: "create", ref: 12, name: "Wrong type", type: "prompt" }, "ref", "expected string"],
    [{ op: "update" }, "op", "op must be create"],
    [{ name: "Missing op" }, "op", "op must be create"],
  ] as const) {
    await writeFile(
      path.join(workspace, "invalid.json"),
      JSON.stringify({ items: [validItem, item] }),
    );
    const rejected = await runNodeCommand("create", ["--draft", "invalid.json"], globals);
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.stdout, "");
    assert.ok(rejected.stderr.startsWith(`tent node create: items[1].${field}: `), rejected.stderr);
    assert.ok(rejected.stderr.includes(message), rejected.stderr);
    assert.equal(await openTestFs(path.join(workspace, ".tent")).exists("Valid"), false);
  }
});

test("CLI creates material Nodes and Cards whose sources are plain addresses", async () => {
  const scratch = path.resolve(testScratchRoot());
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "cli-workspace-tools-"));
  try {
    const workspace = path.join(root, "workspace");
    await scaffoldInWorkspace(openTestFs(workspace), {
      name: "CLI tools",
      nodes: [
        {
          id: "node-fact",
          name: "Fact",
          type: "prompt",
          body: "Original fact",
        },
      ],
    });
    await initializeFixtureHistory(path.join(workspace, ".tent"));
    await captureFixtureDocuments(path.join(workspace, ".tent"));
    const globals = { workspace, json: true };
    const result = (value: { exitCode: number; stdout: string; stderr: string }) => {
      assert.equal(value.exitCode, 0, value.stderr);
      return JSON.parse(value.stdout);
    };
    const note = result(
      await runNodeCommand(
        "create",
        [
          "CLI Note",
          "--type",
          "prompt",
          "--body",
          "Independent Markdown",
          "--source",
          "/refs/example.pdf",
          "--source",
          "/refs/example.pdf",
        ],
        globals,
      ),
    ).node;
    const saved = parseFrontmatter(await readFile(path.join(workspace, note.path), "utf8"));
    assert.equal(saved.body, "Independent Markdown");
    assert.deepEqual(saved.data.sources, [
      { resource: "../../refs/example.pdf" },
      { resource: "../../refs/example.pdf" },
    ]);
    const invalidRefs = await runNodeCommand(
      "create",
      ["Invalid refs", "--type", "prompt", "--source", ""],
      globals,
    );
    assert.equal(invalidRefs.exitCode, 1);
    assert.equal(await openTestFs(path.join(workspace, ".tent")).exists("Invalid refs"), false);
    await initializeFixtureHistory(path.join(workspace, ".tent"));
    const { roleId } = result(await runRoleCommand("create", ["--title", "Reviewer"], globals));
    const input = result(
      await runCardCommand(
        "create",
        ["--target", roleId, "--source", ".tent/Fact/Fact.md", "--source", "./refs/example.pdf"],
        globals,
      ),
    );
    const savedInput = parseFrontmatter(
      await readFile(path.join(workspace, ".tent/cards", `${input.cardId}.md`), "utf8"),
    ).data;
    assert.deepEqual(savedInput.sources, [
      { resource: "../Fact/Fact.md" },
      { resource: "../../refs/example.pdf" },
    ]);
    const invalid = await runCardCommand("create", ["--target", roleId, "--source", ""], globals);
    assert.equal(invalid.exitCode, 1);
  } finally {
    await removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    });
  }
});

test("Node help exposes retained creation and history syntax without removed commands", () => {
  assert.match(nodeHelpText("create"), /create --draft <file>/);
  assert.match(nodeHelpText("history"), /--version <version>/);
  assert.doesNotMatch(
    nodeHelpText(),
    /tent node (?:get|write|append|search|read-many|write-many|list|tags|link-output)\b/,
  );
});
