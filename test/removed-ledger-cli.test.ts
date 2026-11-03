import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runNodeCommand, nodeHelpText } from "../src/cli/node-commands.js";
import { runWorkspaceCommand, workspaceHelpText } from "../src/cli/workspace-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot, initializeFixtureHistory } from "./scratch.js";

test("removed Node ledger commands, flags and JSON fields reject without changing documents or history", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "removed-ledger-cli-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(root), {
    name: "Removed ledger",
    nodes: [],
  });
  await initializeFixtureHistory(path.join(root, ".tent"));
  const options = { workspace: root, json: true };
  const created = await runNodeCommand(
    "create",
    ["Goal", "--id", "node-goal", "--type", "goal", "--body", "Keep this body"],
    options,
  );
  assert.equal(created.exitCode, 0, created.stderr);
  const adapter = openTestFs(path.join(root, ".tent"));
  const before = await adapter.readFile("Goal/Goal.md");
  const head = await adapter.history.currentCommit();
  for (const sub of ["check", "confirm", "write", "append", "link-output", "write-many"]) {
    const rejected = await runNodeCommand(sub, ["node-goal"], options);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, new RegExp(`Unknown command: tent node ${sub}`));
    assert.doesNotMatch(nodeHelpText(), new RegExp(`\\b${sub}\\b`));
  }
  const drift = await runWorkspaceCommand("drift", [], options);
  assert.equal(drift.exitCode, 1);
  assert.match(drift.stderr, /Unknown command: tent workspace drift/);
  assert.doesNotMatch(workspaceHelpText, /\bdrift\b/);
  for (const flags of [["--confirm"], ["--by", "human:cuca"]]) {
    const rejected = await runNodeCommand(
      "create",
      ["Other", "--type", "prompt", ...flags],
      options,
    );
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /unknown option/i);
  }
  const draftFile = path.join(root, "rejected-draft.json");
  for (const fields of [{ confirm: true }, { confirm: false }, { by: "human:cuca" }]) {
    const draft = JSON.stringify({
      items: [
        {
          op: "create",
          ref: "new",
          name: "Other",
          type: "prompt",
          body: "Lost",
          ...fields,
        },
      ],
    });
    await fs.writeFile(draftFile, draft);
    const rejected = await runNodeCommand("create", ["--draft", draftFile], options);
    assert.equal(rejected.exitCode, 1, JSON.stringify(fields));
    assert.match(rejected.stderr, new RegExp(Object.keys(fields)[0]));
    assert.equal(await fs.readFile(draftFile, "utf8"), draft);
  }
  assert.equal(await adapter.readFile("Goal/Goal.md"), before);
  assert.equal(await adapter.exists("Other"), false);
  assert.equal(await adapter.history.currentCommit(), head);
});
