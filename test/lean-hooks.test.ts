import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createNode } from "../src/core/ops.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { createCardDocument } from "../src/core/card-document.js";
import { linkNodeOutput, inspectWorkspaceSync } from "../src/core/node-sync.js";
import {
  stopAdvice,
  formatStopQuestions,
  questionsForObservedTurn,
  formatObservedTurnAdvice,
} from "../src/core/stop-advice.js";
import type { WorkspaceSync } from "../src/core/context-brief.js";
import type { SessionObservationEvent } from "../src/core/session-observations.js";
import { runHookCommand } from "../src/cli/hook.js";
import { readCodexTurnActivity } from "../src/cli/codex-turn-activity.js";
import {
  readSessionObservations,
  appendSessionObservations,
  saveSessionHistoryBaseline,
} from "../src/core/session-observations.js";
import { observeSessionFile } from "../src/fs/session-observations.js";
import { findTentSystemRoot } from "../src/core/status.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "lean-hooks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "hooks" });
  await git(path.join(root, ".tent"), "init");
  const adapter = new NodeFs(path.join(root, ".tent"));
  const env = { fs: adapter, clock: { now: () => new Date().toISOString() }, tentName: "hooks" };
  await fs.writeFile(path.join(root, "basis.md"), "original basis");
  const id = await createNode(env, {
    parentPath: "",
    name: "Requirement",
    type: "goal",
    resource: "../../basis.md",
    body: "Confirmed intent",
  });
  await fs.writeFile(path.join(root, "existing.html"), "<h1>existing</h1>");
  const read = await readNodeForEdit(adapter, id);
  await linkNodeOutput(adapter, id, {
    baseEtag: read.etag,
    resource: "../../existing.html",
    provenance: "confirmed",
  });
  return { root, adapter, id };
}
function transcript(turnId: string, items: unknown[], message?: string) {
  return (
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      ...(message ? [{ type: "event_msg", payload: { type: "user_message", message } }] : []),
      ...items.map((item) => ({
        type: "event_msg",
        payload: { type: "item_completed", turn_id: turnId, item },
      })),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}

test("native-shaped Start hints at the brief; Stop records a turn and gives three bounded questions without semantic writes", async (t) => {
  const { root, adapter, id } = await fixture(t);
  await adapter.writeFile("roles.json", "retired registry is not read");
  const rawBefore = await adapter.readFile("Requirement/Requirement.md");
  const headBefore = await git(path.join(root, ".tent"), "rev-parse", "HEAD");
  const start = await runHookCommand("start", ["--host", "codex"], {
    packageRoot: path.resolve("."),
    stdin: JSON.stringify({
      hook_event_name: "SessionStart",
      cwd: root,
      session_id: "native-session",
    }),
  });
  const entry = JSON.parse(start.stdout);
  assert.match(entry.hookSpecificOutput.additionalContext, /workspace brief/);
  assert.doesNotMatch(start.stdout, /Confirmed intent|同步 \d|SessionRegistry|tent-return/);
  await fs.writeFile(path.join(root, "basis.md"), "changed basis");
  await fs.writeFile(path.join(root, "new.svg"), "<svg>new output</svg>");
  const log = path.join(root, "turn.jsonl");
  await fs.writeFile(
    log,
    transcript(
      "turn-1",
      [
        {
          type: "CommandExecution",
          status: "completed",
          exit_code: 0,
          parsed_cmd: [{ type: "read", path: "basis.md" }],
        },
        { type: "FileChange", status: "completed", changes: { "new.svg": { type: "add" } } },
      ],
      "确认新增需求：导出功能。",
    ),
  );
  const input = JSON.stringify({
    hook_event_name: "Stop",
    cwd: root,
    session_id: "native-session",
    transcript_path: log,
    turn_id: "turn-1",
  });
  const stop = await runHookCommand("stop", ["--host", "codex"], {
    packageRoot: root,
    stdin: input,
  });
  assert.equal(stop.exitCode, 0);
  assert.ok(Buffer.byteLength(stop.stdout) <= 2048);
  const notice = JSON.parse(stop.stdout);
  assert.deepEqual(Object.keys(notice), ["systemMessage"]);
  assert.match(notice.systemMessage, /new\.svg/);
  assert.match(notice.systemMessage, new RegExp(id));
  assert.match(notice.systemMessage, /Options/);
  assert.match(notice.systemMessage, /Changed: update the Node and confirm/);
  assert.doesNotMatch(notice.systemMessage, /[\u4e00-\u9fff]/);
  assert.equal((notice.systemMessage.match(/^[1-3]\. /gm) ?? []).length, 3);
  const records = await readSessionObservations(adapter, { sessionId: "native-session" });
  assert.equal(records.events.length, 1);
  assert.ok(
    records.events[0].files.some((file) => file.kind === "written" && file.address === "new.svg"),
  );
  assert.ok(records.events[0].files.every((file) => file.version.state === "observed"));
  assert.doesNotMatch(JSON.stringify(records), /请新增|changed basis|new output|transcript_path/);
  assert.equal(await adapter.readFile("Requirement/Requirement.md"), rawBefore);
  assert.equal(await git(path.join(root, ".tent"), "rev-parse", "HEAD"), headBefore);
  const repeat = await runHookCommand("stop", ["--host", "codex"], {
    packageRoot: root,
    stdin: input,
  });
  assert.equal(repeat.stdout, "{}\n");
  assert.equal((await readSessionObservations(adapter)).events.length, 1);
  const outside = path.dirname(root);
  assert.equal(await findTentSystemRoot(outside, outside), undefined);
  const malformed = await runHookCommand("stop", ["--host", "codex"], {
    packageRoot: root,
    stdin: "bad JSON",
  });
  assert.equal(malformed.exitCode, 0);
  assert.ok(Buffer.byteLength(malformed.stdout) <= 2048);
});

test("same observed material version is not asked about again and cancelled turns keep facts without questions", async (t) => {
  const { root, adapter } = await fixture(t);
  await fs.writeFile(path.join(root, "basis.md"), "changed");
  const activity = {
    observations: [{ kind: "read" as const, address: "basis.md" }],
    signals: [],
    uncertain: false,
  };
  const first = await appendSessionObservations(
    adapter,
    "same-session",
    "one",
    activity,
    (address) => observeSessionFile(root, address),
  );
  const sync = await inspectWorkspaceSync(adapter);
  assert.equal(
    questionsForObservedTurn(sync, root, first.event, []).filter((q) => q.kind === "behind-node")
      .length,
    1,
  );
  const second = await appendSessionObservations(
    adapter,
    "same-session",
    "two",
    activity,
    (address) => observeSessionFile(root, address),
  );
  assert.equal(questionsForObservedTurn(sync, root, second.event, [first.event]).length, 0);
  assert.equal(await stopAdvice(adapter, root, second.event), undefined);
  const cancelled = await appendSessionObservations(
    adapter,
    "same-session",
    "three",
    { ...activity, cancelled: true },
    (address) => observeSessionFile(root, address),
  );
  assert.equal(cancelled.event.files.length, 1);
  assert.equal(await stopAdvice(adapter, root, cancelled.event), undefined);
});

test("the complete Hook envelope remains below 2 KiB with huge Unicode candidates", () => {
  const message = formatStopQuestions(
    [
      {
        kind: "unlinked-output",
        question: "新产出？".repeat(5000),
        answers: ["一个很长的候选".repeat(5000)],
      },
      {
        kind: "behind-node",
        question: "node-small 是否仍成立？",
        answers: ["确认", "修改", "领先"],
      },
      {
        kind: "possible-intent",
        question: "这一轮是否有新决定？",
        answers: ["更新已有", "新建", "不保存"],
      },
    ],
    true,
  );
  assert.ok(message);
  assert.ok(Buffer.byteLength(JSON.stringify({ systemMessage: message }) + "\n") <= 2048);
  assert.equal((message.match(/^[1-3]\. /gm) ?? []).length, 2);
  assert.match(message, /node-small/);
});

test("Stop exposes uncertain Node inspection and excludes its goal from intent candidates", () => {
  const uncertainGoal = {
    nodeId: "node-uncertain",
    path: "Uncertain",
    type: "goal",
    state: "unanchored" as const,
    materials: [],
    outputs: [],
    reasons: [],
    uncertain: true,
  };
  const sync: WorkspaceSync = {
    nodes: [uncertainGoal],
    counts: { synced: 0, ahead: 0, behind: 0, unanchored: 1 },
    unlinkedOutputs: [],
    requirementsWithoutOutputs: [],
  };
  const event: SessionObservationEvent = {
    schema: 1,
    type: "turn",
    sessionId: "session",
    turnId: "turn",
    observedAt: "2026-10-04T00:00:00.000Z",
    files: [],
    signals: [],
    uncertain: false,
  };
  const previous = { events: [], uncertain: false };
  assert.equal(formatObservedTurnAdvice({ ...sync, nodes: [] }, ".", event, previous), undefined);
  const warning = formatObservedTurnAdvice(sync, ".", event, previous);
  assert.ok(warning);
  assert.match(warning, /observations are incomplete; use workspace brief/);
  assert.equal((warning.match(/^[1-3]\. /gm) ?? []).length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify({ systemMessage: warning }) + "\n") <= 2048);
  const decision = formatObservedTurnAdvice(
    sync,
    ".",
    { ...event, signals: ["possible-decision"] },
    previous,
  );
  assert.ok(decision);
  assert.match(decision, /Which judgment should be saved/);
  assert.match(decision, /observations are incomplete/);
  assert.doesNotMatch(decision, /Update existing node-uncertain/);
  assert.equal(
    formatObservedTurnAdvice(sync, ".", { ...event, cancelled: true }, previous),
    undefined,
  );
});

test("a changed linked output asks for review rather than disappearing from Stop advice", async (t) => {
  const { root, adapter, id } = await fixture(t);
  await fs.writeFile(path.join(root, "existing.html"), "<h1>changed output</h1>");
  const saved = await appendSessionObservations(
    adapter,
    "output-session",
    "one",
    {
      observations: [{ kind: "written", address: "existing.html" }],
      signals: [],
      uncertain: false,
    },
    (address) => observeSessionFile(root, address),
  );
  const sync = await inspectWorkspaceSync(adapter);
  assert.equal(sync.nodes.find((node) => node.nodeId === id)?.state, "behind");
  const questions = questionsForObservedTurn(sync, root, saved.event, []);
  assert.deepEqual(
    questions.map((question) => question.kind),
    ["behind-node"],
  );
  assert.match(questions[0].question, new RegExp(id));
  assert.equal(
    questionsForObservedTurn(sync, root, { ...saved.event, turnId: "two" }, [saved.event]).length,
    0,
  );
});

test("uncertain transcript activity retains confirmed changes and excludes another turn", async (t) => {
  const { root } = await fixture(t);
  const log = path.join(root, "turn.jsonl");
  await fs.writeFile(
    log,
    transcript("one", [
      { type: "FileChange", status: "completed", changes: { "written.txt": { type: "update" } } },
      { type: "CommandExecution", parsed_cmd: [{ type: "unknown" }] },
    ]) +
      transcript("two", [
        { type: "FileChange", status: "completed", changes: { "later.txt": { type: "add" } } },
      ]),
  );
  const activity = await readCodexTurnActivity(log, root, "one");
  assert.deepEqual(activity.paths, ["written.txt"]);
  assert.equal(activity.uncertain, true);
  assert.ok(
    activity.observations.some((file) => file.kind === "written" && file.address === "written.txt"),
  );
  assert.equal(
    activity.observations.some((file) => file.address === "later.txt"),
    false,
  );
});

test("explicit decisions ask once unless a Node or Card mutation is evidenced, including the initial turn", async (t) => {
  const { root, adapter, id } = await fixture(t);
  const session = "decision-session";
  await saveSessionHistoryBaseline(adapter, session);
  const activity = { observations: [], signals: ["possible-decision" as const], uncertain: false };
  const observe = (address: string) => observeSessionFile(root, address);
  const sync = await inspectWorkspaceSync(adapter);
  const read = await readNodeForEdit(adapter, id);
  await writeNodeDocument(adapter, id, { baseEtag: read.etag, body: "Use HALF_EVEN" });
  const first = await appendSessionObservations(adapter, session, "initial", activity, observe);
  assert.equal(first.event.nodeOrCardChanged, true);
  assert.equal(questionsForObservedTurn(sync, root, first.event, []).length, 0);
  const second = await appendSessionObservations(adapter, session, "no-save", activity, observe);
  assert.equal(second.event.nodeOrCardChanged, undefined);
  assert.deepEqual(
    questionsForObservedTurn(sync, root, second.event, [first.event]).map((q) => q.kind),
    ["possible-intent"],
  );
  await createCardDocument(adapter, { prompt: "Confirmed rounding decision" });
  const third = await appendSessionObservations(adapter, session, "card-save", activity, observe);
  assert.equal(third.event.nodeOrCardChanged, true);
  assert.equal(questionsForObservedTurn(sync, root, third.event, [second.event]).length, 0);
  const persisted = JSON.stringify(await readSessionObservations(adapter));
  assert.doesNotMatch(persisted, /HALF_EVEN|rounding decision|Confirmed intent/);
});

test("read capture, Role-only history, and pre-session Node mutations never suppress intent", async (t) => {
  const { root, adapter, id } = await fixture(t);
  const session = "read-session";
  // Pre-session creation is already in Git; the cursor excludes it.
  await saveSessionHistoryBaseline(adapter, session);
  const headBefore = await adapter.history.currentCommit();
  const raw = await adapter.readFile("Requirement/Requirement.md");
  await adapter.writeFile("Requirement/Requirement.md", raw + "\nExternal change before full read");
  await readNodeForEdit(adapter, id, { capture: true });
  assert.notEqual(await adapter.history.currentCommit(), headBefore);
  await adapter.history.captureUnlocked(
    [{ path: "roles/role-test.md", raw: "---\nid: role-test\ntype: role\n---\nRole only" }],
    { operation: "role.write" },
  );
  const saved = await appendSessionObservations(
    adapter,
    session,
    "one",
    {
      observations: [],
      signals: ["possible-decision"],
      uncertain: false,
    },
    (address) => observeSessionFile(root, address),
  );
  assert.equal(saved.event.nodeOrCardChanged, undefined);
  assert.equal(
    questionsForObservedTurn(await inspectWorkspaceSync(adapter), root, saved.event, []).filter(
      (q) => q.kind === "possible-intent",
    ).length,
    1,
  );
  // No SessionStart and no prior Stop must not count unrelated retained history.
  const missingBaseline = await appendSessionObservations(
    adapter,
    "new-session",
    "one",
    {
      observations: [],
      signals: ["possible-decision"],
      uncertain: false,
    },
    (address) => observeSessionFile(root, address),
  );
  assert.equal(missingBaseline.event.nodeOrCardChanged, undefined);
});

test("first Stop uses explicit transcript mutation evidence without a session baseline", async (t) => {
  const { root, adapter } = await fixture(t);
  const log = path.join(root, "turn.jsonl");
  const stop = async (turnId: string, message: string, changed: boolean) => {
    await fs.writeFile(
      log,
      transcript(
        turnId,
        changed
          ? [
              {
                type: "FileChange",
                status: "completed",
                changes: { ".tent/Requirement/Requirement.md": { type: "update" } },
              },
            ]
          : [],
        message,
      ),
    );
    return runHookCommand("stop", ["--host", "codex"], {
      packageRoot: root,
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        cwd: root,
        session_id: turnId,
        turn_id: turnId,
        transcript_path: log,
      }),
    });
  };
  assert.equal((await stop("ordinary", "请帮我修一下这个bug", true)).stdout, "{}\n");
  const explicit = await stop("explicit", "决定改用HALF_EVEN", false);
  assert.equal((JSON.parse(explicit.stdout).systemMessage.match(/^[1-3]\. /gm) ?? []).length, 1);
  assert.equal((await stop("already-saved", "决定改用HALF_EVEN", true)).stdout, "{}\n");
  assert.equal(
    (await readSessionObservations(adapter, { sessionId: "already-saved" })).events[0]
      .nodeOrCardChanged,
    true,
  );
});
