import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { stopAdvice } from "../src/core/stop-advice.js";
import { materialCheck } from "../src/core/material-check.js";
import { observeMaterialResource } from "../src/fs/source-observation.js";
import { contentEtag } from "../src/core/etag.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { runHookCommand } from "../src/cli/hook.js";
import { readCodexTurnActivity } from "../src/cli/codex-turn-activity.js";
import { findTentSystemRoot } from "../src/core/status.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "lean-hooks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "hooks" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "fact.txt"), "v1");
  return { root, adapter };
}
const transcript = (turn: string, item: unknown) =>
  [
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "event_msg", payload: { type: "item_completed", turn_id: turn, item } },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";

test("Start gives only dynamic entry; Stop is bounded advisory without business files or a Service", async (t) => {
  const { root, adapter } = await fixture(t);
  await adapter.writeFile("roles.json", "old broken registry must not be read");
  await adapter.writeFile(
    "Fact/Fact.md",
    serializeFrontmatter(
      { id: "node-fact", type: "prompt", resource: "../../src/fact.txt" },
      "fact",
    ),
  );
  const before = await adapter.listDir("");
  const start = await runHookCommand("start", ["--host", "codex"], {
    packageRoot: path.resolve("."),
    stdin: JSON.stringify({ hook_event_name: "SessionStart", cwd: root, session_id: "actual" }),
  });
  assert.equal(start.exitCode, 0);
  const entry = JSON.parse(start.stdout);
  assert.match(entry.hookSpecificOutput.additionalContext, /Workspace:.*lean-hooks-/);
  assert.match(entry.hookSpecificOutput.additionalContext, /Build: Tent .*commit .*; source/);
  assert.doesNotMatch(start.stdout, /tent-input|tent-return|SessionRegistry|fact body/);
  const log = path.join(root, "turn.jsonl");
  await fs.writeFile(
    log,
    transcript("turn-1", {
      type: "FileChange",
      status: "completed",
      changes: { "src/fact.txt": {} },
    }),
  );
  const stop = await runHookCommand("stop", ["--host", "codex"], {
    packageRoot: root,
    stdin: JSON.stringify({
      hook_event_name: "Stop",
      cwd: root,
      session_id: "actual",
      transcript_path: log,
      turn_id: "turn-1",
    }),
  });
  assert.equal(stop.exitCode, 0);
  assert.ok(Buffer.byteLength(stop.stdout) <= 2048);
  const notice = JSON.parse(stop.stdout);
  assert.match(notice.systemMessage, /node-fact/);
  assert.deepEqual(Object.keys(notice), ["systemMessage"]);
  assert.deepEqual(await adapter.listDir(""), before);
  assert.equal(await adapter.exists("temp/material-checks"), false);
  // The fixture lives under the project, which may itself contain .tent.
  // Bound this assertion to the non-Tent scratch directory being tested.
  const outside = path.dirname(root);
  assert.equal(await findTentSystemRoot(outside, outside), undefined);
  const malformed = await runHookCommand("stop", ["--host", "codex"], {
    packageRoot: root,
    stdin: "bad JSON",
  });
  assert.equal(malformed.exitCode, 0);
  assert.deepEqual(Object.keys(JSON.parse(malformed.stdout)), ["systemMessage"]);
});

test("Stop reads headers and at most five selected checks; exact checked versions suppress only covered changes", async (t) => {
  const { root, adapter } = await fixture(t);
  const resource = "../../src/fact.txt",
    observe = (resource: string, documentPath: string) =>
      observeMaterialResource(root, documentPath, resource);
  for (let i = 0; i < 7; i++) {
    const name = `Fact${i}`,
      file = `${name}/${name}.md`;
    const raw = serializeFrontmatter(
      { id: `node-fact${i}`, type: "prompt", resource },
      "actual fact",
    );
    await adapter.writeFile(file, raw);
    await materialCheck(
      adapter,
      {
        action: "confirm",
        nodeId: `node-fact${i}`,
        expectedPath: name,
        expectedEtag: contentEtag(raw),
        materials: [{ resource, ...(await observe(resource, file)) }],
      },
      observe,
    );
  }
  const reads: string[] = [],
    original = adapter.readFile.bind(adapter);
  adapter.readFile = async (p) => {
    if (p.endsWith(".md")) reads.push(p);
    return original(p);
  };
  let notice = await stopAdvice(
    adapter,
    root,
    { paths: ["src/fact.txt"], uncertain: false },
    observe,
  );
  assert.ok(notice?.includes("更多候选"));
  assert.equal(reads.length, 10); // Each of at most five checked Nodes is reread for race detection.
  assert.equal(new Set(reads).size, 5);
  await fs.writeFile(path.join(root, "src/fact.txt"), "v2");
  reads.length = 0;
  notice = await stopAdvice(adapter, root, { paths: ["src/fact.txt"], uncertain: false }, observe);
  assert.equal((notice!.match(/node-fact/g) ?? []).length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify({ systemMessage: notice }) + "\n") <= 2048);
  assert.equal(new Set(reads).size, 5);
  const unreadable = new Proxy(adapter, {
    get() {
      return () => {
        throw new Error("must not scan");
      };
    },
  });
  assert.equal(
    await stopAdvice(unreadable, root, { paths: [], uncertain: false }, observe),
    undefined,
  );
  assert.equal(
    await stopAdvice(unreadable, root, { paths: [], uncertain: true, cancelled: true }, observe),
    undefined,
  );
  assert.match(
    (await stopAdvice(unreadable, root, { paths: [], uncertain: true }, observe))!,
    /未证实/,
  );
});

test("uncertain Stop retains known changed paths and matching Nodes", async (t) => {
  const { root, adapter } = await fixture(t);
  await adapter.writeFile(
    "Fact/Fact.md",
    serializeFrontmatter(
      { id: "node-fact", type: "prompt", resource: "../../src/fact.txt" },
      "fact",
    ),
  );
  const log = path.join(root, "turn.jsonl");
  await fs.writeFile(
    log,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-mixed" } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-mixed",
          item: { type: "FileChange", status: "completed", changes: { "src/fact.txt": {} } },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-mixed",
          item: { type: "CommandExecution", parsed_cmd: [{ type: "unknown" }] },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const activity = await readCodexTurnActivity(log, root, "turn-mixed");
  assert.deepEqual(activity, { paths: ["src/fact.txt"], uncertain: true, hasFileChanges: true });
  const notice = await stopAdvice(adapter, root, activity, (resource, documentPath) =>
    observeMaterialResource(root, documentPath, resource),
  );
  assert.match(notice!, /node-fact/);
  assert.match(notice!, /路径归属不完整/);
});

test("bounded transcript observation does not infer changes or a turn outside its window", async (t) => {
  const { root } = await fixture(t),
    log = path.join(root, "turn.jsonl");
  await fs.writeFile(
    log,
    transcript("turn-read", { type: "CommandExecution", parsed_cmd: [{ type: "read" }] }),
  );
  assert.deepEqual(await readCodexTurnActivity(log, root, "turn-read"), {
    paths: [],
    uncertain: false,
  });
  await fs.appendFile(
    log,
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-read" } }) +
      "\n",
  );
  assert.deepEqual(await readCodexTurnActivity(log, root, "turn-read"), {
    paths: [],
    uncertain: false,
    cancelled: true,
  });
  await fs.appendFile(log, " ".repeat(1024 * 1024 + 1));
  assert.deepEqual(await readCodexTurnActivity(log, root, "turn-read"), {
    paths: [],
    uncertain: true,
  });
  await fs.writeFile(
    log,
    transcript("turn-shell", { type: "CommandExecution", parsed_cmd: [{ type: "unknown" }] }),
  );
  assert.deepEqual(await readCodexTurnActivity(log, root, "turn-shell"), {
    paths: [],
    uncertain: true,
  });
  await fs.writeFile(
    log,
    transcript("turn-retired-tool", { type: "McpToolCall", tool: "mcp__tent__node_read" }),
  );
  assert.deepEqual(await readCodexTurnActivity(log, root, "turn-retired-tool"), {
    paths: [],
    uncertain: true,
  });
  assert.deepEqual(await readCodexTurnActivity(log, root, undefined), {
    paths: [],
    uncertain: true,
  });
});

test("a current partial material check cannot suppress another changed declared source", async (t) => {
  const { root, adapter } = await fixture(t);
  await fs.writeFile(path.join(root, "src", "second.txt"), "second");
  const resource = "../../src/fact.txt";
  const raw = serializeFrontmatter(
    {
      id: "node-partial",
      type: "prompt",
      resource,
      sources: [{ resource: "../../src/second.txt" }],
    },
    "both matter",
  );
  await adapter.writeFile("Fact/Fact.md", raw);
  const observe = (resource: string, documentPath: string) =>
    observeMaterialResource(root, documentPath, resource);
  await materialCheck(
    adapter,
    {
      action: "confirm",
      nodeId: "node-partial",
      expectedPath: "Fact",
      expectedEtag: contentEtag(raw),
      materials: [{ resource, ...(await observe(resource, "Fact/Fact.md")) }],
    },
    observe,
  );
  assert.equal(
    await stopAdvice(adapter, root, { paths: ["src/fact.txt"], uncertain: false }, observe),
    undefined,
  );
  assert.match(
    (await stopAdvice(adapter, root, { paths: ["src/second.txt"], uncertain: false }, observe))!,
    /node-partial/,
  );
});
