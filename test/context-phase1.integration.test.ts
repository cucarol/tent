import { removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { git } from "./helpers.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "context-phase1-"));
  t.after(() =>
    removeTestFixture(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    }),
  );
  await scaffoldInWorkspace(root, { name: "Context" });
  await initializeFixtureHistory(path.join(root, ".tent"));
  const options = { workspace: root, json: true };
  const node = async (sub: string, args: string[]) => {
    const result = await runNodeCommand(sub, args, options);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, options, node };
}

test("without Hooks hand edits are recorded at the next command and earlier versions stay readable", async (t) => {
  const f = await fixture(t);
  await git(f.root, "init", "--quiet");
  await fs.writeFile(path.join(f.root, "requirement.md"), "Requirement version one");
  const created = await f.node("create", [
    "Requirement",
    "--type",
    "goal",
    "--resource",
    "requirement.md",
    "--body",
    "Settled requirement",
  ]);
  const id = created.node.nodeId;
  await fs.writeFile(path.join(f.root, "result.html"), "<h1>Implemented</h1>");
  const linked = (
    await f.node("create", [
      "Implementation",
      "--type",
      "output",
      "--parent",
      id,
      "--resource",
      "result.html",
    ])
  ).node;
  assert.equal(linked.path, ".tent/Requirement/Implementation/Implementation.md");
  const requirementFile = path.join(f.root, created.node.path);
  const outputFile = path.join(f.root, linked.path);
  const originalRaw = await fs.readFile(requirementFile, "utf8");
  const originalVersion = JSON.stringify((await f.node("history", [id])).items[0].changes[0].after);
  const headBefore = await historyHead(path.join(f.root, ".tent"));
  const requirement = parseFrontmatter(originalRaw);
  await fs.writeFile(
    requirementFile,
    serializeFrontmatter(requirement.data, "Changed requirement", requirement.keyOrder),
  );
  const output = parseFrontmatter(await fs.readFile(outputFile, "utf8"));
  await fs.writeFile(
    outputFile,
    serializeFrontmatter(output.data, "Updated implementation", output.keyOrder),
  );
  await runWorkspaceCommand("check", [], f.options);
  assert.notEqual(await historyHead(path.join(f.root, ".tent")), headBefore);
  assert.equal(
    parseFrontmatter(await fs.readFile(requirementFile, "utf8")).body,
    "Changed requirement",
  );
  assert.equal(
    parseFrontmatter(await fs.readFile(outputFile, "utf8")).body,
    "Updated implementation",
  );
  assert.equal((await f.node("history", [id, "--version", originalVersion])).text, originalRaw);
});

test("CLI Card list text and JSON stay byte-identical when the clock advances one second", async (t) => {
  const f = await fixture(t);
  const created = await f.node("create", [
    "Requirement",
    "--type",
    "goal",
    "--body",
    "Unfulfilled",
  ]);
  const id = created.node.nodeId;
  const role = await runRoleCommand(
    "create",
    ["--id", "role-worker", "--title", "Worker"],
    f.options,
  );
  assert.equal(role.exitCode, 0, role.stderr);
  const card = await runCardCommand(
    "create",
    ["--prompt", "Read requirement", "--source", id, "--target", "role-worker"],
    f.options,
  );
  assert.equal(card.exitCode, 0, card.stderr);
  const head = await historyHead(path.join(f.root, ".tent"));
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-07T04:00:59Z"),
  });
  const readAll = async () => {
    const outputs: Record<string, string> = {};
    for (const json of [false, true]) {
      const result = await runCardCommand("list", ["--role", "role-worker"], {
        workspace: f.root,
        json,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      outputs[json ? "json" : "text"] = result.stdout;
    }
    return outputs;
  };
  const before = await readAll();
  assert.equal(JSON.parse(before.json).items.length, 1);
  t.mock.timers.tick(1000);
  const after = await readAll();
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], name);
  assert.equal(await historyHead(path.join(f.root, ".tent")), head);
});
