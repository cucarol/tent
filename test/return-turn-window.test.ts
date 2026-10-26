import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readCodexTurnActivity, codexHookAdapter } from "../src/cli/codex-turn-activity.js";
import { readClaudeTurnActivity, claudeHookAdapter } from "../src/cli/claude-turn-activity.js";
import { stopReviewOutput } from "../src/cli/hook-adapter.js";
import { modulesForIndexedTurn } from "../src/core/return/stop-turn-review.js";
import { stopAdvice } from "../src/core/return/stop-advice.js";
import type { StopMaterialIndex } from "../src/core/return/stop-material-index.js";
import type { SessionObservationEvent } from "../src/core/return/session-observations.js";

async function fixture(t: TestContext) {
  await fs.mkdir(".scratch", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(testScratchRoot(), "return-window-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const log = path.join(root, "transcript.jsonl");
  return {
    root,
    log,
    write: (rows: unknown[]) =>
      fs.writeFile(log, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"),
  };
}
const context = (turn_id: string) => ({ type: "turn_context", payload: { turn_id } });
const start = (turn_id: string) => ({
  type: "event_msg",
  payload: { type: "task_started", turn_id },
});
const changed = (name: string) => ({
  type: "event_msg",
  payload: {
    type: "item_completed",
    turn_id: "target",
    item: { type: "FileChange", status: "completed", changes: { [name]: { type: "update" } } },
  },
});
const padding = {
  type: "response_item",
  payload: { type: "message", role: "assistant", content: "界".repeat(400_000) },
};

test("Codex reads past one MiB and repeated contexts to the requested turn's first writes", async (t) => {
  const f = await fixture(t);
  for (const first of [start("target"), context("target")]) {
    await f.write([
      start("previous"),
      changed("previous.ts"),
      first,
      changed("early.ts"),
      padding,
      context("target"),
      changed("late.ts"),
      start("next"),
    ]);
    const activity = await readCodexTurnActivity(f.log, f.root, "target");
    assert.deepEqual(
      activity.observations.filter((file) => file.kind === "written").map((file) => file.address),
      ["early.ts", "late.ts"],
    );
    assert.equal(activity.uncertain, false);
  }
});

test("Codex keeps uncertainty when eight MiB omits the start despite a later same-turn context", async (t) => {
  const f = await fixture(t);
  await f.write([
    start("target"),
    changed("early.ts"),
    ...Array(8).fill(padding),
    context("target"),
    changed("late.ts"),
  ]);
  const activity = await readCodexTurnActivity(f.log, f.root, "target");
  assert.deepEqual(
    activity.observations.filter((file) => file.kind === "written").map((file) => file.address),
    ["late.ts"],
  );
  assert.equal(activity.uncertain, true);
});

test("Claude reads back across large tool results to the top-level prompt and caps missing starts", async (t) => {
  const f = await fixture(t);
  const prompt = { type: "user", promptId: "target", message: { content: "please edit" } };
  const call = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "write", name: "Write", input: { file_path: "early.ts" } }],
    },
  };
  const result = {
    type: "user",
    promptId: "target",
    message: {
      content: [{ type: "tool_result", tool_use_id: "write", content: "界".repeat(400_000) }],
    },
    toolUseResult: { type: "create", filePath: "early.ts" },
  };
  await f.write([
    prompt,
    call,
    result,
    { ...prompt, isSidechain: true },
    { ...prompt, promptId: "next" },
  ]);
  const activity = await readClaudeTurnActivity(f.log, f.root, "target");
  assert.deepEqual(
    activity.observations.map((o) => o.address),
    ["early.ts"],
  );
  assert.equal(activity.uncertain, false);
  await f.write([prompt, call, ...Array(8).fill(result)]);
  const capped = await readClaudeTurnActivity(f.log, f.root, "target");
  assert.deepEqual(capped.observations, []);
  assert.equal(capped.uncertain, true);
});

test("Stop ranks distinct written files before module truncation and leaves uncertainty internal", () => {
  const index: StopMaterialIndex = {
    nodes: Array.from({ length: 7 }, (_, i) => ({
      nodeId: `node-${i}`,
      path: `.tent/${i}/${i}.md`,
      names: [`M${i}`],
      moduleCoverage: [{ kind: "directory", prefix: `src/${i}/` }],
    })),
  };
  const addresses = [
    ...Array.from({ length: 7 }, (_, i) => `src/${i}/a.ts`),
    "src/6/b.ts",
    "src/5/b.ts",
    "src/6/c.ts",
    "src/0/a.ts",
  ];
  const event: SessionObservationEvent = {
    turnId: "turn",
    files: addresses.map((address) => ({
      kind: "written",
      address,
    })),
    signals: [],
    uncertain: true,
  };
  event.files.push({ ...event.files[0]!, kind: "read", address: "src/0/read.ts" });
  assert.deepEqual(
    modulesForIndexedTurn(index, event).map((m) => m.nodeId),
    ["node-6", "node-5", "node-0", "node-1", "node-2", "node-3", "node-4"],
  );
  for (const adapter of [codexHookAdapter, claudeHookAdapter]) {
    let message = "";
    const output = stopReviewOutput(adapter, (budget) => {
      message = stopAdvice(index, event, budget)!;
      return message;
    });
    assert.ok(output);
    assert.deepEqual(
      [...message.matchAll(/^- .*\((node-\d),/gm)].map((m) => m[1]),
      ["node-6", "node-5", "node-0", "node-1", "node-2"],
    );
    assert.match(message, /\+2 more modules/);
    assert.doesNotMatch(message, /Some observations are incomplete/);
  }
  assert.equal(event.uncertain, true);
});
