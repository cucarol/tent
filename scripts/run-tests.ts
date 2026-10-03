#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INTEGRATION_TEST_FILES = Object.freeze([
  "test/card-document.test.ts",
  "test/cli-agent-hooks-help.test.ts",
  "test/cli-agent-role-routing.test.ts",
  "test/cli-build-identity.test.ts",
  "test/cli-card.test.ts",
  "test/cli-context-reader.test.ts",
  "test/cli-decomposition-workflow.test.ts",
  "test/cli-entry-junction.test.ts",
  "test/cli-native-options.test.ts",
  "test/cli-new.test.ts",
  "test/cli-node-commands.test.ts",
  "test/cli-parse-args.test.ts",
  "test/cli-reader-process.test.ts",
  "test/cli-workflow.test.ts",
  "test/cli-workspace-tools.test.ts",
  "test/cli-ui.test.ts",
  "test/core-document-history.test.ts",
  "test/core-workspace-ui.test.ts",
  "test/direct-workspace-export.test.ts",
  "test/docs-move.test.ts",
  "test/file-lock-concurrency.test.ts",
  "test/git-history.test.ts",
  "test/history-operations.test.ts",
  "test/node-batch.test.ts",
  "test/node-discovery.test.ts",
  "test/node-move-recovery.test.ts",
  "test/node-status.test.ts",
  "test/open-source.test.ts",
  "test/package.test.ts",
  "test/plugin-package.test.ts",
  "test/role-card-review.test.ts",
  "test/role-context.test.ts",
  "test/root-build-canonical.test.ts",
  "test/ui-server.test.ts",
  "test/workspace-init.test.ts",
] as const);

type TestMode = "full" | "fast" | "integration";

const MODES = new Set<TestMode>(["full", "fast", "integration"]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function discoverTestFiles(root: string): string[] {
  const testRoot = path.join(root, "test");
  if (!fs.existsSync(testRoot)) throw new Error(`test directory not found: ${testRoot}`);

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "fixtures" || entry.name === "node_modules") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        const file = path.relative(root, absolute).split(path.sep).join("/");
        files.push(file);
      }
    }
  };
  visit(testRoot);
  return files.sort();
}

export function selectTestFiles(
  allFiles: string[],
  mode: string,
  integrationFiles: readonly string[] = INTEGRATION_TEST_FILES,
): string[] {
  if (!MODES.has(mode as TestMode)) throw new Error(`unknown test mode: ${mode}`);

  const all = new Set(allFiles);
  const integration = new Set(integrationFiles);
  if (integration.size !== integrationFiles.length) {
    throw new Error("integration test list contains duplicates");
  }
  for (const file of integration) {
    if (!all.has(file)) throw new Error(`integration test is missing: ${file}`);
  }

  if (mode === "full") return [...allFiles];
  if (mode === "integration") return allFiles.filter((file) => integration.has(file));
  return allFiles.filter((file) => !integration.has(file));
}

export function sanitizeTestEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  if (env.FORCE_COLOR != null && env.NO_COLOR != null) delete env.FORCE_COLOR;
  return env;
}

function parseArgs(args: string[]): { mode: TestMode; listOnly: boolean } {
  const listOnly = args.includes("--list");
  const positional = args.filter((arg) => arg !== "--list");
  if (positional.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--list")) {
    throw new Error("usage: run-tests.mjs [full|fast|integration] [--list]");
  }
  const mode = positional[0] ?? "full";
  if (!MODES.has(mode as TestMode)) throw new Error(`unknown test mode: ${mode}`);
  return { mode: mode as TestMode, listOnly };
}

function main() {
  try {
    const { mode, listOnly } = parseArgs(process.argv.slice(2));
    const files = selectTestFiles(discoverTestFiles(repoRoot), mode);
    if (listOnly) {
      process.stdout.write(`${files.join("\n")}\n`);
      return;
    }
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-concurrency=4", "--import", "tsx", ...files],
      {
        cwd: repoRoot,
        env: sanitizeTestEnv(process.env),
        stdio: "inherit",
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
