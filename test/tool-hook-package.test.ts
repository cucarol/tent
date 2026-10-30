import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { scaffoldInWorkspace } from "./scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { recordSectionFingerprints } from "../src/fs/section-fingerprint-baseline.js";

test(
  "both packaged tool launchers load the CLI only for explicit graph refresh and preserve claims/sections",
  { timeout: 90000 },
  async (t) => {
    const root = process.cwd();
    const scratch = testScratchRoot();
    await fs.mkdir(scratch, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(scratch, "tool-package-"));
    t.after(() =>
      removeTestFixture(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
    );
    const { buildPluginRuntime } = await import(
      pathToFileURL(path.join(root, "esbuild.config.mjs")).href
    );
    const { hostDocuments, validateHostPackage } = await import(
      pathToFileURL(path.join(root, "scripts/validate-plugin.mjs")).href
    );
    const runtime = process.env.TENT_TEST_TOOL_HOOK_RUNTIME
      ? path.resolve(process.env.TENT_TEST_TOOL_HOOK_RUNTIME)
      : path.join(fixture, "runtime");
    if (!process.env.TENT_TEST_TOOL_HOOK_RUNTIME) await buildPluginRuntime(root, runtime);
    for (const host of ["codex", "claude-code"]) {
      const pkg = path.join(fixture, host, "package with spaces");
      await fs.cp(runtime, pkg, { recursive: true });
      for (const directory of ["skills", "skill-resources"])
        await fs.cp(path.join(root, directory), path.join(pkg, directory), { recursive: true });
      await fs.cp(path.join(root, "plugins", host, "tent"), pkg, { recursive: true });
      for (const [name, target] of Object.entries(hostDocuments as Record<string, string>)) {
        await fs.mkdir(path.dirname(path.join(pkg, target)), { recursive: true });
        await fs.copyFile(path.join(root, "plugins", host, "tent", name), path.join(pkg, target));
      }
      await validateHostPackage(pkg, host);
      const workspace = path.join(fixture, host, "workspace");
      await fs.mkdir(workspace);
      initializeFixtureRepository(workspace);
      await scaffoldInWorkspace(openTestFs(workspace), { name: "package" });
      const system = path.join(workspace, ".tent");
      await fs.mkdir(path.join(system, ".git"));
      await fs.mkdir(path.join(system, "Module"));
      await fs.writeFile(
        path.join(system, "Module/Module.md"),
        "---\nid: node-packaged\ntype: prompt\nsources:\n  - resource: ../../src/\n    track: structure\n---\nRule\n",
      );
      await fs.mkdir(path.join(system, "Linked"));
      await fs.writeFile(
        path.join(system, "Linked/Linked.md"),
        "---\nid: node-section\ntype: prompt\nsources: [{resource: '../../guide.md#Tracked'}]\n---\nRule\n",
      );
      await fs.writeFile(path.join(workspace, "guide.md"), "# Tracked\nbefore\n");
      const index = await loadStopMaterialIndex(system, workspace);
      await recordSectionFingerprints(system, workspace, index);
      const hooks = JSON.parse(await fs.readFile(path.join(pkg, "hooks/hooks.json"), "utf8")).hooks;
      assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "SessionStart"]);
      await fs.rename(path.join(pkg, "cli.mjs"), path.join(pkg, "cli.saved.mjs"));
      const invoke = (event: string, extra: Record<string, unknown> = {}) =>
        new Promise<string>((resolve, reject) => {
          const child = exec(
            hooks[event][0].hooks[0].command,
            {
              cwd: workspace,
              env: {
                ...process.env,
                [host === "codex" ? "PLUGIN_ROOT" : "CLAUDE_PLUGIN_ROOT"]: pkg,
              },
              windowsHide: true,
              timeout: 10000,
            },
            (error, stdout, stderr) =>
              error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
          );
          child.stdin!.end(
            JSON.stringify({
              hook_event_name: event,
              cwd: workspace,
              session_id: "session",
              turn_id: "turn",
              prompt_id: "turn",
              ...extra,
            }),
          );
        });
      const file = path.join(workspace, "src/code.ts");
      const output = await invoke("PostToolUse", {
        tool_name: host === "codex" ? "apply_patch" : "Write",
        tool_input:
          host === "codex" ? { command: "*** Begin Patch\n*** End Patch" } : { file_path: file },
        tool_response:
          host === "codex"
            ? "Exit code: 0\nWall time: 1.4 seconds\nOutput:\nSuccess. Updated the following files:\nM src/code.ts\n"
            : { type: "update", filePath: file },
      });
      assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /node-packaged/);
      await fs.writeFile(
        path.join(system, "Module/Module.md"),
        "---\nid: node-packaged\ntype: prompt\nsources:\n  - resource: ../../lib/\n    track: structure\n---\nRule\n",
      );
      await fs.writeFile(path.join(workspace, "guide.md"), "# Tracked\nafter\n");
      const graphFile = path.join(system, "Module/Module.md");
      const write = (filename: string, turn = "turn") =>
        invoke("PostToolUse", {
          turn_id: turn,
          prompt_id: turn,
          tool_name: host === "codex" ? "apply_patch" : "Write",
          tool_input:
            host === "codex"
              ? { command: "*** Begin Patch\n*** End Patch" }
              : { file_path: filename },
          tool_response:
            host === "codex"
              ? `Success. Updated the following files:\nM ${filename}\n`
              : { type: "update", filePath: filename },
        });
      // Only explicit graph writes need the CLI export. Without it, ordinary
      // writes keep reading the old prepared coverage rather than rebuilding.
      assert.equal(await write(graphFile), "{}\n");
      assert.doesNotMatch(await write(path.join(workspace, "lib/still-stale.ts")), /node-packaged/);
      await fs.rename(path.join(pkg, "cli.saved.mjs"), path.join(pkg, "cli.mjs"));
      assert.equal(await write(graphFile), "{}\n");
      assert.equal(await write(path.join(workspace, "lib/already-claimed.ts")), "{}\n");
      assert.match(await write(path.join(workspace, "lib/next.ts"), "next"), /node-packaged/);
      assert.match(await write(path.join(workspace, "guide.md")), /node-section/);
      assert.equal(hooks.Stop, undefined);
    }
  },
);
