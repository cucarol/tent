import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { runNodeCommand, nodeHelpText } from "../src/cli/node-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "cli-provenance-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(root, { name: "Actors", nodes: [] });
  await fs.writeFile(path.join(root, "proof.txt"), "Evidence.\n");
  const globals = { workspace: root, json: true };
  const run = async (command: string, args: string[], stdin?: string) => {
    const result = await runNodeCommand(command, args, { ...globals, stdin });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const created = await run("create", [
    "Decision",
    "--id",
    "node-decision",
    "--type",
    "prompt",
    "--body",
    "## Choice\nFirst.\n",
  ]);
  const document = path.join(root, ".tent/Decision/Decision.md");
  return { globals, document, id: created.node.nodeId };
}

test("CLI restore has no command or help entry", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.document, "utf8");
  const result = await runNodeCommand("restore", [f.id], f.globals);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown command/);
  assert.doesNotMatch(nodeHelpText(), /\brestore\b/);
  assert.doesNotMatch(nodeHelpText("restore"), /\brestore\b/);
  assert.equal(await fs.readFile(f.document, "utf8"), before);
});
