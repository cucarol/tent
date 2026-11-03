import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot, initializeFixtureWorkspace } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";

for (const count of [12, 120])
  test(`create retains the full native document and all ${count} problem receipts`, async (t) => {
    const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "node-create-receipt-"));
    t.after(() => removeTestFixture(workspace, { recursive: true, force: true }));
    await initializeFixtureWorkspace(workspace);
    const body =
      "Saved content.\n".repeat(3000) +
      Array.from({ length: count }, (_, index) => `[missing ${index}](node-missing${index})`).join(
        "\n",
      );
    const result = await runNodeCommand("create", ["Receipt", "--type", "prompt", "--body", body], {
      workspace,
      json: true,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.problems.length, count);
    const raw = await fs.readFile(path.join(workspace, receipt.node.path), "utf8");
    assert.equal(parseFrontmatter(raw).body, body);
    assert.equal(typeof receipt.node.nodeId, "string");
    assert.equal("text" in receipt.node, false);
  });
