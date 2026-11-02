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
  const initial = await runNodeCommand("get", ["node-goal", "--full"], options);
  assert.equal(initial.exitCode, 0, initial.stderr);
  const etag = JSON.parse(initial.stdout).etag as string;
  const adapter = openTestFs(path.join(root, ".tent"));
  const before = await adapter.readFile("Goal/Goal.md");
  const head = await adapter.history.currentCommit();
  for (const sub of ["check", "confirm"]) {
    const rejected = await runNodeCommand(sub, ["node-goal"], options);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, new RegExp(`Unknown command: tent node ${sub}`));
    assert.doesNotMatch(nodeHelpText(), new RegExp(`\b${sub}\b`));
  }
  const drift = await runWorkspaceCommand("drift", [], options);
  assert.equal(drift.exitCode, 1);
  assert.match(drift.stderr, /Unknown command: tent workspace drift/);
  assert.doesNotMatch(workspaceHelpText, /\bdrift\b/);
  for (const [sub, args] of [
    ["create", ["Other", "--type", "prompt", "--confirm"]],
    ["write", ["node-goal", "--base-etag", etag, "--body", "Lost", "--confirm"]],
    ["write", ["node-goal", "--base-etag", etag, "--body", "Lost", "--by", "human:cuca"]],
    ["append", ["node-goal", "--body", "Lost", "--by", "human:cuca"]],
    ["link-output", ["node-goal", "--resource", "./proof.txt", "--by", "human:cuca"]],
  ] as const) {
    const rejected = await runNodeCommand(sub, [...args], options);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /unknown option/i);
  }
  for (const fields of [{ confirm: true }, { confirm: false }, { by: "human:cuca" }]) {
    const write = await runNodeCommand(
      "write",
      ["node-goal", "--input-json", JSON.stringify({ baseEtag: etag, body: "Lost", ...fields })],
      options,
    );
    assert.equal(write.exitCode, 1, JSON.stringify(fields));
    for (const item of [
      {
        op: "create",
        ref: "new",
        name: "Other",
        type: "prompt",
        body: "Lost",
        ...fields,
      },
      {
        op: "update",
        nodeId: "node-goal",
        baseEtag: etag,
        body: "Lost",
        ...fields,
      },
    ]) {
      const batch = await runNodeCommand(
        "write-many",
        ["--input-json", JSON.stringify({ items: [item] })],
        options,
      );
      assert.equal(batch.exitCode, 1, JSON.stringify(item));
    }
  }
  assert.equal(await adapter.readFile("Goal/Goal.md"), before);
  assert.equal(await adapter.exists("Other"), false);
  assert.equal(await adapter.history.currentCommit(), head);
});
