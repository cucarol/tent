import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { roleHelpText, runRoleCommand } from "../src/cli/role-commands.js";
import { cardHelpText } from "../src/cli/card-commands.js";
import { runHookCommand } from "../src/cli/hook.js";

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
  assert.match(help.stdout, /tent role list\|show\|write\|create/);
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
  assert.match(unknown.stderr, /Unknown command: not-a-command/);
});

test("retired Role initialization and checkpoint commands stay absent", async () => {
  const roleInit = await runCli("role-init");
  assert.notEqual(roleInit.code, 0);
  assert.match(roleInit.stderr, /Unknown command: role-init/);

  const roleCpHelp = await runCli("role-checkpoint", "--help");
  assert.notEqual(roleCpHelp.code, 0);
  assert.match(roleCpHelp.stderr, /Unknown command: role-checkpoint/);
});

test("subcommand help works without required fields, stdin or a Workspace", async () => {
  for (const sub of ["list", "show", "write", "create"]) {
    for (const flag of ["--help", "-h"]) {
      const result = await runRoleCommand(sub, [flag], { cwd: "C:/does-not-exist/tent-help" });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, roleHelpText());
    }
  }
  for (const sub of ["start", "stop"]) {
    const result = await runHookCommand(sub, ["--help"], {
      packageRoot: repoRoot,
      stdin: "this must not be read as a Hook event",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /tent hook start\|stop/);
    assert.doesNotMatch(result.stdout, /unavailable/);
  }
  for (const args of [["role", "create"], ["hook", "start"], ["new"], ["version"]]) {
    const result = await runCli(...args, "--help");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /tent /);
    assert.doesNotMatch(result.stdout, /unavailable|already a Tent/);
  }
});
