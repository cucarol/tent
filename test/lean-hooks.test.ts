import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { runHookCommand } from "../src/cli/hook.js";
import { runToolHook } from "../src/cli/tool-hook.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { toolReviewOutput } from "../src/cli/hook-adapter.js";
import { successfulWritePaths } from "../src/cli/tool-write-event.js";
import { ANSWER_REVIEW, TOOL_REVIEW_ACTION } from "../src/core/return/tool-turn-review.js";
import { hasStopReviewClaim } from "../src/fs/stop-review-claim.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "tool-hooks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "hooks" });
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"));
  for (const [name, id, coverage] of [
    ["Module", "node-module", "src/"],
    ["Other", "node-other", "lib/"],
  ]) {
    await fs.mkdir(path.join(systemRoot, name!));
    await fs.writeFile(
      path.join(systemRoot, name!, name + ".md"),
      `---\nid: ${id}\ntype: prompt\nsources:\n  - resource: ../../${coverage}\n    track: structure\n---\nRule\n`,
    );
  }
  await loadStopMaterialIndex(systemRoot, root);
  const event = (files = ["src/code.ts"], extra: Record<string, unknown> = {}) => ({
    hook_event_name: "PostToolUse",
    cwd: root,
    session_id: "session",
    turn_id: "turn",
    prompt_id: "turn",
    tool_use_id: "call",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** End Patch" },
    tool_response: `Success. Updated the following files:\n${files.map((file) => "M " + file).join("\n")}\n`,
    ...extra,
  });
  const tool = (files?: string[], extra?: Record<string, unknown>) =>
    runToolHook("codex", event(files, extra));
  return { root, systemRoot, event, tool };
}

test("successful writes name only covering Nodes, once per native host/session/turn/Node", async (t) => {
  const { root, tool, event } = await fixture(t);
  const output = await tool(["src/a.ts", "unknown.txt"]);
  const notice = JSON.parse(output);
  assert.equal(notice.decision, undefined);
  assert.equal(notice.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(
    notice.hookSpecificOutput.additionalContext,
    `Tent: these Nodes cover the file you just changed:\n- Module (node-module, .tent/Module/Module.md): src/a.ts\n${TOOL_REVIEW_ACTION}`,
  );
  assert.equal(await tool(["src/b.ts"]), "{}\n");
  assert.match(await tool(["src/b.ts", "lib/b.ts"]), /node-other/);
  assert.match(await tool(undefined, { turn_id: "another" }), /node-module/);
  assert.match(await tool(undefined, { session_id: "another" }), /node-module/);
  const claude = {
    ...event(),
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src/a.ts") },
    tool_response: { type: "create", filePath: path.join(root, "src/a.ts") },
  };
  assert.match(await runToolHook("claude-code", claude), /node-module/);
  assert.equal(await runToolHook("claude-code", claude), "{}\n");
});

test("failure, cancellation, reads, no identity, uncovered and Tent maintenance stay silent", async (t) => {
  const { tool, event } = await fixture(t);
  for (const extra of [
    { tool_response: "Error: patch failed" },
    {
      tool_response: JSON.stringify({
        output: "Success. Updated the following files:\nM src/code.ts\n",
        metadata: { exit_code: 1 },
      }),
    },
    { tool_name: "Read" },
    { turn_id: undefined },
    { session_id: undefined },
    { tool_response: "Success. Updated the following files:\n" },
  ])
    assert.equal(await tool(undefined, extra), "{}\n");
  for (const file of [
    "unknown.ts",
    ".tent/Module/Module.md",
    ".tent/cards/card-x.md",
    ".scratch/a.ts",
    "node_modules/a.ts",
  ])
    assert.equal(await tool([file]), "{}\n");
  assert.equal(
    await runToolHook("claude-code", {
      ...event(),
      tool_name: "Write",
      tool_input: { file_path: "src/code.ts" },
      tool_response: { type: "update", filePath: "other.ts" },
    }),
    "{}\n",
  );
  assert.equal(
    await runToolHook("claude-code", {
      ...event(),
      tool_name: "Write",
      tool_input: { file_path: "src/code.ts" },
      tool_response: { type: "update", filePath: "src/code.ts", cancelled: true },
    }),
    "{}\n",
  );
  assert.match(await tool(), /node-module/);
});

for (const host of ["codex", "claude-code"] as const)
  for (const prefix of ["", "src/"])
    test(`${host} operational directory aliases preserve platform case and real-write claims (${prefix || "root"})`, async (t) => {
      const { root, systemRoot, event } = await fixture(t);
      await fs.mkdir(path.join(root, ".git"));
      await fs.writeFile(
        path.join(systemRoot, "Module/Module.md"),
        "---\nid: node-module\ntype: prompt\nsources:\n  - resource: ../../\n    track: structure\n---\nRule\n",
      );
      await loadStopMaterialIndex(systemRoot, root);
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src/real.ts"), "real write\n");
      for (const directory of [".scratch", "node_modules", ".venv"]) {
        const lower = path.join(root, prefix, directory, "probe.ts");
        const upper = path.join(root, prefix, directory.toUpperCase(), "probe.ts");
        await fs.mkdir(path.dirname(lower), { recursive: true });
        await fs.writeFile(lower, "operational write\n");
        if (process.platform === "win32")
          assert.equal(
            (await fs.stat(lower, { bigint: true })).ino,
            (await fs.stat(upper, { bigint: true })).ino,
          );
        else {
          await fs.mkdir(path.dirname(upper), { recursive: true });
          await fs.writeFile(upper, "distinct case-sensitive path\n");
        }
        const turn = prefix + directory;
        const invoke = (file: string) =>
          runToolHook(host, {
            ...event([file], { turn_id: turn, prompt_id: turn }),
            ...(host === "claude-code"
              ? {
                  tool_name: "Write",
                  tool_input: { file_path: file },
                  tool_response: { type: "update", filePath: file },
                }
              : {}),
          });
        const claimed = () =>
          hasStopReviewClaim(
            systemRoot,
            host,
            "session",
            JSON.stringify([turn, "node", "node-module"]),
          );
        assert.equal(await invoke(lower), "{}\n");
        assert.equal(await claimed(), false);
        const upperResult = await invoke(upper);
        if (process.platform === "win32") {
          assert.equal(upperResult, "{}\n");
          assert.equal(await claimed(), false);
          assert.match(await invoke(path.join(root, "src/real.ts")), /node-module/);
        } else {
          assert.match(upperResult, /node-module/);
          assert.equal(await claimed(), true);
          assert.equal(await invoke(path.join(root, "src/real.ts")), "{}\n");
        }
        assert.equal(await claimed(), true);
      }
    });

test("Claude's four write tools require their successful structured path", () => {
  for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    const input =
      name === "NotebookEdit" ? { notebook_path: "book.ipynb" } : { file_path: "src/a.ts" };
    const file = Object.values(input)[0];
    const response = { filePath: file, type: "update", structuredPatch: [] };
    assert.deepEqual(
      successfulWritePaths("claude-code", {
        tool_name: name,
        tool_input: input,
        tool_response: response,
      }),
      [file],
    );
    assert.deepEqual(
      successfulWritePaths("claude-code", {
        tool_name: name,
        tool_input: input,
        tool_response: { ...response, is_error: true },
      }),
      [],
    );
  }
});

test("answered questions get the dedicated reminder; missing or cancelled answers do not", async (t) => {
  const { event } = await fixture(t);
  for (const host of ["codex", "claude-code"] as const) {
    const question = {
      ...event(),
      tool_name: host === "codex" ? "request_user_input" : "AskUserQuestion",
      tool_response: { answers: { choice: host === "codex" ? { answers: ["Use it"] } : "Use it" } },
    };
    assert.equal(
      JSON.parse(await runToolHook(host, question)).hookSpecificOutput.additionalContext,
      ANSWER_REVIEW,
    );
    assert.equal(await runToolHook(host, question), "{}\n");
    assert.equal(
      await runToolHook(host, {
        ...question,
        tool_use_id: "other",
        tool_response: { answers: {} },
      }),
      "{}\n",
    );
    assert.equal(
      await runToolHook(host, {
        ...question,
        tool_use_id: "other",
        tool_response: { isError: true, answers: { choice: "Use it" } },
      }),
      "{}\n",
    );
  }
});

test("tools only consume existing coverage and never acquire locks or inspect transcripts", async (t) => {
  const { systemRoot, tool } = await fixture(t);
  const module = path.join(systemRoot, "Module/Module.md");
  await fs.writeFile(module, "invalid new bytes");
  await fs.writeFile(path.join(systemRoot, "mutation.lock"), "held by another writer");
  assert.match(await tool(undefined, { transcript_path: "missing" }), /node-module/);
  assert.equal(await fs.readFile(module, "utf8"), "invalid new bytes");
  const cache = path.join(systemRoot, ".git/tent-material-cache/stop-material-index.json");
  await fs.writeFile(cache, "broken cache");
  assert.equal(await tool(undefined, { turn_id: "next" }), "{}\n");
  assert.equal(await fs.readFile(cache, "utf8"), "broken cache");
});

test("concurrent events deliver a Node at most once, without a global lock", async (t) => {
  const { tool } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => tool()));
  assert.equal(results.filter((result) => result !== "{}\n").length, 1);
});

test("Stop is completely quiet, even malformed input, and does no filesystem work", async (t) => {
  const { root } = await fixture(t);
  const result = await runHookCommand("stop", ["--host", "codex"], {
    packageRoot: root,
    stdin: "invalid",
  });
  assert.deepEqual(result, { exitCode: 0, stdout: "{}\n", stderr: "" });
});

test("bounded review preserves the exact action and identifies only rendered claims", () => {
  const modules = Array.from({ length: 8 }, (_, i) => ({
    nodeId: `node-${i}`,
    path: `.tent/${"a".repeat(80)}/${i}.md`,
    names: ["x".repeat(50)],
    files: Array.from({ length: 8 }, (_, n) => `src/${"q".repeat(50)}${n}.ts`),
  }));
  const output = toolReviewOutput(modules)!;
  assert.ok(Buffer.byteLength(output.stdout) <= 2048);
  assert.match(output.stdout, /more modules/);
  assert.ok(
    JSON.parse(output.stdout).hookSpecificOutput.additionalContext.endsWith(TOOL_REVIEW_ACTION),
  );
  for (const id of output.nodeIds) assert.ok(output.stdout.includes(id));
});

test("Codex successful patch output is the path authority, including deletion and moved destinations", () => {
  const input = { command: "*** Begin Patch\n*** Update File: do-not-infer.ts\n*** End Patch" };
  const output = "Success. Updated the following files:\nA new.ts\nM moved.ts\nD removed.ts\n";
  assert.deepEqual(
    successfulWritePaths("codex", {
      tool_name: "apply_patch",
      tool_input: input,
      tool_response: JSON.stringify({ output, metadata: { exit_code: 0 } }),
    }),
    ["new.ts", "moved.ts", "removed.ts"],
  );
  assert.deepEqual(
    successfulWritePaths("codex", {
      tool_name: "apply_patch",
      tool_input: input,
      tool_response: { output, metadata: { exit_code: 0 }, cancelled: true },
    }),
    [],
  );
});

test("escaping overhead drops filenames before dropping the only covered Node", () => {
  const result = toolReviewOutput([
    {
      nodeId: "node-covered",
      path: ".tent/Module/Module.md",
      names: ["Module"],
      files: ['"'.repeat(1600)],
    },
  ])!;
  assert.ok(result);
  assert.ok(Buffer.byteLength(result.stdout) <= 2048);
  assert.deepEqual(result.nodeIds, ["node-covered"]);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /node-covered/);
});

test("the removed input hook command has no prompt handling or context", async (t) => {
  const { root } = await fixture(t);
  const result = await runHookCommand("prompt", ["--host", "codex"], {
    packageRoot: root,
    stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root }),
  });
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.systemMessage, /tent hook start\|stop/);
});

async function sixCoveredNodes(t: TestContext, longNames: boolean) {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const name = `Extra${i}${longNames ? "x".repeat(130) : ""}`;
    await fs.mkdir(path.join(f.systemRoot, name));
    await fs.writeFile(
      path.join(f.systemRoot, name, name + ".md"),
      `---\nid: node-extra${i}\ntype: prompt\nsources:\n  - resource: ../../src/\n    track: structure\n---\nRule\n`,
    );
  }
  await loadStopMaterialIndex(f.systemRoot, f.root);
  return f;
}
const namedReviewNodes = (stdout: string) => {
  const message = JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
  return [...message.matchAll(/\((node-[a-z0-9]+), /g)].map((match) => match[1]);
};

test("running hook preserves omitted counts and only claims rendered Nodes for count and byte limits", async (t) => {
  for (const longNames of [false, true]) {
    const f = await sixCoveredNodes(t, longNames);
    const first = await f.tool();
    const named = namedReviewNodes(first);
    assert.ok(named.length > 0 && named.length <= 5);
    assert.equal(named.length < 5, longNames);
    assert.match(
      JSON.parse(first).hookSpecificOutput.additionalContext,
      new RegExp(`\\+${6 - named.length} more modules`),
    );
    assert.equal(
      (await fs.readdir(path.join(f.systemRoot, "temp/stop-reviews"))).length,
      named.length,
    );
    const seen = new Set(named);
    for (let i = 0; i < 6; i++) {
      const next = await f.tool();
      if (next === "{}\n") break;
      const ids = namedReviewNodes(next);
      assert.ok(ids.length);
      for (const id of ids) {
        assert.equal(seen.has(id), false);
        seen.add(id);
      }
    }
    assert.equal(seen.size, 6);
    assert.equal(await f.tool(), "{}\n");
  }
});

test("claim competition rebudgets both capped projections before claiming newly visible Nodes", async (t) => {
  for (const longNames of [false, true]) {
    const f = await sixCoveredNodes(t, longNames);
    const access = fs.access;
    let competed = false;
    fs.access = async (filename, mode) => {
      try {
        return await access(filename, mode);
      } catch (error) {
        if (
          !competed &&
          typeof filename === "string" &&
          filename.startsWith(f.systemRoot) &&
          filename.endsWith(".claim")
        ) {
          competed = true;
          await fs.mkdir(path.dirname(filename), { recursive: true });
          await fs.writeFile(filename, "", { flag: "wx" });
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    let output: string;
    try {
      output = await f.tool();
    } finally {
      fs.access = access;
      syncBuiltinESMExports();
    }
    assert.equal(competed, true);
    const named = namedReviewNodes(output!);
    assert.ok(named.length > 0);
    assert.equal(named.length < 5, longNames);
    assert.equal(named.includes("node-extra0"), false);
    const remaining = 6 - 1 - named.length;
    const message = JSON.parse(output!).hookSpecificOutput.additionalContext;
    if (remaining) assert.match(message, new RegExp(`\\+${remaining} more modules`));
    else assert.doesNotMatch(message, /more modules/);
    assert.equal(
      (await fs.readdir(path.join(f.systemRoot, "temp/stop-reviews"))).length,
      named.length + 1,
    );
    const seen = new Set(named);
    for (let i = 0; i < 6; i++) {
      const next = await f.tool();
      if (next === "{}\n") break;
      for (const id of namedReviewNodes(next)) {
        assert.equal(seen.has(id), false);
        assert.notEqual(id, "node-extra0");
        seen.add(id);
      }
    }
    assert.equal(seen.size, 5);
    assert.equal(await f.tool(), "{}\n");
  }
});
