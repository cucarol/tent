import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { runHookCommand } from "../src/cli/hook.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { questionsForIndexedTurn } from "../src/core/stop-advice.js";
import type { SessionObservationEvent } from "../src/core/session-observations.js";
import { withFileMutationLock } from "../src/fs/mutation-lock.js";
import { GitDocumentHistory } from "../src/core/git-history.js";
import { claimStopReview } from "../src/fs/stop-review-claim.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "lean-hooks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "hooks" });
  const systemRoot = path.join(root, ".tent");
  const adapter = new NodeFs(systemRoot);
  await adapter.mkdir("Goal");
  await adapter.writeFile(
    "Goal/Goal.md",
    "---\nid: node-goal\ntype: goal\n---\nConfirmed intent\n",
  );
  await adapter.mkdir("Module");
  await adapter.writeFile(
    "Module/Module.md",
    "---\nid: node-module\ntype: prompt\nsources:\n  - resource: ../../src/\n    track: structure\n---\nModule rule\n",
  );
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "code.ts"), "code");
  const hook = async (id: string, files: string[], message = "", active = false) => {
    const log = path.join(root, "turn.jsonl");
    await fs.writeFile(
      log,
      [
        { type: "event_msg", payload: { type: "task_started", turn_id: id } },
        { type: "event_msg", payload: { type: "user_message", message } },
        ...files.map((file) => ({
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: id,
            item: {
              type: "FileChange",
              status: "completed",
              changes: { [file]: { type: "update" } },
            },
          },
        })),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    return runHookCommand("stop", ["--host", "codex"], {
      packageRoot: root,
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        cwd: root,
        session_id: "session",
        turn_id: id,
        transcript_path: log,
        stop_hook_active: active,
      }),
    });
  };
  return { root, systemRoot, adapter, hook };
}

test("Stop keeps module and intent review without inspecting unlinked writes", async (t) => {
  const { root, systemRoot, adapter, hook } = await fixture(t);
  t.mock.method(NodeFs.prototype, "nonignoredFiles", () => {
    throw new Error("Stop must never inspect unlinked writes");
  });
  t.mock.method(NodeFs.prototype, "observeMaterial", () => {
    throw new Error("Stop must never observe file availability or versions");
  });
  await fs.writeFile(path.join(root, ".gitignore"), "*.svg\nsrc/ignored.ts\n");
  await fs.writeFile(path.join(root, "new.svg"), "written");
  const files = ["src/code.ts", "src/ignored.ts", "src/deleted.ts", "new.svg", "deleted.svg"];
  const before = await adapter.readFile("Module/Module.md");
  const notice = JSON.parse((await hook("one", files, "确认新增需求")).stdout);
  assert.equal(notice.decision, "block");
  assert.match(notice.reason, /node-module/);
  assert.match(notice.reason, /src\/ignored\.ts/);
  assert.match(notice.reason, /src\/deleted\.ts/);
  assert.match(notice.reason, /reads like a new decision/);
  assert.doesNotMatch(
    notice.reason,
    /no Node material covers it|new\.svg|deleted\.svg|behind|node confirm/,
  );
  assert.equal((notice.reason.match(/^[1-3]\. /gm) ?? []).length, 1);
  assert.equal(await adapter.readFile("Module/Module.md"), before);
  const observedAt = new Date().toISOString();
  const event: SessionObservationEvent = {
    schema: 1,
    type: "turn",
    sessionId: "session",
    turnId: "two",
    observedAt,
    files: files.map((address) => ({
      kind: "written",
      address,
      version: { state: "uncertain", observedAt, phase: "stop" },
    })),
    signals: [],
    uncertain: false,
  };
  assert.deepEqual(
    questionsForIndexedTurn(await loadStopMaterialIndex(systemRoot, root), event),
    [],
  );
  assert.equal(
    (await hook("uncovered", ["new.svg", "deleted.svg"], "确认新增需求")).stdout,
    "{}\n",
  );
  assert.equal((await hook("one", files, "确认新增需求")).stdout, "{}\n");
});

test("a held workspace lock cannot delay Stop or capture a pending native edit", async (t) => {
  const { adapter, systemRoot, hook } = await fixture(t);
  const raw = await adapter.readFile("Module/Module.md");
  await adapter.writeFile(
    "Module/Module.md",
    raw + "Native edit waiting for a normal Tent command\n",
  );
  await adapter.mkdir(".git");
  await adapter.writeFile(".git/HEAD", "ref: refs/heads/main\n");
  t.mock.method(GitDocumentHistory.prototype, "changedRetainedDocuments", () => {
    throw new Error("Stop must never capture native edits");
  });
  t.mock.method(NodeFs.prototype, "withLock", () => {
    throw new Error("Stop must never acquire workspace lock");
  });
  t.mock.method(NodeFs.prototype, "observeMaterial", () => {
    throw new Error("Stop must never compare materials");
  });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withFileMutationLock(
    path.join(systemRoot, "mutation.lock"),
    async () => {
      entered();
      await held;
    },
    { busyMessage: "test lock busy", acquireFailedMessage: "test lock failure" },
  );
  await ready;
  const lockBefore = await fs.readFile(path.join(systemRoot, "mutation.lock"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      hook("locked", ["src/code.ts"]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Stop waited for held lock")), 2000);
      }),
    ]);
    assert.equal(JSON.parse(result.stdout).decision, "block");
    assert.deepEqual(await fs.readFile(path.join(systemRoot, "mutation.lock")), lockBefore);
    assert.equal(
      await adapter.readFile("Module/Module.md"),
      raw + "Native edit waiting for a normal Tent command\n",
    );
    assert.equal(await adapter.exists("temp/observations"), false);
    assert.equal(await adapter.readFile(".git/HEAD"), "ref: refs/heads/main\n");
    assert.deepEqual((await fs.readdir(path.join(systemRoot, ".git"))).sort(), [
      "HEAD",
      "tent-material-cache",
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    await holder;
  }
});

test("Stop claims are per native host/session/turn and never store transcript, file hashes or prose", async (t) => {
  const { systemRoot, hook, adapter } = await fixture(t);
  const first = await hook("same", ["src/code.ts"], "private decision prose");
  assert.equal(JSON.parse(first.stdout).decision, "block");
  const directory = path.join(systemRoot, "temp", "stop-reviews");
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.claim$/);
  assert.equal(await fs.readFile(path.join(directory, files[0]), "utf8"), "");
  const raw = await adapter.readFile("Module/Module.md");
  await adapter.writeFile("Module/Module.md", raw.replace("node-module", "invalid-id"));
  assert.equal((await hook("same", ["src/code.ts"])).stdout, "{}\n");
  await adapter.writeFile("Module/Module.md", raw);
  assert.equal((await hook("active", ["src/code.ts"], "", true)).stdout, "{}\n");
  assert.deepEqual(await fs.readdir(directory), files);
});

test("concurrent per-event claims permit exactly one response without a global lock", async (t) => {
  const { systemRoot } = await fixture(t);
  const claims = await Promise.all(
    Array.from({ length: 12 }, () =>
      claimStopReview(systemRoot, "codex", "../../native/session", "same"),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(
    await claimStopReview(systemRoot, "claude-code", "../../native/session", "same"),
    true,
  );
  assert.equal(await claimStopReview(systemRoot, "codex", "other-session", "same"), true);
  assert.equal(await claimStopReview(systemRoot, "codex", "../../native/session", "next"), true);
});
