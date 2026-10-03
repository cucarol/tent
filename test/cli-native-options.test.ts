import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = fileURLToPath(new URL("../.scratch/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "cli-native-options-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function cli(cwd: string, args: string[], stdin = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../src/cli/tent.ts", import.meta.url)),
        ...args,
      ],
      {
        cwd,
        windowsHide: true,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                !key.startsWith("TENT_") && !["CODEX_THREAD_ID", "CLAUDE_SESSION_ID"].includes(key),
            ),
          ),
          TENT_SERVICE_DATA_DIR: path.join(cwd, "absent-service"),
        },
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("Role validates option syntax before discovery", async (t) => {
  const root = await fixture(t);
  const dataDir = path.join(root, "absent");
  for (const [run, sub, flag] of [[runRoleCommand, "create", "title"]] as const) {
    for (const args of [
      ["--unknown"],
      [`--${flag}`],
      [`--${flag}`, "--json"],
      [`--${flag}`, "-value"],
      ["--json=false"],
    ]) {
      const rejected = await run(sub, args, { cwd: root });
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr, /Unknown option|Unknown command|argument/);
      await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
    }
  }
});

test("full direct CLI preserves Role text, Unicode, duplicate flags and stdin", async (t) => {
  const root = await fixture(t);
  const workspace = path.join(root, "workspace");
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Role and Hook arguments" });
  await git(path.join(workspace, ".tent"), "init");
  const run = async (command: string, sub: string, args: string[], stdin?: string) => {
    const result = await cli(
      root,
      [command, sub, `--workspace=${workspace}`, "--json", ...args],
      stdin,
    );
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  {
    const role = await run("role", "create", ["--title=discard", "--title=审查 😀"]);
    assert.match(role.roleId, /^role-/);
    let document = await run("role", "show", ["--", role.roleId]);
    const text = "-- body=文本 😀\r\n\t spaces  \n";
    await run("role", "write", [
      role.roleId,
      "--body=discard",
      `--body=${text}`,
      `--base-etag=${document.etag}`,
    ]);
    document = await run("role", "show", [role.roleId]);
    assert.equal(document.text, text);
    await run(
      "role",
      "write",
      [role.roleId, "--body", "-", `--base-etag=${document.etag}`],
      text + "stdin\n",
    );
    assert.equal((await run("role", "show", [role.roleId])).text, text + "stdin\n");
  }
});

test("new and retired agent-hooks parse only their own options in isolated directories", async (t) => {
  const root = await fixture(t);
  const created = await cli(root, ["new", "--", "--workspace-name"]);
  assert.equal(created.code, 0, created.stderr);
  await fs.stat(path.join(root, "--workspace-name", ".tent"));
  for (const args of [
    ["new", "untouched", "--unknown"],
    ["agent-hooks", "install", `--home=${path.join(root, "untouched")}`, "--tent-command"],
    ["agent-hooks", "install", `--home=${path.join(root, "untouched")}`, "--json=false"],
  ]) {
    const rejected = await cli(root, args);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /Unknown option|Unknown command|argument/);
    await assert.rejects(fs.stat(path.join(root, "untouched")), { code: "ENOENT" });
  }
});
