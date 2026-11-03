import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { roleHelpText, runRoleCommand } from "../src/cli/role-commands.js";
import { cardHelpText } from "../src/cli/card-commands.js";
import { runHookCommand } from "../src/cli/hook.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliSource = path.join(repoRoot, "src", "cli", "tent.ts");
const tsxImport = import.meta.resolve("tsx");

function runCli(
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxImport, cliSource, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TENT_SERVICE_DATA_DIR: path.join(repoRoot, ".scratch", "routing-no-service"),
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("top-level help presents the canonical public collaboration model", async () => {
  const help = await runCli("--help");
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /tent role create\|delete/);
  assert.match(help.stdout, /tent card list --role/);
  assert.doesNotMatch(help.stdout, /config\|write|OKF facts/);
  assert.match(help.stdout, /tent card/);
  assert.doesNotMatch(help.stdout, /role-init/);
  assert.doesNotMatch(help.stdout, /external session|pull-host|\bboxes\b/i);
});

test("Role and Card commands route to their canonical modules", async () => {
  const roleHelp = await runCli("role", "--help");
  assert.equal(roleHelp.code, 0, roleHelp.stderr);
  assert.equal(roleHelp.stdout.trim(), roleHelpText().trim());

  const cardHelp = await runCli("card", "--help");
  assert.equal(cardHelp.code, 0, cardHelp.stderr);
  assert.equal(cardHelp.stdout.trim(), cardHelpText().trim());

  const unknown = await runCli("not-a-command");
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown command: tent not-a-command/);
});

test("retired Role initialization and checkpoint commands stay absent", async () => {
  const roleInit = await runCli("role-init");
  assert.notEqual(roleInit.code, 0);
  assert.match(roleInit.stderr, /Unknown command: tent role-init/);

  const roleCpHelp = await runCli("role-checkpoint", "--help");
  assert.notEqual(roleCpHelp.code, 0);
  assert.match(roleCpHelp.stderr, /Unknown command: tent role-checkpoint/);
});

test("subcommand help works without required fields, stdin or a Workspace", async () => {
  for (const sub of ["create", "delete"]) {
    for (const flag of ["--help", "-h"]) {
      const result = await runRoleCommand(sub, [flag], { cwd: "C:/does-not-exist/tent-help" });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, roleHelpText());
    }
  }
  for (const sub of ["stop"]) {
    for (const flag of ["--help", "-h"]) {
      const result = await runHookCommand(sub, [flag], {
        get packageRoot(): string {
          throw new Error("Hook help must not inspect the package or Workspace");
        },
        get stdin(): string {
          throw new Error("Hook help must not read stdin");
        },
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /tent hook stop --host codex\|claude-code/);
      assert.doesNotMatch(result.stdout, /unavailable/);
    }
  }
  for (const args of [["role", "create"], ["hook", "stop"], ["new"], ["version"]]) {
    const result = await runCli(...args, "--help");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /tent /);
    assert.doesNotMatch(result.stdout, /unavailable|already a Tent/);
  }
});

test("Stop validates arguments before reading stdin", async () => {
  for (const args of [[], ["--host", "unsupported"], ["--unknown"], ["--host"]]) {
    const result = await runHookCommand("stop", args, {
      get packageRoot(): string {
        throw new Error("Stop must not inspect the package");
      },
      get stdin(): string {
        throw new Error("Invalid Stop arguments must not read stdin");
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "{}\n");
    assert.match(result.stderr, /Hook host must be|Unknown option|argument missing/);
    assert.doesNotMatch(result.stderr, /must not read stdin/);
  }
});

test("top-level hook routing preserves the handler's error status and stderr", async () => {
  const result = await runCli("hook", "stop", "--host", "unsupported");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "{}\n");
  assert.match(result.stderr, /^Hook host must be codex or claude-code\n/);
});

test("Stop accepts each native host envelope without inspecting package metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "hook-routing-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  initializeFixtureRepository(root);
  for (const host of ["codex", "claude-code"]) {
    const result = await runHookCommand("stop", ["--host", host], {
      get packageRoot(): string {
        throw new Error("Stop must not inspect package metadata");
      },
      stdin: JSON.stringify({ hook_event_name: "Stop", cwd: root }),
    });
    assert.deepEqual(result, { exitCode: 0, stdout: "{}\n", stderr: "" });
  }
});

test("Stop reports malformed JSON and native stdin errors", async () => {
  const malformed = await runHookCommand("stop", ["--host", "codex"], {
    packageRoot: repoRoot,
    stdin: "{",
  });
  assert.equal(malformed.exitCode, 1);
  assert.equal(malformed.stdout, "{}\n");
  assert.match(malformed.stderr, /JSON|Expected|Unexpected/);
  const failedRead = await runHookCommand("stop", ["--host", "claude-code"], {
    packageRoot: repoRoot,
    get stdin(): string {
      throw new Error("Controlled hook stdin read failure");
    },
  });
  assert.equal(failedRead.exitCode, 1);
  assert.equal(failedRead.stdout, "{}\n");
  assert.match(failedRead.stderr, /^Controlled hook stdin read failure\n/);
});
