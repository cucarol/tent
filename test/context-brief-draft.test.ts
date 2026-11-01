import assert from "node:assert/strict";
import test from "node:test";
import {
  formatContextBrief,
  inspectCurrentContext,
  makeContextBrief,
} from "../src/core/read/context-brief.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { PropagationMemoryFs } from "./propagation-memory.js";

test("draft Nodes enter ordinary discovery without a separate draft warning", async () => {
  const fs = new PropagationMemoryFs();
  await fs.writeFile("index.md", '---\nokf_version: "0.2"\n---\n');
  for (const type of ["goal", "prompt", "output"])
    await fs.writeFile(
      `${type}/${type}.md`,
      `---\nid: node-${type}\ntype: ${type}\nstatus: draft\n---\nPrivate body\n`,
    );
  const catalog = await loadNodeCatalog(fs);
  const context = await inspectCurrentContext(fs, {
    nodes: Promise.resolve({ invalidNodes: [], catalog }),
  });
  assert.deepEqual(context.sync.nodes.map((node) => node.nodeId).sort(), [
    "node-goal",
    "node-output",
    "node-prompt",
  ]);
  assert.equal("draftCount" in context, false);
  const brief = makeContextBrief(context);
  assert.equal("drafts" in brief, false);
  assert.doesNotMatch(formatContextBrief(brief), /还没定|--status draft|Private body/);
});

test("draft discovery preserves transaction recovery reporting", async () => {
  const fs = Object.assign(new PropagationMemoryFs(), { recoveryConflicts: ["B/B.md"] });
  await fs.writeFile(
    "Draft/Draft.md",
    "---\nid: node-draft\ntype: prompt\nstatus: draft\n---\nPrivate body\n",
  );
  const context = await inspectCurrentContext(fs);
  assert.deepEqual(context.recoveryConflicts, ["B/B.md"]);
  assert.ok(context.sync.nodes.some((node) => node.nodeId === "node-draft"));
  const brief = makeContextBrief(context);
  assert.deepEqual(brief.recoveryConflicts, ["B/B.md"]);
  assert.match(
    formatContextBrief(brief),
    /Transaction recovery kept external edits:\n- \.tent\/B\/B.md/,
  );
  assert.equal("drafts" in brief, false);
});
