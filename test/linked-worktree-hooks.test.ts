import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { findTentSystemRoot } from "../src/core/status.js";
import { resolveWorkspacePaths } from "../src/cli/workspace-path.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runHookCommand } from "../src/cli/hook.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { inspectNodeSync } from "../src/core/node-sync.js";
import { createTurnPathResolver } from "../src/core/git-checkout.js";

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(testScratchRoot(), "linked-hooks-"));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const main = path.join(base, "main");
  await fs.mkdir(path.join(main, "src/core"), { recursive: true });
  await fs.writeFile(path.join(main, "src/core/code.ts"), "export const value = 1;\n");
  await fs.writeFile(
    path.join(main, "package.json"),
    '{"name":"hook-fixture","version":"0.1.2"}\n',
  );
  await git(main, "init", "--quiet");
  await git(main, "add", "src");
  await git(main, "commit", "--quiet", "-m", "test: seed");
  const roots = [
    main,
    path.join(main, ".worktrees/topic"),
    path.join(base, "codex-home/worktrees/id/project"),
    path.join(main, ".claude/worktrees/topic"),
  ];
  for (const root of roots.slice(1))
    await git(main, "worktree", "add", "--quiet", "--detach", root);
  await initializeTentWorkspace(main);
  const created = await runNodeCommand(
    "create",
    [
      "Core",
      "--type",
      "goal",
      "--sources-json",
      '[{"resource":"src/core/","track":"structure"},{"resource":"src/core/code.ts"}]',
      "--body",
      "Core rules.",
    ],
    { cwd: main, json: true },
  );
  assert.equal(created.exitCode, 0, created.stderr);
  const node = JSON.parse(created.stdout).node;
  return { base, main, roots, node, systemRoot: path.join(main, ".tent") };
}

test("linked checkout CLI discovery, append and material state use the main Tent", async (t) => {
  const { main, roots, node, systemRoot } = await fixture(t);
  const initial = await inspectNodeSync(new NodeFs(systemRoot), node.nodeId);
  for (const [index, root] of roots.entries()) {
    const cwd = path.join(root, "src/core");
    assert.equal(await findTentSystemRoot(cwd), systemRoot);
    assert.deepEqual(await resolveWorkspacePaths({ cwd }), { workspaceRoot: main, systemRoot });
    assert.deepEqual(await resolveWorkspacePaths({ workspace: root }), {
      workspaceRoot: main,
      systemRoot,
    });
    if (index) {
      await fs.writeFile(path.join(root, "src/core/code.ts"), "branch-only change\n");
      await fs.writeFile(path.join(root, "src/core/new.ts"), "branch-only member\n");
    }
    const resolved = await resolveWorkspacePaths({ cwd });
    assert.deepEqual(await inspectNodeSync(new NodeFs(resolved.systemRoot), node.nodeId), initial);
    const brief = await runWorkspaceCommand("brief", [], { cwd, json: true });
    assert.equal(brief.exitCode, 0, brief.stderr);
    assert.doesNotMatch(brief.stdout, /branch-only|src\/core\/new\.ts/);
    const start = await runHookCommand("start", ["--host", "codex"], {
      packageRoot: main,
      stdin: JSON.stringify({ cwd, hook_event_name: "SessionStart" }),
    });
    assert.ok(
      JSON.parse(start.stdout).hookSpecificOutput?.additionalContext.includes(
        `Tent Workspace: ${main}`,
      ),
      start.stdout,
    );
  }
  const appended = await runNodeCommand(
    "append",
    [node.nodeId, "--body", "Shared rule from a branch."],
    { cwd: roots[2], json: true },
  );
  assert.equal(appended.exitCode, 0, appended.stderr);
  assert.match(await fs.readFile(path.join(main, node.path), "utf8"), /Shared rule from a branch/);
  for (const root of roots.slice(1))
    assert.equal(await fs.stat(path.join(root, ".tent")).catch(() => undefined), undefined);
  await fs.writeFile(path.join(main, "src/core/code.ts"), "main changed\n");
  assert.ok((await inspectNodeSync(new NodeFs(systemRoot), node.nodeId)).behind);
});

for (const host of ["codex", "claude-code"] as const) {
  test(`${host} Stop routes writes across main, internal and external linked checkouts`, async (t) => {
    const { base, main, roots, node } = await fixture(t);
    const foreign = path.join(main, "src/foreign");
    await fs.mkdir(foreign);
    await git(foreign, "init", "--quiet");
    const submodule = path.join(main, "src/submodule");
    await fs.mkdir(submodule);
    await fs.mkdir(path.join(main, ".git/modules/submodule"), { recursive: true });
    await fs.writeFile(path.join(submodule, ".git"), "gitdir: ../../.git/modules/submodule\n");
    // The main module also covers these nested repository paths, so a silent result
    // proves repository isolation rather than an incidental coverage miss.
    const document = path.join(main, node.path);
    await fs.writeFile(
      document,
      (await fs.readFile(document, "utf8")).replace("../../src/core/", "../../src/"),
    );
    let turn = 0;
    async function stop(cwd: string, file: string) {
      const id = `turn-${turn++}`;
      const log = path.join(base, `${id}.jsonl`);
      const rows =
        host === "codex"
          ? [
              { type: "turn_context", payload: { turn_id: id, cwd } },
              { type: "event_msg", payload: { type: "task_started", turn_id: id } },
              {
                type: "response_item",
                payload: {
                  type: "custom_tool_call",
                  name: "apply_patch",
                  call_id: "patch",
                  input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch`,
                },
              },
              {
                type: "response_item",
                payload: {
                  type: "custom_tool_call_output",
                  call_id: "patch",
                  output: "Success. Updated the following files:\n",
                },
              },
            ]
          : [
              { type: "user", promptId: id, cwd, message: { content: "Edit code." } },
              {
                type: "assistant",
                cwd,
                message: {
                  content: [
                    { type: "tool_use", id: "write", name: "Write", input: { file_path: file } },
                  ],
                },
              },
              {
                type: "user",
                promptId: id,
                cwd,
                message: {
                  content: [{ type: "tool_result", tool_use_id: "write", is_error: false }],
                },
                toolUseResult: { type: "update", filePath: file },
              },
            ];
      await fs.writeFile(log, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return JSON.parse(
        (
          await runHookCommand("stop", ["--host", host], {
            packageRoot: main,
            stdin: JSON.stringify({
              cwd,
              session_id: host,
              turn_id: id,
              prompt_id: id,
              transcript_path: log,
              hook_event_name: "Stop",
            }),
          })
        ).stdout,
      );
    }
    for (const cwd of roots) {
      for (const target of roots) {
        const notice = await stop(cwd, path.join(target, "src/core/code.ts"));
        const reason =
          host === "codex" ? notice.reason : notice.hookSpecificOutput?.additionalContext;
        assert.ok(reason?.includes(node.nodeId), JSON.stringify({ cwd, target, notice }));
        assert.match(reason, /src\/core\/code\.ts/);
        assert.doesNotMatch(reason, /\.worktrees|codex-home|\.claude/);
      }
      const relativeCwd = host === "codex" ? path.join(cwd, "src/core") : cwd;
      const notice = await stop(relativeCwd, "src/core/code.ts");
      assert.ok(
        (host === "codex" ? notice.reason : notice.hookSpecificOutput?.additionalContext)?.includes(
          node.nodeId,
        ),
      );
      for (const other of [foreign, submodule])
        assert.deepEqual(await stop(cwd, path.join(other, "code.ts")), {});
    }
    assert.equal(await findTentSystemRoot(submodule), undefined);
    assert.deepEqual(await stop(submodule, path.join(submodule, "code.ts")), {});
    if (process.platform === "win32") {
      for (const root of roots) {
        const cwd = path.join(root.toLowerCase(), "src/core");
        const shared = await findTentSystemRoot(cwd);
        assert.ok(shared);
        assert.equal(await fs.realpath(shared), await fs.realpath(path.join(main, ".tent")));
        const resolver = await createTurnPathResolver(main, cwd);
        assert.equal(path.relative(root, resolver.checkoutRoot!), "");
        for (const target of roots) {
          const file = path.join(target.toLowerCase(), "src/core/code.ts");
          assert.equal(
            await fs.realpath(file),
            await fs.realpath(path.join(target, "src/core/code.ts")),
          );
          assert.equal(await resolver.relative(file), "src/core/code.ts");
          const notice = await stop(cwd, file);
          const reason =
            host === "codex" ? notice.reason : notice.hookSpecificOutput?.additionalContext;
          assert.ok(reason?.includes(node.nodeId), JSON.stringify({ cwd, file, notice }));
        }
        const relativeCwd = host === "codex" ? cwd : root.toLowerCase();
        const notice = await stop(relativeCwd, "src/core/code.ts");
        assert.ok(
          (host === "codex"
            ? notice.reason
            : notice.hookSpecificOutput?.additionalContext
          )?.includes(node.nodeId),
        );
        for (const other of [foreign, submodule])
          assert.deepEqual(await stop(cwd, path.join(other.toLowerCase(), "code.ts")), {});
      }
    }
  });
}

test("linked worktrees of a bare repository do not inherit an unrelated parent Tent", async (t) => {
  const { main, base } = await fixture(t);
  const bare = path.join(base, "bare.git");
  await git(base, "clone", "--bare", "--quiet", main, bare);
  const linked = path.join(main, "bare-linked");
  await git(bare, "worktree", "add", "--quiet", "--detach", linked);
  assert.equal(await findTentSystemRoot(linked), undefined);
});
