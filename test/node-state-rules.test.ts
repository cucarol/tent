import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { buildStopMaterialIndex } from "../src/core/return/stop-material-index.js";
import { goalAncestors } from "../src/core/graph/node-sync-record.js";
import { readGoalContext } from "../src/core/read/goal-context.js";
import { searchNodeResources } from "../src/core/read/node-resource-search.js";

test("Stop rules filter local status while output goal associations preserve retired ancestors", async () => {
  const fs = new PropagationMemoryFs();
  const node = (folder: string, id: string, type: string, status = "stable") =>
    fs.writeFile(
      `${folder}/${path.posix.basename(folder)}.md`,
      serializeFrontmatter(
        { id, type, status, resource: "https://example.com/material" },
        "Rule body.",
      ),
    );
  await node("A", "node-a", "goal", "deprecated");
  await node("A/Prompt", "node-prompt", "prompt");
  await node("A/Draft", "node-draft", "prompt", "draft");
  await node("A/Retired", "node-retired", "prompt", "deprecated");
  await node("A/Unknown", "node-unknown", "prompt", "future");
  await node("A/UnknownGoal", "node-unknowngoal", "goal", "future");
  await node("A/UnknownGoal/B", "node-b", "goal", "draft");
  await node("A/UnknownGoal/B/Output", "node-output", "output");
  const catalog = await loadNodeCatalog(fs);
  const stop = buildStopMaterialIndex(catalog, path.resolve(".scratch/state-rules"));
  assert.deepEqual(stop.nodes.find((node) => node.nodeId === "node-b")!.ruleNodeIds!.sort(), [
    "node-draft",
    "node-prompt",
  ]);
  assert.deepEqual(
    goalAncestors(catalog.byId.get("node-output")!, catalog.byId).map((node) => node.nodeId),
    ["node-b", "node-unknowngoal", "node-a"],
  );
  assert.deepEqual(
    (await readGoalContext(fs, "node-output"))
      .filter((item) => item.kind === "goal")
      .map((item) => item.id),
    ["node-b", "node-unknowngoal", "node-a"],
  );
  const hits = await searchNodeResources(fs, "ws", path.resolve(".scratch/state-rules"), {
    resource: "https://example.com/material",
  });
  assert.deepEqual(hits.items.map((item) => item.nodeId).sort(), [
    "node-b",
    "node-draft",
    "node-output",
    "node-prompt",
  ]);
});
