#!/usr/bin/env node
// Tent CLI parses commands; document semantics and locking belong to Core.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NodeFs } from "../fs/node-fs.js";

import { workspaceRootFromSystemRoot } from "../core/paths.js";
import { cardHelpText, runCardCommand } from "./card-commands.js";
import { runNodeCommand, nodeHelpText } from "./node-commands.js";
import { runRoleCommand, roleHelpText } from "./role-commands.js";
import { runWorkspaceCommand, workspaceHelpText } from "./workspace-commands.js";
import { runHookCommand } from "./hook.js";
import { runUiCommand } from "./ui-command.js";
import { startUiServer } from "../ui-server/server.js";
import { readBuildIdentity, formatBuildIdentity } from "./build-identity.js";

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
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
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
    const { positionals } = parseArgs({ args, allowPositionals: true });
    if (positionals.length !== 1) return fail("Usage: tent new <workspace-path>");
    await newTent(positionals[0]);
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

  return fail(`Unknown command: ${cmd}\nCommands: new node card role workspace ui hook`);
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
  return `Tent CLI

Run from a Workspace containing .tent/, or select one with --workspace.

  tent new <workspace-path>           Create empty .tent and independent local Git.
  tent node list|get|create|write|…    Find, read and maintain Node documents.
  tent role list|show|write|create     Optional persistent Role context.
  tent card create|publish|list|get|take|interrupt|continue
                                     Recorded inputs and optional Role reception.
  tent workspace export --output <dir>  Export the context graph and its Git history.
  tent workspace check --json        Inspect links and material addresses without edits.
  tent ui [--workspace <path>] [--port <n>] [--no-open]
                                     Open the local Web UI; Ctrl+C closes its server.
  tent hook start|stop --host codex   Native dynamic entry and mechanical advice.

Use tent node|role|card|workspace --help for command details.
All document commands call Core directly; no background Service is started.
  -h, --help                         Show this help.
  -v, --version                      Show version, commit and build time.
  tent version --json                Show build identity and runtime path as JSON.
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
