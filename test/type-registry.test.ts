import { initializeFixtureHistory } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { NODE_TYPES, isNodeType, normalizeOptionalNodeType } from "../src/core/base/node-type.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { readNodeVersion } from "../src/core/read/node-version.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";
import { canonicalIdentityError, loadTent } from "../src/core/store/tree.js";

test("Node type accepts exactly goal, prompt and output", () => {
  assert.deepEqual(NODE_TYPES, ["goal", "prompt", "output"]);
  for (const type of NODE_TYPES) {
    assert.equal(normalizeOptionalNodeType(type), type);
    assert.equal(isNodeType(type), true);
  }
  for (const value of [
    "output-evidence",
    "goal-requirement",
    "prompt-decision",
    "output-",
    " goal",
    "goal ",
    "Goal",
    "reference",
    "",
    "   ",
    undefined,
    null,
    ["goal"],
  ]) {
    assert.equal(isNodeType(value), false, String(value));
    assert.throws(
      () => normalizeOptionalNodeType(value),
      /^Error: Node type must be goal, prompt or output\.$/,
    );
  }
});

test("Node loading rejects missing type and accepts exact type without registry authority", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-"));
  t.after(() =>
    removeTestFixture(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const adapter = openTestFs(dir);
  await adapter.mkdir("MissingType");
  await adapter.writeFile("MissingType/MissingType.md", "---\nid: node-untyped\n---\n# Untyped\n");
  await adapter.mkdir("Typed");
  await adapter.writeFile("Typed/Typed.md", "---\nid: node-typed\ntype: prompt\n---\n# Typed\n");
  // A retired registry file is inert user/system-root inventory, not authority.
  await adapter.writeFile("types.json", "{ this is not valid json }");

  const tent = await loadTent(adapter);
  assert.equal(tent.byId.has("node-untyped"), false);
  assert.equal(tent.byPath.get("MissingType")?.invalid, true);
  assert.match(tent.byPath.get("MissingType")?.invalidReason ?? "", /goal, prompt or output/);
  assert.equal(tent.byId.get("node-typed")?.type, "prompt");
  assert.equal(tent.byId.get("node-typed")?.invalid, false);
  assert.equal("type" + "Registry" in tent, false);
});

test("suffixed, padded, empty or non-string Node types are invalid and repairable by path", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-invalid-"));
  t.after(() =>
    removeTestFixture(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const adapter = openTestFs(dir);
  const cases = [
    ["Suffixed", "node-suffixed", "type: output-evidence"],
    ["Padded", "node-padded", 'type: "  prompt  "'],
    ["Empty", "node-empty", 'type: "   "'],
    ["InvalidPrimary", "node-invalid", "type: reference"],
    ["Array", "node-array", "type: [goal]"],
  ] as const;
  for (const [name, id, line] of cases) {
    await adapter.mkdir(name);
    await adapter.writeFile(`${name}/${name}.md`, `---\nid: ${id}\n${line}\n---\n`);
  }
  await adapter.mkdir("Suffixed/Child");
  await adapter.writeFile("Suffixed/Child/Child.md", "---\nid: node-child\ntype: output\n---\n");

  const tent = await loadTent(adapter);
  for (const [nodePath, id] of cases) {
    const node = tent.byPath.get(nodePath);
    assert.ok(node);
    assert.equal(node.invalid, true);
    assert.equal(node.type, undefined);
    assert.equal(tent.byId.has(id), false);
    assert.equal(node.invalidReason, "Node type must be goal, prompt or output.");
  }
  // The invalid document is not converted; its subtree leaves ordinary operations.
  assert.match(await adapter.readFile("Suffixed/Suffixed.md"), /^type: output-evidence$/m);
  assert.equal(tent.byPath.get("Suffixed/Child")?.invalid, true);
});

test("scaffold writes exact types and rejects former labels", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-scaffold-"));
  t.after(() =>
    removeTestFixture(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const adapter = openTestFs(dir);
  await scaffoldTent(adapter, {
    name: "single-type",
    nodes: [{ name: "Prompt", type: "prompt" }],
  });

  assert.equal(await adapter.exists("types.json"), false);
  const tent = await loadTent(adapter);
  assert.equal(tent.byPath.get("Prompt")?.type, "prompt");
  assert.match(await adapter.readFile("Prompt/Prompt.md"), /^type:\s*prompt$/m);

  const rejected = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-scaffold-"));
  t.after(() =>
    removeTestFixture(rejected, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await assert.rejects(
    scaffoldTent(openTestFs(rejected), {
      name: "single-type",
      nodes: [{ name: "Typed", type: "prompt-experiment" }],
    }),
    /^Error: Node Typed type must be goal, prompt or output\.$/,
  );
});

test("a historical version with a former suffixed type is rejected like any invalid type", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-history-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(workspace), { name: "History" });
  const root = path.join(workspace, ".tent");
  await initializeFixtureHistory(root);
  const adapter = openTestFs(root);
  // No reader tolerates an old type form: a former suffix fails exactly like "reference".
  const cases = [
    ["Suffixed", "node-suffixed", "goal-requirement"],
    ["Padded", "node-padded", "  goal-requirement  "],
    ["Unknown", "node-unknown", "reference"],
  ] as const;
  const message = "Node type must be goal, prompt or output.";
  const outcomes = [];
  for (const [name, id, type] of cases) {
    const file = `${name}/${name}.md`;
    const raw = `---\nid: ${id}\ntype: ${JSON.stringify(type)}\n---\nWant\n`;
    await adapter.mkdir(name);
    await adapter.writeFile(file, raw);
    const [version] = (await adapter.history.captureUnlocked([{ path: file, raw }])).versions;
    assert.ok(version);
    // The live document is valid now; only the retained version keeps the old form.
    await adapter.writeFile(file, `---\nid: ${id}\ntype: goal\ntags: [requirement]\n---\nWant\n`);
    assert.equal((await loadTent(adapter)).byId.get(id)?.type, "goal");
    assert.equal(canonicalIdentityError(parseFrontmatter(raw).data), message, name);
    // node history --version
    const read = await readNodeVersion(adapter, id, version).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    outcomes.push({ read });
  }
  assert.deepEqual(outcomes[0], { read: message });
  assert.deepEqual(outcomes[1], outcomes[0], "a padded former type is invalid too");
  assert.deepEqual(outcomes[2], outcomes[0], "the same result as an unknown type");
});
