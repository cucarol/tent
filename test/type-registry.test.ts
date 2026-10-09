import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { test } from "node:test";
import {
  NODE_TYPES,
  isNodeType,
  nodeTypeOf,
  normalizeOptionalNodeType,
} from "../src/core/node-type.js";
import { NODE_TAG_PRESETS, countNodeTags, isNodeTagPreset } from "../src/core/tags.js";
import {
  listCardDocuments,
  readCardDocument,
  verifyCardSourceVersion,
  verifyCardSourceVersions,
} from "../src/core/card-document.js";
import { readCardGoalIds } from "../src/core/card-progress.js";
import { historicalNodeCatalog } from "../src/core/node-semantic-history.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { readNode } from "../src/core/node-query.js";
import { scaffoldInWorkspace, scaffoldTent } from "../src/core/scaffold.js";
import { canonicalIdentityError, loadTent } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { git } from "./helpers.js";

test("Node type accepts exactly goal, prompt and output", () => {
  assert.deepEqual(NODE_TYPES, ["goal", "prompt", "output"]);
  for (const type of NODE_TYPES) {
    assert.equal(normalizeOptionalNodeType(type), type);
    assert.equal(isNodeType(type), true);
    assert.equal(nodeTypeOf(type), type);
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
    assert.equal(nodeTypeOf(value), null, String(value));
    assert.throws(
      () => normalizeOptionalNodeType(value),
      /^Error: Node type must be goal, prompt or output\.$/,
    );
  }
});

test("tag presets are suggestions counted only where documents use them", () => {
  assert.deepEqual(NODE_TAG_PRESETS, [
    "direction",
    "requirement",
    "decision",
    "spec",
    "reference",
    "procedure",
    "asset",
    "evidence",
    "analysis",
    "issue",
  ]);
  assert.equal(isNodeTagPreset("evidence"), true);
  assert.equal(isNodeTagPreset("ui"), false);
  assert.deepEqual(
    countNodeTags([
      { tags: ["ui", "evidence"], archived: false },
      { tags: ["evidence"], archived: false },
      { tags: ["old"], archived: true },
    ]),
    [
      { tag: "evidence", count: 2, preset: true },
      { tag: "ui", count: 1, preset: false },
    ],
  );
  assert.deepEqual(countNodeTags([{ tags: ["old"], archived: true }], { includeArchived: true }), [
    { tag: "old", count: 1, preset: false },
  ]);
});

test("Node loading rejects missing type and accepts exact type without registry authority", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const adapter = new NodeFs(dir);
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
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const adapter = new NodeFs(dir);
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
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const adapter = new NodeFs(dir);
  await scaffoldTent(adapter, {
    name: "single-type",
    nodes: [{ name: "Prompt", type: "prompt" }],
  });

  assert.equal(await adapter.exists("types.json"), false);
  const tent = await loadTent(adapter);
  assert.equal(tent.byPath.get("Prompt")?.type, "prompt");
  assert.match(await adapter.readFile("Prompt/Prompt.md"), /^type:\s*prompt$/m);

  const rejected = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-scaffold-"));
  t.after(() => fs.rm(rejected, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await assert.rejects(
    scaffoldTent(new NodeFs(rejected), {
      name: "single-type",
      nodes: [{ name: "Typed", type: "prompt-experiment" }],
    }),
    /^Error: Node Typed type must be goal, prompt or output\.$/,
  );
});

test("a historical version with a former suffixed type is rejected like any invalid type", async (t) => {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "tent-node-type-history-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "History" });
  const root = path.join(workspace, ".tent");
  await git(root, "init", "--initial-branch=main");
  const adapter = new NodeFs(root);
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
    // node get --version-json
    const read = await readNode(adapter, "ws-test", { nodeId: id, view: "raw", version }).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    // Card take/show, workspace check and relation queries over a pinned source.
    const source = { resource: `../${file}`, version };
    const single = await verifyCardSourceVersion(adapter, "cards/card-history.md", source).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    const [batch] = await verifyCardSourceVersions(adapter, [
      { owner: "cards/card-history.md", source },
    ]);
    // Card progress over the pinned goal.
    const progress = (
      await readCardGoalIds(adapter, [
        { cardId: "card-history", state: "consumed", sources: [{ resource: `/${file}`, version }] },
      ])
    ).get("card-history")!;
    // card list/show over a received Card that pinned the retained version.
    const cardId = `card-${name.toLowerCase()}`;
    await adapter.mkdir("cards");
    for (const state of ["pending", "consumed"]) {
      const cardRaw = serializeFrontmatter(
        {
          type: "card",
          id: cardId,
          schemaVersion: 3,
          state,
          sources: [{ resource: `../${file}`, version }],
        },
        "Implement the goal.\n",
      );
      await adapter.writeFile(`cards/${cardId}.md`, cardRaw);
      await adapter.history.captureUnlocked([{ path: `cards/${cardId}.md`, raw: cardRaw }]);
    }
    const listed = (await listCardDocuments(adapter)).items.find(
      (item) => item.cardId === cardId,
    ) as Record<string, unknown>;
    const shown = (await readCardDocument(adapter, cardId)) as Record<string, unknown>;
    const anonymous = (text: unknown) =>
      String(text).replace(`../${file}`, "<source>").replace(`/${file}`, "<source>");
    // Ahead replay over the retained document.
    const replayed = historicalNodeCatalog(new Map([[id, { path: name, raw }]]));
    outcomes.push({
      read,
      single,
      batch: batch instanceof Error ? batch.message : "accepted",
      goalIds: [...progress.goalIds],
      diagnostics: progress.diagnostics.map(anonymous),
      list: [listed.progress, listed.totalGoalCount, anonymous(listed.diagnostic)],
      show: [shown.progress, shown.totalGoalCount, anonymous(shown.diagnostic)],
      replayedNodeIds: [...replayed.keys()],
    });
  }
  // An invalid pin is diagnosed, never read as a Card without goals.
  const diagnostic = `Cannot derive Card progress from <source>: Error: ${message}`;
  assert.deepEqual(outcomes[0], {
    read: message,
    single: message,
    batch: message,
    goalIds: [],
    diagnostics: [diagnostic],
    list: [null, 0, diagnostic],
    show: [null, 0, diagnostic],
    replayedNodeIds: [],
  });
  assert.deepEqual(outcomes[1], outcomes[0], "a padded former type is invalid too");
  assert.deepEqual(outcomes[2], outcomes[0], "the same result as an unknown type");
});
