import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import { nodeTypePrimary, normalizeOptionalNodeType } from "../src/core/node-type.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import { loadTent } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("Node type is one required canonical primary[-secondary] marker", () => {
  assert.equal(normalizeOptionalNodeType("  prompt-research-note  "), "prompt-research-note");
  assert.equal(normalizeOptionalNodeType("goal-asset"), "goal-asset");
  assert.equal(normalizeOptionalNodeType("output-asset"), "output-asset");
  assert.equal(nodeTypePrimary("goal-reference"), "goal");
  assert.equal(nodeTypePrimary("goal-"), null);
  assert.equal(nodeTypePrimary(undefined), null);
  assert.throws(() => normalizeOptionalNodeType("   "), /non-empty/);
  assert.throws(() => normalizeOptionalNodeType(undefined), /must be a string/);
  assert.throws(() => normalizeOptionalNodeType(["goal"]), /must be a string/);
  assert.throws(() => normalizeOptionalNodeType("reference"), /goal\|prompt\|output/);
  assert.throws(() => normalizeOptionalNodeType("experiment"), /goal\|prompt\|output/);
});

test("Node loading rejects missing type and accepts canonical compound type without registry authority", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-"));
  const adapter = new NodeFs(dir);
  await adapter.mkdir("MissingType");
  await adapter.writeFile("MissingType/MissingType.md", "---\nid: node-untyped\n---\n# Untyped\n");
  await adapter.mkdir("Typed");
  await adapter.writeFile(
    "Typed/Typed.md",
    '---\nid: node-typed\ntype: "  prompt-reference  "\n---\n# Typed\n',
  );
  // A retired registry file is inert user/system-root inventory, not authority.
  await adapter.writeFile("types.json", "{ this is not valid json }");

  const tent = await loadTent(adapter);
  assert.equal(tent.byId.has("node-untyped"), false);
  assert.equal(tent.byPath.get("MissingType")?.invalid, true);
  assert.match(tent.byPath.get("MissingType")?.invalidReason ?? "", /must be a string/);
  assert.equal(tent.byId.get("node-typed")?.type, "prompt-reference");
  assert.equal(tent.byId.get("node-typed")?.invalid, false);
  assert.equal("type" + "Registry" in tent, false);
});

test("present empty, invalid-primary, or non-string Node type is invalid and repairable by path", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-invalid-"));
  const adapter = new NodeFs(dir);
  await adapter.mkdir("Empty");
  await adapter.writeFile("Empty/Empty.md", '---\nid: node-empty\ntype: "   "\n---\n');
  await adapter.mkdir("InvalidPrimary");
  await adapter.writeFile(
    "InvalidPrimary/InvalidPrimary.md",
    "---\nid: node-invalid\ntype: reference\n---\n",
  );
  await adapter.mkdir("Array");
  await adapter.writeFile("Array/Array.md", "---\nid: node-array\ntype: [goal]\n---\n");

  const tent = await loadTent(adapter);
  for (const [nodePath, id] of [
    ["Empty", "node-empty"],
    ["InvalidPrimary", "node-invalid"],
    ["Array", "node-array"],
  ] as const) {
    const node = tent.byPath.get(nodePath);
    assert.ok(node);
    assert.equal(node.invalid, true);
    assert.equal(node.type, undefined);
    assert.equal(tent.byId.has(id), false);
  }
  assert.match(tent.byPath.get("Empty")?.invalidReason ?? "", /non-empty/);
  assert.match(tent.byPath.get("InvalidPrimary")?.invalidReason ?? "", /goal\|prompt\|output/);
  assert.match(tent.byPath.get("Array")?.invalidReason ?? "", /must be a string/);
});

test("scaffold writes canonical types and no type registry", async () => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-scaffold-"));
  const adapter = new NodeFs(dir);
  await scaffoldTent(adapter, {
    name: "single-type",
    nodes: [
      { name: "Prompt", type: "prompt" },
      { name: "Typed", type: "  prompt-experiment  " },
    ],
  });

  assert.equal(await adapter.exists("types.json"), false);
  const tent = await loadTent(adapter);
  assert.equal(tent.byPath.get("Prompt")?.type, "prompt");
  assert.equal(tent.byPath.get("Typed")?.type, "prompt-experiment");
  assert.match(await adapter.readFile("Prompt/Prompt.md"), /^type:\s*prompt$/m);
  assert.match(await adapter.readFile("Typed/Typed.md"), /^type:\s*prompt-experiment$/m);
});
