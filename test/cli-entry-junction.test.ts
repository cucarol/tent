/**
 * Regression: Windows junction / symlink-style CLI entry must autorun main,
 * while importing the module must not auto-run or double-run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { testScratchRoot } from "./scratch.js";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliBundle = path.join(repoRoot, "cli.mjs");

interface RunExitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runWithExit(command: string, args: string[], cwd: string): Promise<RunExitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
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

async function tryLinkEntry(tmp: string): Promise<string | null> {
  const linkRoot = path.join(tmp, "entry-link");
  try {
    if (process.platform === "win32") {
      // Directory junction: global-style path prefix without requiring SeCreateSymbolicLink.
      await fs.symlink(repoRoot, linkRoot, "junction");
    } else {
      await fs.symlink(repoRoot, linkRoot, "dir");
    }
    return path.join(linkRoot, "cli.mjs");
  } catch (error) {
    try {
      // File symlink fallback (Unix / Windows Developer Mode).
      const fileLink = path.join(tmp, "cli-link.mjs");
      await fs.symlink(cliBundle, fileLink, process.platform === "win32" ? "file" : undefined);
      return fileLink;
    } catch {
      void error;
      return null;
    }
  }
}

test("CLI junction/symlink entry autoruns; import does not", async (t) => {
  assert.equal(
    await fs.access(cliBundle).then(
      () => true,
      () => false,
    ),
    true,
    "cli.mjs must exist (run build)",
  );

  const tmp = await fs.mkdtemp(path.join(testScratchRoot(), "tent-cli-entry-"));
  t.after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const linkedEntry = await tryLinkEntry(tmp);
  if (!linkedEntry) {
    t.skip("junction/symlink entry paths are unsupported on this host");
    return;
  }

  // Linked argv path must differ from the real bundle path (otherwise the smoke is vacuous).
  const resolvedLink = path.resolve(linkedEntry);
  const resolvedBundle = path.resolve(cliBundle);
  assert.notEqual(
    process.platform === "win32" ? resolvedLink.toLowerCase() : resolvedLink,
    process.platform === "win32" ? resolvedBundle.toLowerCase() : resolvedBundle,
    "test entry should be a distinct junction/symlink path",
  );

  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };

  const invoked = await runWithExit(process.execPath, [linkedEntry, "--version"], repoRoot);
  assert.equal(invoked.code, 0, `junction entry should run main:\n${invoked.stderr}`);
  assert.ok(invoked.stdout.startsWith(`Tent ${pkg.version} (commit `));
  assert.match(invoked.stdout, /; built \d{4}-/);
  assert.equal(invoked.stderr, "");

  // Mixed-case argv on Windows still matches after realpath + case-fold.
  if (process.platform === "win32") {
    const mixed = linkedEntry.replace(/^[a-zA-Z]:/, (drive) =>
      drive.toUpperCase() === drive ? drive.toLowerCase() : drive.toUpperCase(),
    );
    if (mixed !== linkedEntry) {
      const cased = await runWithExit(process.execPath, [mixed, "-v"], repoRoot);
      assert.equal(cased.code, 0, `case-folded junction entry should run:\n${cased.stderr}`);
      assert.equal(cased.stdout, invoked.stdout);
    }
  }

  const probe = path.join(tmp, "import-probe.mjs");
  await fs.writeFile(
    probe,
    [
      `import * as cli from ${JSON.stringify(pathToFileURL(cliBundle).href)};`,
      `if (typeof cli.isInWorkspaceSystemRoot !== "function") {`,
      `  console.error("missing export");`,
      `  process.exit(2);`,
      `}`,
      `console.log("IMPORT_OK");`,
    ].join("\n"),
    "utf8",
  );

  const imported = await runWithExit(process.execPath, [probe], repoRoot);
  assert.equal(imported.code, 0, `import probe failed:\n${imported.stderr}`);
  assert.match(imported.stdout, /^IMPORT_OK$/m);
  assert.doesNotMatch(imported.stdout, /Usage:|Tent CLI|^\d+\.\d+/m);
  assert.equal(imported.stderr, "");
});
