import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { git } from "./helpers.js";
import { NodeFs } from "../src/fs/node-fs.js";

const scratch = fileURLToPath(new URL("../.scratch/", import.meta.url));

test("Card and Node reject invalid option syntax without workspace discovery", async (t) => {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "tent-cli-args-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "absent");
  for (const [run, flag] of [
    [runCardCommand, "prompt"],
    [runNodeCommand, "body"],
  ] as const) {
    for (const args of [
      ["--unknown"],
      [`--${flag}`],
      [`--${flag}`, "--json"],
      [`--${flag}`, "-text"],
      ["--json=false"],
      ["-x"],
    ]) {
      const result = await run("create", args, { cwd: root });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Unknown option|argument/);
      await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
    }
  }
  const invalidScope = await runCardCommand("list", ["--prompt=text"], { cwd: root });
  assert.match(invalidScope.stderr, /Unknown option ['"]?--prompt/);
  await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
});

test("full CLI preserves text, stdin, repeated options and terminators through direct CLI", async (t) => {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "tent-cli-args-real-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "service");
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "CLI arguments" });
  await git(path.join(workspace, ".tent"), "init");
  const entry = fileURLToPath(new URL("../src/cli/tent.ts", import.meta.url));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("TENT_") && !["CODEX_THREAD_ID", "CLAUDE_SESSION_ID"].includes(key),
    ),
  );
  env.TENT_SERVICE_DATA_DIR = dataDir;
  const cli = (command: string, sub: string, args: string[], stdin = "") =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", entry, command, sub, `--workspace=${workspace}`, "--json", ...args],
        { env, stdio: "pipe" },
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
  const success = async (command: string, sub: string, args: string[], stdin?: string) => {
    const result = await cli(command, sub, args, stdin);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const text = "-- literal=值 😀\r\n\t keep spaces  \n";
    const created = await success("node", "create", [
      "--type=prompt",
      "--body=discard",
      `--body=${text}`,
      "--",
      "--named-node",
    ]);
    const nodeId = created.node.nodeId;
    const read = await success("node", "get", [nodeId, "--full"]);
    assert.equal(read.node.name, "--named-node");
    assert.equal(read.node.text, text);
    await success(
      "node",
      "write",
      [nodeId, "--body", "-", `--base-etag=${read.node.etag}`],
      text + "stdin\n",
    );
    const written = await success("node", "get", [nodeId, "--full", "--json"]);
    assert.equal(written.node.text, text + "stdin\n");

    const card = await success("card", "create", [
      "--prompt=discard",
      "--prompt=" + text,
      "--source",
      ".tent/--named-node/--named-node.md",
      "--source",
      "docs/SPEC.md",
    ]);
    const readCard = await success("card", "get", [card.cardId]);
    assert.equal(readCard.text, text);
    assert.deepEqual(
      readCard.sources.map((source: { resource: string }) => source.resource),
      ["../--named-node/--named-node.md", "docs/SPEC.md"],
    );
    assert.equal(readCard.sources[0].version.path, "--named-node/--named-node.md");
    const stdinCard = await success("card", "create", ["--prompt", "-"], text);
    assert.equal((await success("card", "get", ["--", stdinCard.cardId])).text, text);
    for (const [command, sub, args] of [
      ["node", "write", [nodeId, "--body", "--retain-version"]],
      ["card", "create", ["--prompt=valid", "--unknown"]],
    ] as const) {
      const rejected = await cli(command, sub, [...args]);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /argument|Unknown option/);
    }
    assert.equal((await success("node", "get", [nodeId, "--full"])).node.text, text + "stdin\n");
  } finally {
    await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
  }
});
