import { testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";
import { openTestFs } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { scaffoldInWorkspace } from "./scaffold.js";

const scratch = testScratchRoot();

test("Card and Node reject invalid option syntax without workspace discovery", async (t) => {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "tent-cli-args-invalid-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
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
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "service");
  await scaffoldInWorkspace(openTestFs(workspace), { name: "CLI arguments" });
  await initializeFixtureHistory(path.join(workspace, ".tent"));
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
    const filename = path.join(workspace, created.node.path);
    assert.equal(created.node.path, ".tent/--named-node/--named-node.md");
    assert.equal(parseFrontmatter(await fs.readFile(filename, "utf8")).body, text);
    const stdinNode = await success(
      "node",
      "create",
      [
        "Stdin",
        "--type",
        "prompt",
        "--body",
        "-",
        "--description=discard",
        "--description=Input facts",
        "--source",
        "docs/SPEC.md",
        "--source",
        "customer discussion",
      ],
      text + "stdin\n",
    );
    const written = parseFrontmatter(
      await fs.readFile(path.join(workspace, stdinNode.node.path), "utf8"),
    );
    assert.equal(written.body, text + "stdin\n");
    assert.equal(written.data.description, "Input facts");
    assert.deepEqual(written.data.sources, [
      { resource: "docs/SPEC.md" },
      { resource: "customer discussion" },
    ]);

    const savedCard = async (cardId: string) =>
      parseFrontmatter(
        await fs.readFile(path.join(workspace, ".tent/cards", `${cardId}.md`), "utf8"),
      );
    await success("role", "create", ["--id", "role-worker", "--title", "Worker"]);
    const card = await success("card", "create", [
      "--target=role-worker",
      "--prompt=discard",
      "--prompt=" + text,
      "--source",
      ".tent/--named-node/--named-node.md",
      "--source",
      "docs/SPEC.md",
    ]);
    const readCard = await savedCard(card.cardId);
    assert.equal(readCard.body, text);
    assert.deepEqual(readCard.data.sources, [
      { resource: "../--named-node/--named-node.md" },
      { resource: "docs/SPEC.md" },
    ]);
    const stdinCard = await success(
      "card",
      "create",
      ["--target", "role-worker", "--prompt", "-"],
      text,
    );
    assert.equal((await savedCard(stdinCard.cardId)).body, text);
    for (const [command, sub, args] of [
      ["node", "create", ["Rejected", "--type=prompt", "--body", "--retain-version"]],
      ["card", "create", ["--target=role-worker", "--prompt=valid", "--unknown"]],
    ] as const) {
      const rejected = await cli(command, sub, [...args]);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /argument|Unknown option/);
    }
    assert.equal(parseFrontmatter(await fs.readFile(filename, "utf8")).body, text);
  } finally {
    await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
  }
});
