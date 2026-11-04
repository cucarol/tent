import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { runRoleCommand } from "../src/cli/role-commands.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "role-context-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await scaffoldInWorkspace(root, { name: "roles" });
  const adapter = openTestFs(path.join(root, ".tent"));
  await initializeFixtureHistory(path.join(root, ".tent"));
  return { root, adapter };
}

test("Role create writes one retained document without Service or a registry", async (t) => {
  const { root, adapter } = await fixture(t);
  const registry = "legacy registry is not consulted";
  await adapter.writeFile("roles.json", registry);
  const created = await runRoleCommand("create", ["--title", "审查", "--body", "-", "--json"], {
    workspace: root,
    stdin: "--instructions\r\n",
  });
  assert.equal(created.exitCode, 0, created.stderr);
  const saved = JSON.parse(created.stdout);
  const raw = await adapter.readFile(`roles/${saved.roleId}.md`);
  const role = parseFrontmatter(raw);
  assert.equal(role.data.id, saved.roleId);
  assert.equal(role.data.type, "role");
  assert.equal(role.data.title, "审查");
  assert.equal(role.body, "--instructions\r\n");
  assert.equal(await adapter.readFile("roles.json"), registry);
  assert.deepEqual(
    (await adapter.listDir("roles")).map((entry) => entry.name),
    [`${saved.roleId}.md`],
  );
  const version = (await adapter.history.pathVersions(`roles/${saved.roleId}.md`)).latest!;
  assert.equal(await adapter.history.read(version), raw);
  const text = await runRoleCommand("create", ["--title", "Second"], { workspace: root });
  assert.match(text.stdout, /^Created role-\S+ {2}Second\nFile: .*roles[\\/]role-\S+\.md\n$/);
});

test("Role create canonicalizes known Node ids in Markdown links", async (t) => {
  const { adapter } = await fixture(t);
  await adapter.writeFile("Fact/Fact.md", "---\nid: node-fact\ntype: prompt\n---\nFact");
  const created = await createRoleContext(adapter, {
    roleId: "role-links",
    title: "Links",
    body: "[fact](node-fact)",
  });
  assert.equal(
    parseFrontmatter(await adapter.readFile(created.path)).body,
    "[fact](../Fact/Fact.md)",
  );
});
