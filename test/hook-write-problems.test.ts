import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { toolReviewOutput } from "../src/cli/hook-adapter.js";
import { runToolHook } from "../src/cli/tool-hook.js";
import type { NodeWriteProblem } from "../src/core/check/node-write-problems.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import {
  captureFixtureDocuments,
  historyHead,
  initializeFixtureHistory,
  testScratchRoot,
} from "./scratch.js";

test("Node problem notices budget the actual JSON and preserve covering claims", () => {
  const problems: NodeWriteProblem[] = Array.from({ length: 15 }, (_, index) => ({
    category: "error",
    path: ".tent/Selected/Selected.md",
    reason: `${index}: ${'"\\\n😀'.repeat(4000)}`,
  }));
  const result = toolReviewOutput([], [], problems)!;
  assert.ok(Buffer.byteLength(result.stdout) <= 8192);
  const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /^Tent: \.tent\/Selected\/Selected\.md has problems:/);
  assert.match(text, /…\n14 more problems: tent workspace check --json\nFix them/);
  assert.deepEqual(result.nodeIds, []);
  assert.deepEqual(result.files, []);
  const mixed = toolReviewOutput(
    [
      {
        nodeId: "node-code",
        path: ".tent/Code/Code.md",
        names: ["Code"],
        files: ["src/a.ts"],
        body: "Keep the rule.",
      },
    ],
    [],
    [{ category: "error", path: ".tent/Selected/Selected.md", reason: "Broken link." }],
  )!;
  assert.ok(Buffer.byteLength(mixed.stdout) <= 8192);
  assert.match(mixed.stdout, /Broken link/);
  assert.match(mixed.stdout, /Keep the rule/);
  assert.deepEqual(mixed.ownerNodeIds, ["node-code"]);
  assert.deepEqual(mixed.ruleNodeIds, []);
});

test("both native hosts report only the written Node and leave its history unchanged", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "hook-write-problems-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(openTestFs(root), {
    name: "Hook checks",
    nodes: [
      { id: "node-selected", name: "Selected", type: "prompt", body: "Clean." },
      { id: "node-other", name: "Other", type: "prompt", body: "Clean." },
    ],
  });
  const system = path.join(root, ".tent");
  await initializeFixtureHistory(system);
  await captureFixtureDocuments(system);
  await loadStopMaterialIndex(system, root);
  const selected = path.join(system, "Selected/Selected.md");
  const other = path.join(system, "Other/Other.md");
  const clean = await fs.readFile(selected, "utf8");
  await fs.appendFile(selected, "\n[Broken](./missing.md)\n");
  await fs.appendFile(other, "\n[Other broken](./unrelated.md)\n");
  const retained = await historyHead(system);
  for (const host of ["codex", "claude-code"] as const) {
    const event = {
      hook_event_name: "PostToolUse",
      cwd: root,
      session_id: "node-check",
      turn_id: "turn",
      prompt_id: "turn",
      tool_name: host === "codex" ? "apply_patch" : "Write",
      tool_input:
        host === "codex" ? { command: "*** Begin Patch\n*** End Patch" } : { file_path: selected },
      tool_response:
        host === "codex"
          ? "Success. Updated the following files:\nM .tent/Selected/Selected.md\n"
          : { type: "update", filePath: selected },
    };
    const output = await runToolHook(host, event);
    assert.ok(Buffer.byteLength(output) <= 8192);
    const message = JSON.parse(output).hookSpecificOutput.additionalContext;
    assert.match(message, /^Tent: \.tent\/Selected\/Selected\.md has problems:/);
    assert.match(message, /missing\.md/);
    assert.doesNotMatch(message, /unrelated\.md|Other\/Other\.md/);
    assert.equal(await historyHead(system), retained);
    await fs.writeFile(selected, clean);
    assert.equal(await runToolHook(host, event), "{}\n");
    assert.equal(await historyHead(system), retained);
    await fs.appendFile(selected, "\n[Broken](./missing.md)\n");
  }
});
