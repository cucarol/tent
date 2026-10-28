import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { runHookCommand } from "../src/cli/hook.js";
import { runToolHook } from "../src/cli/tool-hook.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { recordSectionFingerprints } from "../src/fs/section-fingerprint-baseline.js";
import { changedSections, settleSections } from "../src/fs/section-fingerprints.js";
import { sectionKey } from "../src/core/return/section-fingerprint.js";
import { toolReviewOutput } from "../src/cli/hook-adapter.js";
import { successfulWritePaths } from "../src/cli/tool-write-event.js";
import { ANSWER_REVIEW, TOOL_REVIEW_ACTION } from "../src/core/return/tool-turn-review.js";
import { hasStopReviewClaim } from "../src/fs/stop-review-claim.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "tool-hooks-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), { name: "hooks" });
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
    tool_response: `Exit code: 0\nWall time: 1.4 seconds\nOutput:\nSuccess. Updated the following files:\n${files.map((file) => "M " + file).join("\n")}\n`,
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
    {
      tool_response:
        "Exit code: 1\nWall time: 0.2 seconds\nOutput:\nSuccess. Updated the following files:\nM src/code.ts\n",
    },
    { tool_name: "Read" },
    { turn_id: undefined },
    { session_id: undefined },
    { tool_response: "Success. Updated the following files:\n" },
  ])
    assert.equal(await tool(undefined, extra), "{}\n");
  for (const file of [
    "unknown.txt",
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
  for (const tool_response of [output, `Exit code: 0\nWall time: 1.4 seconds\nOutput:\n${output}`])
    assert.deepEqual(
      successfulWritePaths("codex", { tool_name: "apply_patch", tool_input: input, tool_response }),
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

test("covering Nodes keep their room when an unowned note joins them", () => {
  const modules = Array.from({ length: 5 }, (_, i) => ({
    nodeId: `node-${i}`,
    path: `.tent/M${i}/M${i}.md`,
    names: ["n".repeat(219)],
    files: ["src/a.ts"],
  }));
  const alone = toolReviewOutput(modules)!;
  const joined = toolReviewOutput(modules, ["new.ts"])!;
  assert.deepEqual(joined.nodeIds, alone.nodeIds);
  assert.equal(joined.nodeIds.length, 5);
  assert.deepEqual(joined.files, []);
  assert.ok(Buffer.byteLength(joined.stdout) <= 2048);
  const roomy = toolReviewOutput(modules.slice(0, 1), ["new.ts"])!;
  assert.deepEqual([roomy.nodeIds, roomy.files], [["node-0"], ["new.ts"]]);
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

test("material links name a file's Nodes, and a linked section only after that section changes", async (t) => {
  const { root, systemRoot, tool } = await fixture(t);
  for (const [name, id, resource] of [
    ["Spec", "node-spec", "../../docs/README.md"],
    ["Rule", "node-rule", "../../docs/SPEC.md#Hooks"],
  ]) {
    await fs.mkdir(path.join(systemRoot, name!));
    await fs.writeFile(
      path.join(systemRoot, name!, name + ".md"),
      `---\nid: ${id}\ntype: prompt\nsources:\n  - resource: ${resource}\n---\nRule\n`,
    );
  }
  await fs.mkdir(path.join(root, "docs"));
  const spec = (hooks: string, other: string) =>
    fs.writeFile(path.join(root, "docs/SPEC.md"), `# Hooks\n${hooks}\n# Other\n${other}\n`);
  await spec("old", "old");
  await fs.writeFile(path.join(root, "docs/README.md"), "readme");
  await recordSectionFingerprints(systemRoot, root, await loadStopMaterialIndex(systemRoot, root));
  await spec("old", "new");
  assert.equal(await tool(["docs/SPEC.md"], { turn_id: "t1" }), "{}\n");
  await spec("new", "new");
  assert.match(await tool(["docs/SPEC.md"], { turn_id: "t2" }), /node-rule/);
  assert.equal(await tool(["docs/SPEC.md"], { turn_id: "t3" }), "{}\n");
  await spec("new", "newer");
  assert.equal(await tool(["docs/SPEC.md"], { turn_id: "t4" }), "{}\n");
  assert.match(
    await tool(["docs/README.md", "src/a.ts"], { turn_id: "t5" }),
    /node-spec[\s\S]*node-module|node-module[\s\S]*node-spec/,
  );
  // Without a record the section is unknown: recorded quietly, named on its next change.
  await fs.rm(path.join(systemRoot, "temp/section-fingerprints"), { recursive: true });
  await spec("newest", "newer");
  assert.equal(await tool(["docs/SPEC.md"], { turn_id: "t6" }), "{}\n");
  await spec("again", "newer");
  assert.match(await tool(["docs/SPEC.md"], { turn_id: "t7" }), /node-rule/);
});

test("a linked heading is followed through inline Markdown and a respelling", async (t) => {
  const { root, systemRoot, tool } = await fixture(t);
  await fs.mkdir(path.join(systemRoot, "Rule"));
  await fs.writeFile(
    path.join(systemRoot, "Rule/Rule.md"),
    "---\nid: node-rule\ntype: prompt\nsources:\n  - resource: ../../docs/SPEC.md#Hooks\n---\nRule\n",
  );
  await fs.mkdir(path.join(root, "docs"));
  const spec = (heading: string, hooks: string) =>
    fs.writeFile(path.join(root, "docs/SPEC.md"), `${heading}\n${hooks}\n# Other\nx\n`);
  await spec("# [Hooks](https://example.test)", "old");
  await recordSectionFingerprints(systemRoot, root, await loadStopMaterialIndex(systemRoot, root));
  await spec("# [Hooks](https://example.test)", "new");
  assert.match(await tool(["docs/SPEC.md"], { turn_id: "t1" }), /node-rule/);
  assert.equal(await tool(["docs/SPEC.md"], { turn_id: "t2" }), "{}\n");
  // The recorded line is gone after a respelling; the plain heading finds the section again.
  await spec("## Hooks ##", "new");
  assert.match(await tool(["docs/SPEC.md"], { turn_id: "t3" }), /node-rule/);
  await spec("## Hooks ##", "newer");
  assert.match(await tool(["docs/SPEC.md"], { turn_id: "t4" }), /node-rule/);
  assert.equal(await tool(["docs/SPEC.md"], { turn_id: "t5" }), "{}\n");
});

test("a slower hook never settles an older version over a newer one, and parallel settles both land", async (t) => {
  const { root, systemRoot } = await fixture(t);
  await fs.mkdir(path.join(systemRoot, "Rule"));
  await fs.writeFile(
    path.join(systemRoot, "Rule/Rule.md"),
    "---\nid: node-rule\ntype: prompt\nsources:\n  - resource: ../../docs/SPEC.md#A\n  - resource: ../../docs/SPEC.md#B\n---\nRule\n",
  );
  await fs.mkdir(path.join(root, "docs"));
  const spec = (a: string, b: string) =>
    fs.writeFile(path.join(root, "docs/SPEC.md"), `# A\n${a}\n# B\n${b}\n`);
  const sections = new Map(
    ["A", "B"].map((heading) => [
      sectionKey("docs/SPEC.md", heading),
      { path: "docs/SPEC.md", heading },
    ]),
  );
  const changed = () => changedSections(systemRoot, root, sections);
  await spec("0", "0");
  await recordSectionFingerprints(systemRoot, root, await loadStopMaterialIndex(systemRoot, root));
  await spec("1", "0");
  const slow = await changed();
  await spec("2", "0");
  await settleSections(systemRoot, root, await changed());
  await settleSections(systemRoot, root, slow);
  assert.deepEqual([...(await changed()).keys()], []);
  // A late settle of what a hook saw earlier leaves a newer, unsettled version named.
  await spec("3", "0");
  const seen = await changed();
  await spec("4", "0");
  const unsettled = await changed();
  await settleSections(systemRoot, root, seen);
  assert.deepEqual([...(await changed()).keys()], [...unsettled.keys()]);
  await spec("5", "5");
  const [a, b] = [new Map(), new Map()];
  for (const [key, section] of await changed()) (section.heading === "A" ? a : b).set(key, section);
  await Promise.all([settleSections(systemRoot, root, a), settleSections(systemRoot, root, b)]);
  assert.deepEqual([...(await changed()).keys()], []);
});

test("the record keeps the order a linked file was read in, even when a read is held", async (t) => {
  const { root, systemRoot, tool } = await fixture(t);
  await fs.mkdir(path.join(systemRoot, "Rule"));
  await fs.writeFile(
    path.join(systemRoot, "Rule/Rule.md"),
    "---\nid: node-rule\ntype: prompt\nsources:\n  - resource: ../../doc.md#A\n---\nRule\n",
  );
  const file = path.join(root, "doc.md");
  const version = (value: string) => fs.writeFile(file, `# A\n${value}\n`);
  await version("0");
  await recordSectionFingerprints(systemRoot, root, await loadStopMaterialIndex(systemRoot, root));
  // The first hook starts reading version 1 but its read lands only after version 2 is written.
  const readFile = fs.readFile;
  let held!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  fs.readFile = (async (...args: unknown[]) => {
    if (args[0] === file && ++reads === 1) {
      held();
      await gate;
    }
    return (readFile as (...values: unknown[]) => Promise<unknown>)(...args);
  }) as typeof readFile;
  syncBuiltinESMExports();
  try {
    await version("1");
    const first = tool(["doc.md"], { turn_id: "first" });
    await holding;
    assert.match(await tool(["doc.md"], { turn_id: "second" }), /node-rule/);
    await version("2");
    release();
    assert.match(await first, /node-rule/);
  } finally {
    release();
    fs.readFile = readFile;
    syncBuiltinESMExports();
  }
  assert.equal(await tool(["doc.md"], { turn_id: "third" }), "{}\n");
  // A guard left by a hook that exited is reclaimed.
  const records = path.join(systemRoot, "temp/section-fingerprints");
  const guard = path.join(
    records,
    (await fs.readdir(records)).find((name) => !name.includes("."))! + ".guard",
  );
  await fs.mkdir(guard);
  const exited = spawnSync(process.execPath, ["-e", "0"]).pid;
  await fs.writeFile(
    path.join(guard, "owner.json"),
    JSON.stringify({ token: "gone", pid: exited }),
  );
  await version("3");
  assert.match(await tool(["doc.md"], { turn_id: "fourth" }), /node-rule/);
  assert.equal(await tool(["doc.md"], { turn_id: "fifth" }), "{}\n");
});

test("hand-written code no module owns is named once per session, beside covering Nodes", async (t) => {
  const { root, systemRoot, tool } = await fixture(t);
  const note = (paths: string) =>
    `Tent: no module Node owns these files: ${paths}. Before you end this turn, add a directory or filename-prefix source with track: structure to the module Node that owns them, or create a module Node if they start a new area. If they are temporary, say nothing about them.`;
  const context = (output: string) => JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.equal(context(await tool(["app/new.ts"])), note("app/new.ts"));
  assert.equal(await tool(["app/new.ts"], { turn_id: "later" }), "{}\n");
  assert.equal(context(await tool(["app/new.ts"], { session_id: "other" })), note("app/new.ts"));
  for (const file of ["app/a.test.ts", "app/gen/x.ts", "vendor/x.ts", "app/notes.md"])
    assert.equal(await tool([file], { turn_id: file }), "{}\n", file);
  const both = context(await tool(["src/a.ts", "app/b.ts"], { turn_id: "both" }));
  assert.equal(
    both,
    `Tent: these Nodes cover the file you just changed:\n- Module (node-module, .tent/Module/Module.md): src/a.ts\n${TOOL_REVIEW_ACTION}\n\n${note("app/b.ts")}`,
  );
  // A module owns every directory it names, tracked or not.
  await fs.writeFile(
    path.join(systemRoot, "Other/Other.md"),
    "---\nid: node-other\ntype: prompt\nsources:\n  - resource: ../../lib/\n    track: structure\n  - resource: ../../app/owned/\n---\nRule\n",
  );
  await loadStopMaterialIndex(systemRoot, root);
  assert.equal(await tool(["app/owned/x.ts"], { turn_id: "owned" }), "{}\n");
  const many = Array.from({ length: 20 }, (_, i) => `app/many/file-${i}.ts`);
  const listed = await tool(many, { turn_id: "many" });
  assert.ok(Buffer.byteLength(listed) <= 2048);
  assert.equal(context(listed), note(`${[...many].sort().slice(0, 8).join(", ")}, +12 more`));
});
