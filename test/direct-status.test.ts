import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { listRoleContexts } from "../src/core/read/role-context.js";
import { listCardDocuments } from "../src/core/graph/card-document.js";

test("Node, Role and Card discovery reads headers without bodies or Git capture", async (t) => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "direct-status-"));
  t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(workspace), {
    name: "status",
    nodes: [{ id: "node-fact", name: "Fact", type: "prompt", body: "unread body" }],
  });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  await adapter.writeFile("roles.json", "broken retired registry");
  await adapter.writeFile(
    "roles/role-own.md",
    "---\ntype: role\nid: role-own\ntitle: Own\n---\nunread role body",
  );
  for (let i = 0; i < 25; i++)
    await adapter.writeFile(
      `cards/card-${i}.md`,
      `---\ntype: card\nid: card-${i}\nschemaVersion: 3\nstate: pending\nsources: []\n---\nunread input`,
    );
  await adapter.writeFile(
    "cards/card-legacy.md",
    "---\ntype: card\nid: card-legacy\nschemaVersion: 2\n---\nunread legacy input",
  );
  const read = adapter.readFile.bind(adapter);
  adapter.readFile = async (name) => {
    assert.notEqual(name, "roles.json");
    assert.equal(name.endsWith(".md"), false, `Full document read: ${name}`);
    return read(name);
  };
  adapter.writeFile = async () => {
    throw new Error("status wrote state");
  };
  adapter.history.captureUnlocked = async () => {
    throw new Error("status captured history");
  };
  const nodes = await loadNodeCatalog(adapter);
  const roles = await listRoleContexts(adapter);
  const cards = await listCardDocuments(adapter, { includeDeprecated: true });
  assert.equal(nodes.byId.size, 1);
  assert.equal(roles.items[0]?.title, "Own");
  assert.equal(cards.items.length, 1);
  assert.equal(cards.items[0]!.cardId, "card-legacy");
  assert.match(String(cards.items[0]!.diagnostic), /header unavailable/);
});
