import { initializeFixtureHistory } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createRoleContext } from "../src/core/read/role-context.js";
import { createCardDocument, takeCardDocument } from "../src/core/graph/card-document.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "role-card-review-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureHistory(root);
  const adapter = openTestFs(root);
  await createRoleContext(adapter, {
    roleId: "role-a",
    title: "Original direction",
    body: "Work here",
  });
  return { root, adapter };
}

test("RC2: external same-stem Markdown and Tent documents stay addresses at publication", async (t) => {
  const { adapter } = await fixture(t);
  const nodeRaw = "---\nid: node-main\ntype: prompt\n---\nexact selected bytes";
  await adapter.writeFile("Main/Main.md", nodeRaw);
  const sources = [
    { resource: "../../docs/spec.md" },
    { resource: "../../docs/docs.md?mode=1#part", custom: [2, 1] },
    { resource: "../../docs/docs.md?mode=1#part" },
    { resource: "/Main/Main.md" },
    { resource: "/roles/role-a.md" },
  ];
  const read = adapter.readFile.bind(adapter);
  adapter.readFile = async (p) => {
    assert.ok(!p.startsWith("../"));
    return read(p);
  };
  const created = await createCardDocument(adapter, {
    cardId: "card-addresses",
    prompt: "references",
    target: "role-a",
    sources,
  });
  assert.deepEqual(parseFrontmatter(await adapter.readFile(created.path)).data.sources, sources);
  assert.equal(await adapter.readFile("Main/Main.md"), nodeRaw);
  await assert.rejects(
    createCardDocument(adapter, {
      prompt: "outside",
      target: "role-a",
      sources: [{ resource: "../../../outside/outside.md" }],
    }),
    /outside the Workspace/,
  );
});

test("RC3: deleted Role identities stay unavailable to new creation and old targeted Cards", async (t) => {
  const { root, adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "Original recipient only",
    target: "role-a",
  });
  await fs.unlink(path.join(root, "roles/role-a.md"));
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), /Role unavailable/);
  await assert.rejects(
    createRoleContext(adapter, { roleId: "role-a", title: "Unrelated new direction", body: "new" }),
    /already exists in history/,
  );
  assert.equal(await adapter.exists("roles/role-a.md"), false);
  const next = await createRoleContext(adapter, { roleId: "role-new", title: "New direction" });
  assert.equal(next.roleId, "role-new");
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-new"), /addressed to role-a/);
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), /Role unavailable/);
  assert.equal(parseFrontmatter(await adapter.readFile(card.path)).data.state, "pending");
});
