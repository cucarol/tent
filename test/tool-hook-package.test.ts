import { testScratchRoot } from "./scratch.js";
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

test(
  "both packaged tool launchers deliver context with the full CLI absent",
  { timeout: 30000 },
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
    const { validateHostPackage } = await import(
      pathToFileURL(path.join(root, "scripts/validate-plugin.mjs")).href
    );
    const runtime = path.join(fixture, "runtime");
    await buildPluginRuntime(root, runtime);
    for (const host of ["codex", "claude-code"]) {
      const pkg = path.join(fixture, host, "package with spaces");
      await fs.cp(runtime, pkg, { recursive: true });
      for (const directory of ["skills", "skill-resources"])
        await fs.cp(path.join(root, directory), path.join(pkg, directory), { recursive: true });
      await fs.cp(path.join(root, "plugins", host, "tent"), pkg, { recursive: true });
      await fs.mkdir(path.join(pkg, "skills/tent-init/references"), { recursive: true });
      await fs.copyFile(
        path.join(root, "plugins", host, "tent/host-hooks.md"),
        path.join(pkg, "skills/tent-init/references/host-hooks.md"),
      );
      await validateHostPackage(pkg, host);
      const workspace = path.join(fixture, host, "workspace");
      await fs.mkdir(workspace);
      await scaffoldInWorkspace(openTestFs(workspace), { name: "package" });
      const system = path.join(workspace, ".tent");
      await fs.mkdir(path.join(system, ".git"));
      await fs.mkdir(path.join(system, "Module"));
      await fs.writeFile(
        path.join(system, "Module/Module.md"),
        "---\nid: node-packaged\ntype: prompt\nsources:\n  - resource: ../../src/\n    track: structure\n---\nRule\n",
      );
      await loadStopMaterialIndex(system, workspace);
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
      assert.equal(hooks.Stop, undefined);
    }
  },
);
