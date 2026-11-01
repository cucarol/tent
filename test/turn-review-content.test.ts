import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { buildStopMaterialIndex } from "../src/core/return/stop-material-index.js";
import {
  formatToolTurnReview,
  modulesForIndexedTurn,
  TOOL_REVIEW_ACTION,
  type TurnReviewModule,
} from "../src/core/return/tool-turn-review.js";
import {
  loadTurnReviewContent,
  reprojectTurnReviewContent,
} from "../src/core/return/turn-review-content.js";
import { loadHookTurnReviewContent } from "../src/fs/turn-review-content.js";
import { testScratchRoot } from "./scratch.js";
import { turnReviewDocument } from "../src/core/return/turn-review-document.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "hook-content-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(systemRoot);
  const bodies = new Map<string, string>();
  const node = async (
    directory: string,
    id: string,
    type: string,
    extra = "",
    body = `${id}\n`,
  ) => {
    const filename = `${directory}/${path.posix.basename(directory)}.md`;
    await fs.mkdir(path.join(systemRoot, directory), { recursive: true });
    const raw = `---\nid: ${id}\ntype: ${type}\n${extra}---\n${body}`;
    bodies.set(filename, raw);
    await fs.writeFile(path.join(systemRoot, filename), raw);
    return filename;
  };
  const source = (directory: string, target: string, track = false) =>
    `sources:\n  - resource: ${path.posix.relative(`.tent/${directory}`, target)}${target.endsWith("/") ? "/" : ""}\n${track ? "    track: structure\n" : ""}`;
  await node("Goal", "node-goal", "goal");
  await node("Goal/Far", "node-far", "prompt", "", "# Far\nKeep this sentence.\n");
  await node("Goal/Gap", "node-gap", "goal", "status: draft\n");
  await node("Goal/Gap/Near", "node-near", "goal");
  await node("Goal/Gap/Near/Rule", "node-nearrule", "prompt");
  const module = "Goal/Gap/Near/Module";
  await node(
    module,
    "node-module",
    "output",
    source(module, "src/core/", true),
    "# Raw\n  keep **bold**\r\n",
  );
  await node(`${module}/Rule`, "node-localrule", "prompt");
  await node(`${module}/Nested`, "node-nested", "output");
  await node(`${module}/Nested/Rule`, "node-nestedrule", "prompt");
  await node("Goal/Inactive", "node-inactiverule", "prompt", "status: deprecated\n");
  await node("Evidence", "node-evidence", "output", source("Evidence", "src/core/a.ts"));
  await node("Self", "node-self", "goal", source("Self", "src/core/a.ts"));
  await node("Self/Rule", "node-selfrule", "prompt");
  const currentFs = {
    readFile: (relative: string) => fs.readFile(path.join(systemRoot, relative), "utf8"),
    exists: (relative: string) =>
      fs.access(path.join(systemRoot, relative)).then(
        () => true,
        () => false,
      ),
    listDir: async (relative: string) =>
      (await fs.readdir(path.join(systemRoot, relative), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
      })),
  } as FsAdapter;
  const index = buildStopMaterialIndex(await loadNodeCatalog(currentFs), root);
  const selected = modulesForIndexedTurn(index, {
    files: [{ kind: "written", address: "src/core/a.ts" }],
  });
  return { root, systemRoot, node, currentFs, index, selected, bodies };
}

test("prepared rule IDs follow actual hierarchy through a draft parent and select direct prompts nearest first", async (t) => {
  const { index, selected, currentFs } = await fixture(t);
  assert.deepEqual(index.nodes.find((node) => node.nodeId === "node-module")!.ruleNodeIds, [
    "node-localrule",
    "node-nearrule",
    "node-far",
  ]);
  assert.deepEqual(index.nodes.find((node) => node.nodeId === "node-self")!.ruleNodeIds, [
    "node-selfrule",
  ]);
  assert.deepEqual(selected.map((node) => node.nodeId).sort(), [
    "node-evidence",
    "node-module",
    "node-self",
  ]);
  const reads: string[] = [];
  const loaded = await loadTurnReviewContent(
    {
      readFile: async (file) => {
        reads.push(file);
        return currentFs.readFile(file);
      },
    },
    index,
    selected,
  );
  assert.equal(
    loaded.find((node) => node.nodeId === "node-module")!.body,
    "# Raw\n  keep **bold**\r\n",
  );
  assert.deepEqual(
    loaded.find((node) => node.nodeId === "node-module")!.rules!.map((node) => node.nodeId),
    ["node-localrule", "node-nearrule", "node-far"],
  );
  assert.equal(reads.length, 7);
  assert.ok(!reads.some((file) => /Near\/Near|Nested|Inactive|Gap\/Gap/.test(file)));
});

test("material-only output and prompt Nodes include their own direct active prompts, including at the root", async (t) => {
  const { root, node, currentFs } = await fixture(t);
  await node("Evidence/Rule", "node-evidencerule", "prompt");
  await node("Evidence/Draft", "node-evidencedraft", "prompt", "status: draft\n");
  await node("Evidence/Nested", "node-evidencenested", "output");
  await node("Evidence/Nested/Rule", "node-nestedignored", "prompt");
  await node(
    "Goal/Gap/Near/MaterialPrompt",
    "node-materialprompt",
    "prompt",
    "sources:\n  - resource: ../../../../../src/core/a.ts\n",
  );
  await node("Goal/Gap/Near/MaterialPrompt/Rule", "node-materialrule", "prompt");
  const index = buildStopMaterialIndex(await loadNodeCatalog(currentFs), root);
  const output = index.nodes.find((candidate) => candidate.nodeId === "node-evidence")!;
  const prompt = index.nodes.find((candidate) => candidate.nodeId === "node-materialprompt")!;
  assert.deepEqual(output.moduleCoverage, []);
  assert.deepEqual(prompt.moduleCoverage, []);
  assert.deepEqual(output.ruleNodeIds, ["node-evidencedraft", "node-evidencerule"]);
  assert.deepEqual(prompt.ruleNodeIds, ["node-materialrule", "node-nearrule", "node-far"]);
  const selected = modulesForIndexedTurn(index, {
    files: [{ kind: "written", address: "src/core/a.ts" }],
  }).filter((candidate) => [output.nodeId, prompt.nodeId].includes(candidate.nodeId));
  assert.equal(selected.length, 2);
  const loaded = await loadTurnReviewContent(currentFs, index, selected);
  assert.deepEqual(
    loaded
      .find((candidate) => candidate.nodeId === output.nodeId)!
      .rules!.map((rule) => rule.nodeId),
    ["node-evidencedraft", "node-evidencerule"],
  );
  assert.deepEqual(
    loaded
      .find((candidate) => candidate.nodeId === prompt.nodeId)!
      .rules!.map((rule) => rule.nodeId),
    ["node-materialrule", "node-nearrule", "node-far"],
  );
});

test("owners, shared rules and excluded claims are deduped without loading unrelated bodies", async (t) => {
  const { index, selected, currentFs } = await fixture(t);
  const module = selected.find((node) => node.nodeId === "node-module")!;
  const far = index.nodes.find((node) => node.nodeId === "node-far")!;
  const other = index.nodes.find((node) => node.nodeId === "node-evidence")!;
  other.ruleNodeIds = ["node-localrule", "node-far"];
  const reads: string[] = [];
  const loaded = await loadTurnReviewContent(
    {
      readFile: async (file) => {
        reads.push(file);
        return currentFs.readFile(file);
      },
    },
    index,
    [module, module, { ...far, files: ["src/core/a.ts"] }, { ...other, files: ["src/core/a.ts"] }],
    new Set(["node-nearrule"]),
  );
  assert.equal(reads.length, new Set(reads).size);
  assert.ok(!reads.some((file) => /Near\/Rule\/Rule/.test(file)));
  const output = formatToolTurnReview(8192, loaded)!;
  assert.deepEqual(output.nodeIds, ["node-module", "node-localrule", "node-far", "node-evidence"]);
  assert.deepEqual(output.ownerNodeIds, ["node-module", "node-far", "node-evidence"]);
  assert.deepEqual(output.ruleNodeIds, ["node-localrule"]);
  assert.equal(output.message.split("(node-localrule,").length - 1, 1);
});

test("claim reprojection moves shared observed rules to a surviving owner and drops orphan or excluded rules without reads", async (t) => {
  const { index, selected, currentFs } = await fixture(t);
  const module = selected.find((node) => node.nodeId === "node-module")!;
  const evidence = selected.find((node) => node.nodeId === "node-evidence")!;
  index.nodes.find((node) => node.nodeId === evidence.nodeId)!.ruleNodeIds = [
    "node-localrule",
    "node-far",
  ];
  let reads = 0;
  const original = await loadTurnReviewContent(
    {
      readFile: async (file) => {
        reads++;
        return currentFs.readFile(file);
      },
    },
    index,
    [module, evidence],
  );
  const before = structuredClone(original);
  const observedReads = reads;
  assert.deepEqual(
    original[0].rules!.map((node) => node.nodeId),
    ["node-localrule", "node-nearrule", "node-far"],
  );
  assert.deepEqual(original[1].rules, []);
  const projected = reprojectTurnReviewContent(index, original, new Set(["node-module"]));
  assert.deepEqual(
    reprojectTurnReviewContent(index, [...original, original[1]], new Set(["node-module"])),
    projected,
  );
  assert.deepEqual(
    projected.map((node) => node.nodeId),
    ["node-evidence"],
  );
  assert.deepEqual(
    projected[0].rules!.map((node) => node.nodeId),
    ["node-localrule", "node-far"],
  );
  assert.equal(projected[0].rules![0].body, original[0].rules![0].body);
  assert.deepEqual(formatToolTurnReview(8192, projected)!.nodeIds, [
    "node-evidence",
    "node-localrule",
    "node-far",
  ]);
  const withoutClaimedRule = reprojectTurnReviewContent(
    index,
    original,
    new Set(["node-module", "node-localrule"]),
  );
  assert.deepEqual(
    withoutClaimedRule[0].rules!.map((node) => node.nodeId),
    ["node-far"],
  );
  assert.equal(reads, observedReads);
  assert.deepEqual(original, before);
});

test("Hook text copies bodies verbatim and returns exactly the delivered owner and rule IDs", () => {
  const body = "# Original\r\n  **Keep this**\n";
  const module: TurnReviewModule = {
    nodeId: "node-module",
    names: ["Module"],
    path: ".tent/Module/Module.md",
    files: ["src/a.ts"],
    body,
    rules: [
      { nodeId: "node-rule", names: ["Rule"], path: ".tent/Rule/Rule.md", body: "Do this.\n" },
    ],
  };
  const output = formatToolTurnReview(8192, [module])!;
  assert.equal(
    output.message,
    `Tent: these Nodes cover the file you just changed.\n\nModule (node-module, .tent/Module/Module.md) covers src/a.ts:\n${body}\n\nRules over it:\nRule (node-rule, .tent/Rule/Rule.md):\nDo this.\n\n\n${TOOL_REVIEW_ACTION}`,
  );
  assert.deepEqual(output.nodeIds, ["node-module", "node-rule"]);
  assert.deepEqual(output.ownerNodeIds, ["node-module"]);
  assert.deepEqual(output.ruleNodeIds, ["node-rule"]);
  assert.match(
    formatToolTurnReview(8192, [module], "turn")!.message,
    /^Tent: these Nodes cover files changed during this turn\./,
  );
});

test("per-Node cuts use 1600 Unicode code points and budget cuts preserve whole characters", () => {
  const module: TurnReviewModule = {
    nodeId: "node-a",
    names: ["A"],
    path: ".tent/A/A.md",
    files: ["src/a.ts"],
    body: "😀".repeat(1601),
  };
  const complete = formatToolTurnReview(8192, [module])!;
  assert.ok(
    complete.message.includes("😀".repeat(1600) + "\n… (cut; the rest is in .tent/A/A.md)"),
  );
  assert.ok(!complete.message.includes("😀".repeat(1601)));
  for (const budget of [850, 1600, 4000]) {
    const output = formatToolTurnReview(budget, [module])!;
    assert.ok(Buffer.byteLength(output.message) <= budget);
    assert.ok(!output.message.includes("�"));
    assert.match(output.message, /… \(cut; the rest is in \.tent\/A\/A\.md\)/);
    assert.deepEqual(output.nodeIds, ["node-a"]);
  }
});

test("byte budgeting reports every omitted unique Node with the exact resource search command", () => {
  const modules: TurnReviewModule[] = Array.from({ length: 12 }, (_, i) => ({
    nodeId: `node-${i}`,
    names: [`M${i}`],
    path: `.tent/M${i}/M${i}.md`,
    files: ["src/a.ts"],
    body: "汉😀".repeat(1000),
    rules: [{ nodeId: "node-rule", names: ["R"], path: ".tent/R/R.md", body: "shared\n" }],
  }));
  const output = formatToolTurnReview(8192, modules)!;
  assert.ok(Buffer.byteLength(output.message) <= 8192);
  assert.ok(output.nodeIds.length < 13);
  assert.ok(
    output.message.includes(
      `${13 - output.nodeIds.length} more Nodes: tent node search --resource src/a.ts`,
    ),
  );
  assert.equal(output.nodeIds.length, new Set(output.nodeIds).size);
  assert.equal(formatToolTurnReview(20, modules), undefined);
});

test("oversized owner metadata or file lists still deliver omitted count and search without claiming Nodes", () => {
  const module: TurnReviewModule = {
    nodeId: "node-a",
    names: ["A"],
    path: ".tent/A/A.md",
    files: ["src/a.ts"],
    body: "Body\n",
    rules: [{ nodeId: "node-rule", names: ["Rule"], path: ".tent/Rule/Rule.md", body: "Rule\n" }],
  };
  for (const oversized of [
    { ...module, names: ["A".repeat(9000)] },
    {
      ...module,
      files: ["src/a.ts", ...Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`)],
    },
  ]) {
    const output = formatToolTurnReview(8192, [oversized])!;
    assert.ok(Buffer.byteLength(output.message) <= 8192);
    assert.ok(output.message.includes("2 more Nodes: tent node search --resource src/a.ts"));
    assert.deepEqual(output.nodeIds, []);
    assert.deepEqual(output.ownerNodeIds, []);
    assert.deepEqual(output.ruleNodeIds, []);
  }
});

test("selected reads reject changed identity, invalid metadata and missing rules, while body-only edits are current", async (t) => {
  const { systemRoot, index, selected, currentFs } = await fixture(t);
  const module = index.nodes.find((node) => node.nodeId === "node-module")!;
  const filename = path.join(systemRoot, module.path.slice(6));
  const raw = await fs.readFile(filename, "utf8");
  await fs.writeFile(filename, raw.replace("# Raw", "# Current"));
  let loaded = await loadTurnReviewContent(currentFs, index, selected);
  assert.ok(loaded.find((node) => node.nodeId === "node-module")!.body!.startsWith("# Current"));
  for (const changed of [
    raw.replace("id: node-module", "id: node-other"),
    raw.replace("type: output", "type: ["),
    raw.replace("---\n# Raw", "# Raw"),
  ]) {
    await fs.writeFile(filename, changed);
    loaded = await loadTurnReviewContent(currentFs, index, selected);
    assert.ok(!loaded.some((node) => node.nodeId === "node-module"));
  }
  await fs.writeFile(filename, raw);
  const rule = index.nodes.find((node) => node.nodeId === "node-localrule")!;
  await fs.rm(path.join(systemRoot, rule.path.slice(6)));
  loaded = await loadTurnReviewContent(currentFs, index, selected);
  assert.ok(loaded.some((node) => node.nodeId === "node-module"));
  assert.ok(
    !loaded.flatMap((node) => node.rules ?? []).some((node) => node.nodeId === "node-localrule"),
  );
});

test("native Hook content reads create no history or cache state and reject directory replacements", async (t) => {
  const { systemRoot, index, selected } = await fixture(t);
  const before = await fs.readdir(systemRoot, { recursive: true });
  const loaded = await loadHookTurnReviewContent(systemRoot, index, selected);
  assert.equal(loaded.length, 3);
  assert.equal(
    loaded.find((node) => node.nodeId === "node-module")!.body,
    "# Raw\n  keep **bold**\r\n",
  );
  assert.deepEqual(await fs.readdir(systemRoot, { recursive: true }), before);
  const filename = path.join(
    systemRoot,
    index.nodes.find((node) => node.nodeId === "node-module")!.path.slice(6),
  );
  await fs.rm(filename);
  await fs.mkdir(filename);
  assert.ok(
    !(await loadHookTurnReviewContent(systemRoot, index, selected)).some(
      (node) => node.nodeId === "node-module",
    ),
  );
});

test("native Hook reads reject malformed UTF-8 instead of rewriting the delivered body", async (t) => {
  const { systemRoot, index, selected } = await fixture(t);
  const module = index.nodes.find((node) => node.nodeId === "node-module")!;
  const filename = path.join(systemRoot, module.path.slice(6));
  const raw = await fs.readFile(filename);
  await fs.writeFile(filename, Buffer.concat([raw, Buffer.from([0xff])]));
  const loaded = await loadHookTurnReviewContent(systemRoot, index, selected);
  assert.ok(!loaded.some((node) => node.nodeId === "node-module"));
  assert.equal(loaded.length, 2);
});

test("Hook body splitting shares BOM, CRLF, closing-fence whitespace and missing-fence boundaries with frontmatter parsing", () => {
  for (const raw of [
    "---\nid: node-a\n---\nBody\n",
    "\uFEFF--- \t\r\nid: node-a\r\n--- \t\r\n\nBody\r\n",
    "---\nid: node-a\n---",
  ]) {
    assert.equal(turnReviewDocument(raw).body, parseFrontmatter(raw).body);
  }
  assert.throws(() => turnReviewDocument("---\nid: node-a\n"));
  assert.throws(() => turnReviewDocument("Body\n"));
});

test("prepared rules keep active child prompts through stable, draft and deprecated ancestor goals", async (t) => {
  const { root, node, currentFs } = await fixture(t);
  await node("Goal/Gap/Current", "node-gapcurrent", "prompt");
  await node("Goal/Gap/Draft", "node-gapdraft", "prompt", "status: draft\n");
  await node("Goal/Gap/Retired", "node-gapretired", "prompt", "status: deprecated\n");
  const expected = [
    "node-localrule",
    "node-nearrule",
    "node-gapcurrent",
    "node-gapdraft",
    "node-far",
  ];
  for (const status of ["stable", "draft", "deprecated"]) {
    await node(
      "Goal/Gap",
      "node-gap",
      "goal",
      `status: ${status}\n`,
      "Ancestor body stays separate.\n",
    );
    const index = buildStopMaterialIndex(await loadNodeCatalog(currentFs), root);
    assert.equal(
      index.nodes.some((node) => node.nodeId === "node-gap"),
      status !== "deprecated",
    );
    const module = index.nodes.find((node) => node.nodeId === "node-module")!;
    assert.deepEqual(module.ruleNodeIds, expected);
    const selected = modulesForIndexedTurn(index, {
      files: [{ kind: "written", address: "src/core/a.ts" }],
    }).filter((node) => node.nodeId === module.nodeId);
    const loaded = await loadTurnReviewContent(currentFs, index, selected);
    assert.deepEqual(
      loaded[0].rules!.map((rule) => rule.nodeId),
      expected,
    );
    assert.doesNotMatch(JSON.stringify(loaded), /Ancestor body stays separate/);
  }
});
