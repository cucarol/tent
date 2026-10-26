#!/usr/bin/env node
// Tent CLI parses commands; document semantics and locking belong to Core.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";

import { workspaceRootFromSystemRoot } from "../core/base/paths.js";
import { cardHelpText, runCardCommand } from "./card-commands.js";
import { runNodeCommand, nodeHelpText } from "./node-commands.js";
import { runRoleCommand, roleHelpText } from "./role-commands.js";
import { runWorkspaceCommand, workspaceHelpText } from "./workspace-commands.js";
import { runHookCommand } from "./hook.js";
import { runUiCommand } from "./ui-command.js";
import { startUiServer } from "../ui-server/server.js";
import { readBuildIdentity, formatBuildIdentity } from "./build-identity.js";
import { cliErrorText, unknownCommandError } from "./error-text.js";

export function isInWorkspaceSystemRoot(systemRoot: string): boolean {
  return workspaceRootFromSystemRoot(systemRoot) !== undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText());
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        workspace: { type: "string" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: tent version [--json] [--workspace <path>]\nShow the local build identity and runtime path.",
      );
      return;
    }
    const identity = await readBuildIdentity(packageRoot());
    console.log(
      values.json
        ? JSON.stringify({ ...identity, runtimePath: fileURLToPath(import.meta.url) })
        : formatBuildIdentity(identity),
    );
    return;
  }

  const commandHelp = new Map([
    ["node", nodeHelpText],
    ["role", roleHelpText],
    ["card", cardHelpText],
    ["workspace", () => workspaceHelpText],
  ]).get(cmd);
  if (commandHelp && (!args[0] || ["help", "--help", "-h"].includes(args[0]))) {
    console.log(commandHelp());
    return;
  }

  // Commands that do not require an existing system root
  if (cmd === "hook") {
    const [sub, ...rest] = args;
    const result = await runHookCommand(sub ?? "help", rest, { packageRoot: packageRoot() });
    process.stdout.write(result.stdout);
    return;
  }
  if (cmd === "new") {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" }, workspace: { type: "string" } },
    });
    if (values.help) {
      console.log(
        "Usage: tent new <workspace-path> | tent new --workspace <workspace-path>\nCreate an empty .tent and independent local Git.",
      );
      return;
    }
    const target = values.workspace ?? positionals[0];
    if (positionals.length > 1 || !target)
      return fail("Usage: tent new <workspace-path> | tent new --workspace <workspace-path>");
    if (
      positionals[0] !== undefined &&
      values.workspace !== undefined &&
      path.relative(path.resolve(positionals[0]), path.resolve(values.workspace)) !== ""
    )
      return fail("The workspace path and --workspace must name the same directory.");
    await newTent(target);
    return;
  }
  if (cmd === "ui") {
    await runUiCommand(args, { packageRoot: packageRoot(), startServer: startUiServer });
    return;
  }
  if (cmd === "card") {
    const [sub, ...rest] = args;
    const result = await runCardCommand(sub, rest);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (cmd === "workspace") {
    const [sub, ...rest] = args;
    const result = await runWorkspaceCommand(sub ?? "help", rest);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  // Persistent Role context; selection is explicit.
  if (cmd === "role") {
    const [sub, ...rest] = args;
    const result = await runRoleCommand(sub, rest);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // Direct Core Node reads and mutations.
  if (cmd === "node") {
    const [sub, ...rest] = args;
    const result = await runNodeCommand(sub, rest);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  return fail(
    cliErrorText(
      unknownCommandError("tent", cmd, ["new", "node", "card", "role", "workspace", "ui", "hook"]),
      "tent",
    ),
  );
}

function fail(msg: string) {
  console.error(msg);
  process.exitCode = 1;
}

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(here) === "cli" && path.basename(path.dirname(here)) === "src") {
    return path.resolve(here, "../..");
  }
  return here;
}

function helpText(): string {
  return `Tent keeps a context graph of your project in .tent/, next to the code.

Run it inside a Workspace, or name one with --workspace <path>.

Start
  tent new <path>                    Create an empty Tent in <path>/.tent with its own Git history; --workspace <path> also selects the new root.
  tent ui [--port <n>] [--no-open]   Open the map in the browser; Ctrl+C stops it.

Read and record
  tent workspace brief               Where to start: what changed and which Cards wait.
  tent node get|list|search          Read Nodes.
  tent node create|append|write|confirm
                                     Record facts and keep them current.
  tent workspace check               Broken links and missing materials.
  tent workspace drift               Every Node that is ahead or behind.

Hand off work
  tent card create|take|return|watch Send work to a Role and collect the result.
  tent role list|show|create         Long-running work directions that receive Cards.

More
  tent workspace scan|check-modules|export
  tent hook start|stop --host codex|claude-code
                                     Called by the host's hooks, not by hand.
  tent <node|card|role|workspace> --help
                                     Every command and option in that group.
  tent --version                     Version, commit and build time; tent version --json adds the runtime path.
`;
}

/**
 * 建一顶新帐：in-workspace 布局 `<target>/.tent/`。
 * `target` is the workspace root. Existing project files remain untouched.
 */
async function newTent(target: string): Promise<void> {
  const { initializeTentWorkspace } = await import("../fs/workspace-init.js");
  const workspaceRoot = path.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${workspaceRoot}`);

  await initializeTentWorkspace(workspaceRoot);

  console.log(
    `✓ Created Tent: ${path.join(workspaceRoot, ".tent")}\n` +
      `In-workspace layout: collaboration facts live under <workspace>/.tent/.\n` +
      `Independent local Git history is initialized in .tent/.git. The Node tree starts empty.`,
  );
}

// Only auto-run when this file is the process entry (not when imported by tests).
// Resolve through realpath so Windows junctions / global-style symlink entries still match.
// Async IIFE (not top-level await): esbuild CLI target is es2021.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = path.resolve(fileURLToPath(import.meta.url));
const normalizeEntryPath = (value: string) =>
  process.platform === "win32" ? value.toLowerCase() : value;

void (async () => {
  if (!entry) return;
  const realEntry = await fs.realpath(entry).catch(() => entry);
  const realThisFile = await fs.realpath(thisFile).catch(() => thisFile);
  const isDirectEntry =
    normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile) ||
    normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile.replace(/\.ts$/i, ".js"));
  if (!isDirectEntry) return;
  await main();
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
