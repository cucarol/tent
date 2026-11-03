import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCardCommand } from "../src/cli/card-commands.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

test("Card watch and help leave pending native Node edits for the next graph command", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "native-command-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await initializeFixtureWorkspace(root);
  const system = path.join(root, ".tent");
  const adapter = openTestFs(system);
  await createRoleContext(adapter, { roleId: "role-worker", title: "Worker", body: "Work" });
  await fs.mkdir(path.join(system, "Fact"));
  const raw = "---\nid: node-fact\ntype: prompt\n---\nNative fact.\n";
  await fs.writeFile(path.join(system, "Fact/Fact.md"), raw);
  const before = await adapter.history.currentCommit();
  const watched = await runCardCommand("watch", ["--role", "role-worker", "--timeout", "0"], {
    workspace: root,
  });
  assert.equal(watched.exitCode, 2, watched.stderr);
  assert.equal(watched.stdout, "");
  const after = await adapter.history.currentCommit();
  assert.equal(after, before);
  assert.equal(await fs.readFile(path.join(system, "Fact/Fact.md"), "utf8"), raw);
  const help = await runCardCommand("watch", ["--help"], { workspace: root });
  assert.equal(help.exitCode, 0);
  assert.equal(await adapter.history.currentCommit(), after);
  const listed = await runCardCommand("list", ["--role", "role-worker"], { workspace: root });
  assert.equal(listed.exitCode, 0, listed.stderr);
  const captured = await adapter.history.currentCommit();
  assert.notEqual(captured, before);
  assert.equal(await adapter.history.read({ commit: captured!, path: "Fact/Fact.md" }), raw);
});
