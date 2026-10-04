import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { readCodexTurnActivity } from "../src/cli/codex-turn-activity.js";
import { appendSessionObservations } from "../src/core/session-observations.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { observeSessionFile } from "../src/fs/session-observations.js";

const timestamp = "2026-10-04T03:00:00.000Z";
const start = (turn = "turn") => ({
  timestamp,
  type: "event_msg",
  payload: { type: "task_started", turn_id: turn },
});
const item = (value: unknown, turn = "turn") => ({
  timestamp,
  type: "event_msg",
  payload: { type: "item_completed", turn_id: turn, item: value },
});
const response = (payload: unknown) => ({ timestamp, type: "response_item", payload });
async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "codex-observations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const log = path.join(root, "transcript.jsonl");
  const read = async (rows: unknown[], turn: unknown = "turn") => {
    await fs.writeFile(
      log,
      rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n",
    );
    return readCodexTurnActivity(log, workspace, turn);
  };
  return { root, workspace, log, read };
}

test("Codex structured user attachments, completed reads and writes produce only metadata", async (t) => {
  const { root, workspace, read } = await fixture(t);
  const outside = pathToFileURL(path.join(root, "attachment.png")).href;
  const activity = await read([
    start(),
    response({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "请实现这个需求，确认采用此方案 CHAT SECRET src/guessed.txt" },
        { type: "input_file", file_path: path.join(workspace, "input.pdf") },
        { type: "input_image", image_url: outside },
        { type: "input_image", image_url: "data:image/png;base64,SECRET" },
      ],
    }),
    item({
      type: "CommandExecution",
      status: "completed",
      exit_code: 0,
      parsed_cmd: [
        { type: "read", path: "src/fact.ts", cmd: "cat src/fact.ts", name: "fact.ts" },
        { type: "search", path: "src" },
      ],
      output: "TOOL SECRET",
    }),
    item({
      type: "FileChange",
      status: "completed",
      changes: {
        "src/old.ts": { type: "update", move_path: "src/new.ts", content: "BODY SECRET" },
      },
    }),
  ]);
  assert.deepEqual(
    activity.observations.map(({ kind, address }) => [kind, address]),
    [
      ["provided", "input.pdf"],
      ["provided", outside],
      ["read", "src/fact.ts"],
      ["written", "src/new.ts"],
    ],
  );
  assert.ok(activity.observations.every((observation) => observation.eventAt === timestamp));
  assert.deepEqual(activity.signals, ["possible-decision"]);
  assert.deepEqual(activity.paths, ["src/old.ts", "src/new.ts"]);
  assert.equal(activity.uncertain, false);
  assert.equal(JSON.stringify(activity).includes("SECRET"), false);
  assert.equal(JSON.stringify(activity).includes("guessed.txt"), false);
});

test("raw Codex apply_patch custom tool events need a matched successful output; shell writes stay uncertain", async (t) => {
  const { read } = await fixture(t);
  const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+SECRET CONTENT\n*** End Patch";
  const activity = await read([
    start(),
    response({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: patch }),
    response({
      type: "custom_tool_call_output",
      call_id: "patch",
      output: JSON.stringify({
        output: "Success. Updated the following files:\nA src/new.ts\n",
        metadata: { exit_code: 0 },
      }),
    }),
    response({
      type: "function_call",
      call_id: "shell",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "Set-Content guessed.txt SECRET" }),
    }),
    response({
      type: "function_call_output",
      call_id: "shell",
      output: "Process exited with code 0\nSECRET",
    }),
  ]);
  assert.deepEqual(activity.paths, ["src/new.ts"]);
  assert.equal(activity.uncertain, true);
  assert.equal(JSON.stringify(activity).includes("SECRET"), false);
  assert.equal(JSON.stringify(activity).includes("guessed.txt"), false);
  const failed = await read([
    start(),
    response({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: patch }),
    response({
      type: "custom_tool_call_output",
      call_id: "patch",
      output: JSON.stringify({
        output: "Success. Updated the following files:\nA src/new.ts",
        metadata: { exit_code: 1 },
      }),
    }),
  ]);
  assert.deepEqual(failed.observations, []);
  assert.equal(failed.uncertain, true);
});

test("structured deletions and move sources are activity paths, never written outputs", async (t) => {
  const { read } = await fixture(t);
  const activity = await read([
    start(),
    item({
      type: "FileChange",
      status: "completed",
      changes: {
        "removed.txt": { type: "delete" },
        "old.txt": { type: "update", move_path: "moved.txt" },
        "added.txt": { type: "add" },
        "updated.txt": { type: "update", move_path: null },
      },
    }),
  ]);
  assert.deepEqual(
    activity.observations.map((event) => [event.kind, event.address]),
    [
      ["written", "moved.txt"],
      ["written", "added.txt"],
      ["written", "updated.txt"],
    ],
  );
  assert.deepEqual(activity.paths, [
    "removed.txt",
    "old.txt",
    "moved.txt",
    "added.txt",
    "updated.txt",
  ]);
  assert.equal(activity.hasFileChanges, true);
  assert.equal(activity.uncertain, false);
  const deletion = await read([
    start(),
    item({
      type: "FileChange",
      status: "completed",
      changes: { "only-deleted.txt": { type: "delete" } },
    }),
  ]);
  assert.deepEqual(deletion.observations, []);
  assert.deepEqual(deletion.paths, ["only-deleted.txt"]);
  assert.equal(deletion.hasFileChanges, true);
  assert.equal(deletion.uncertain, false);
  const unknown = await read([
    start(),
    item({
      type: "FileChange",
      status: "completed",
      changes: { "unknown.txt": {}, "future.txt": { type: "unknown" } },
    }),
  ]);
  assert.deepEqual(unknown.observations, []);
  assert.deepEqual(unknown.paths, ["unknown.txt", "future.txt"]);
  assert.equal(unknown.uncertain, true);
});

test("successful raw patch operations record only add/update/move destinations as outputs", async (t) => {
  const { read } = await fixture(t);
  const patch = [
    "*** Begin Patch",
    "*** Delete File: removed.txt",
    "*** Update File: old.txt",
    "*** Move to: moved.txt",
    "@@",
    "-old",
    "+new",
    "*** Add File: added.txt",
    "+added",
    "*** Update File: updated.txt",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const activity = await read([
    start(),
    response({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: patch }),
    response({
      type: "custom_tool_call_output",
      call_id: "patch",
      output:
        "Success. Updated the following files:\nD removed.txt\nM moved.txt\nA added.txt\nM updated.txt\n",
    }),
  ]);
  assert.deepEqual(
    activity.observations.map((event) => event.address),
    ["moved.txt", "added.txt", "updated.txt"],
  );
  assert.deepEqual(activity.paths, [
    "removed.txt",
    "old.txt",
    "moved.txt",
    "added.txt",
    "updated.txt",
  ]);
  assert.equal(activity.uncertain, false);
  const deletion = await read([
    start(),
    response({
      type: "custom_tool_call",
      call_id: "patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Delete File: removed.txt\n*** End Patch",
    }),
    response({
      type: "custom_tool_call_output",
      call_id: "patch",
      output: "Success. Updated the following files:\nD removed.txt\n",
    }),
  ]);
  assert.deepEqual(deletion.observations, []);
  assert.deepEqual(deletion.paths, ["removed.txt"]);
  assert.equal(deletion.hasFileChanges, true);
  assert.equal(deletion.uncertain, false);
});

test("a proven earlier write missing at Stop has an uncertain version, never a successful output hash", async (t) => {
  const { workspace, read } = await fixture(t);
  const filename = path.join(workspace, "later-deleted.txt");
  await fs.writeFile(filename, "earlier written bytes");
  const activity = await read([
    start(),
    item({
      type: "FileChange",
      status: "completed",
      changes: { "later-deleted.txt": { type: "add" } },
    }),
    item({
      type: "FileChange",
      status: "completed",
      changes: { "later-deleted.txt": { type: "delete" } },
    }),
  ]);
  // Preserve the evidenced earlier write, but the final file no longer has observable bytes.
  assert.deepEqual(
    activity.observations.map((event) => event.address),
    ["later-deleted.txt"],
  );
  await fs.unlink(filename);
  const result = await appendSessionObservations(
    new NodeFs(path.join(workspace, ".tent")),
    "session",
    "turn",
    activity,
    (address) => observeSessionFile(workspace, address),
  );
  assert.equal(result.event.files[0]!.version.state, "uncertain");
  assert.equal("sha256" in result.event.files[0]!.version, false);
  assert.equal(result.event.uncertain, true);
});

test("explicit view_image parameters and local_images are observed without using image bytes", async (t) => {
  const { workspace, read } = await fixture(t);
  const activity = await read([
    start(),
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "image",
        local_images: [path.join(workspace, "image.png")],
      },
    },
    response({
      type: "function_call",
      call_id: "image",
      name: "functions.view_image",
      arguments: JSON.stringify({ path: path.join(workspace, "image.png") }),
    }),
    response({
      type: "function_call_output",
      call_id: "image",
      output: JSON.stringify({ image_url: "data:image/png;base64,SECRET" }),
    }),
  ]);
  assert.deepEqual(
    activity.observations.map(({ kind, address }) => [kind, address]),
    [
      ["provided", "image.png"],
      ["read", "image.png"],
    ],
  );
  assert.equal(activity.uncertain, false);
  assert.equal(JSON.stringify(activity).includes("SECRET"), false);
});

test("structured read paths resolve against the command cwd instead of silently assuming the Workspace", async (t) => {
  const { workspace, root, read } = await fixture(t);
  const outside = path.join(root, "other");
  const activity = await read([
    start(),
    item({
      type: "CommandExecution",
      status: "completed",
      cwd: path.join(workspace, "src"),
      parsed_cmd: [{ type: "read", path: "fact.ts" }],
    }),
    item({
      type: "CommandExecution",
      status: "completed",
      cwd: outside,
      parsed_cmd: [{ type: "read", path: "outside.txt" }],
    }),
  ]);
  assert.deepEqual(
    activity.observations.map((file) => file.address),
    ["src/fact.ts", pathToFileURL(path.join(outside, "outside.txt")).href],
  );
  assert.equal(activity.uncertain, false);
});

test("turn scope rejects foreign items/calls and retains proven files when cancelled or partially malformed", async (t) => {
  const { read } = await fixture(t);
  const activity = await read([
    start("old"),
    item(
      { type: "FileChange", status: "completed", changes: { "old.ts": { type: "update" } } },
      "old",
    ),
    start(),
    item(
      { type: "FileChange", status: "completed", changes: { "foreign.ts": { type: "update" } } },
      "foreign",
    ),
    response({
      type: "function_call_output",
      call_id: "old-call",
      output: "Success. Updated the following files:\nA invented.ts",
    }),
    item({ type: "FileChange", status: "completed", changes: { "known.ts": { type: "update" } } }),
    "{bad JSON SECRET",
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn" } },
    start("next"),
    item(
      { type: "FileChange", status: "completed", changes: { "next.ts": { type: "update" } } },
      "next",
    ),
  ]);
  assert.deepEqual(activity.paths, ["known.ts"]);
  assert.equal(activity.cancelled, true);
  assert.equal(activity.uncertain, true);
  assert.equal(activity.observations.length, 1);
});

test("repeated structured rows dedupe and a clean aborted turn keeps proven events", async (t) => {
  const { read } = await fixture(t);
  const changed = item({
    type: "FileChange",
    status: "completed",
    changes: { "known.ts": { type: "update" } },
  });
  const activity = await read([
    start(),
    changed,
    changed,
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn" } },
  ]);
  assert.equal(activity.observations.length, 1);
  assert.deepEqual(activity.paths, ["known.ts"]);
  assert.equal(activity.cancelled, true);
  assert.equal(activity.uncertain, false);
});

test("automatic heartbeat and host instruction assembly cannot become new requirement signals", async (t) => {
  const { read } = await fixture(t);
  for (const text of [
    "<heartbeat>请检查需求，确认实现结果</heartbeat>",
    "<environment_context>need workspace config confirmed</environment_context>",
    "# AGENTS.md instructions for C:\\repo\n<INSTRUCTIONS>请修改，实现需求后确认</INSTRUCTIONS>\n<environment_context>need local paths</environment_context>",
  ]) {
    const activity = await read([
      start(),
      response({ type: "message", role: "user", content: [{ type: "input_text", text }] }),
    ]);
    assert.deepEqual(activity.signals, []);
  }
  const genuine = await read([
    start(),
    response({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>need host setup</environment_context>\n请修复导出功能",
        },
      ],
    }),
  ]);
  assert.deepEqual(genuine.signals, []);
});

test("failed, missing and malicious evidence stays uncertain while known events survive", async (t) => {
  const { read } = await fixture(t);
  const activity = await read([
    start(),
    item({
      type: "CommandExecution",
      status: "failed",
      exit_code: 1,
      parsed_cmd: [{ type: "read", path: "failed.txt" }],
    }),
    item({ type: "CommandExecution", status: "completed", parsed_cmd: [{ type: "read" }] }),
    item({ type: "FileChange", status: "failed", changes: { "failed-write.txt": {} } }),
    item({
      type: "FileChange",
      status: "completed",
      changes: {
        "bad\u0000file": { type: "update" },
        ".tent/private.md": { type: "update" },
        "safe.txt": { type: "update" },
      },
    }),
    response({
      type: "message",
      role: "assistant",
      content: [{ type: "input_file", file_path: "invented.txt" }],
    }),
    response({ type: "function_call", call_id: "pending", name: "exec_command", arguments: "{}" }),
  ]);
  assert.deepEqual(activity.paths, ["safe.txt"]);
  assert.deepEqual(
    activity.observations.map((file) => file.address),
    ["safe.txt"],
  );
  assert.equal(activity.uncertain, true);
});

test("missing turn/transcript and a turn outside the bounded tail never claim evidence", async (t) => {
  const { workspace, log, read } = await fixture(t);
  assert.equal((await readCodexTurnActivity(undefined, workspace, "turn")).uncertain, true);
  assert.equal((await readCodexTurnActivity(log, workspace, "turn")).uncertain, true);
  await read([start()]);
  assert.equal((await readCodexTurnActivity(log, workspace, undefined)).uncertain, true);
  assert.equal((await read([start("other")])).uncertain, true);
  await read([
    start(),
    item({ type: "FileChange", status: "completed", changes: { "early.ts": { type: "update" } } }),
  ]);
  await fs.appendFile(log, " ".repeat(1024 * 1024 + 1));
  assert.deepEqual(await readCodexTurnActivity(log, workspace, "turn"), {
    paths: [],
    observations: [],
    signals: [],
    uncertain: true,
  });
  await read([
    start(),
    item({ type: "FileChange", status: "completed", changes: { "known.ts": { type: "update" } } }),
    '{"type":"event_msg"',
  ]);
  const truncated = await readCodexTurnActivity(log, workspace, "turn");
  assert.equal(truncated.uncertain, true);
  assert.deepEqual(truncated.paths, ["known.ts"]);
});

test("intent signals require explicit decisions or requirement changes, not ordinary work requests", async (t) => {
  const { read } = await fixture(t);
  for (const message of [
    "请帮我修一下这个bug",
    "需要修改，希望修复",
    "please add and fix this",
    "I need you to implement this",
  ]) {
    assert.deepEqual(
      (await read([start(), { type: "event_msg", payload: { type: "user_message", message } }]))
        .signals,
      [],
    );
  }
  for (const message of [
    "决定改用HALF_EVEN",
    "确认采用方案",
    "We decided on HALF_EVEN",
    "Confirmed and agreed",
  ]) {
    assert.deepEqual(
      (await read([start(), { type: "event_msg", payload: { type: "user_message", message } }]))
        .signals,
      ["possible-decision"],
    );
  }
  for (const message of ["改成批量导出", "新增需求：批量导出", "New requirement: export"]) {
    assert.deepEqual(
      (await read([start(), { type: "event_msg", payload: { type: "user_message", message } }]))
        .signals,
      ["possible-requirement"],
    );
  }
});

test("only completed Node/Card writes prove semantic mutation; reads and Role writes do not", async (t) => {
  const { read } = await fixture(t);
  for (const filename of [".tent/Goal/Goal.md", ".tent/cards/card-test.md"]) {
    const activity = await read([
      start(),
      item({
        type: "FileChange",
        status: "completed",
        changes: { [filename]: { type: "update" } },
      }),
    ]);
    assert.equal(activity.nodeOrCardChanged, true);
    assert.deepEqual(activity.observations, []);
    assert.deepEqual(activity.paths, []);
  }
  for (const filename of [
    ".tent/roles/role-test.md",
    ".tent/temp/probe.md",
    ".tent/annotations.json",
  ]) {
    assert.equal(
      (
        await read([
          start(),
          item({
            type: "FileChange",
            status: "completed",
            changes: { [filename]: { type: "update" } },
          }),
        ])
      ).nodeOrCardChanged,
      undefined,
    );
  }
  assert.equal(
    (
      await read([
        start(),
        item({
          type: "CommandExecution",
          status: "completed",
          parsed_cmd: [{ type: "read", path: ".tent/Goal/Goal.md" }],
        }),
      ])
    ).nodeOrCardChanged,
    undefined,
  );
  for (const change of [
    { type: "FileChange", status: "failed", changes: { ".tent/Goal/Goal.md": { type: "update" } } },
    {
      type: "FileChange",
      status: "completed",
      changes: { ".tent/Goal/Goal.md": { type: "unknown" } },
    },
  ]) {
    assert.equal((await read([start(), item(change)])).nodeOrCardChanged, undefined);
  }
  const patch =
    "*** Begin Patch\n*** Update File: .tent/Goal/Goal.md\n@@\n-old\n+new\n*** End Patch";
  const patched = await read([
    start(),
    response({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: patch }),
    response({
      type: "custom_tool_call_output",
      call_id: "patch",
      output: "Success. Updated the following files:\nM .tent/Goal/Goal.md\n",
    }),
  ]);
  assert.equal(patched.nodeOrCardChanged, true);
});
