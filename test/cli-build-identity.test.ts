import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";
import { readBuildIdentity, sourceBuildMismatch } from "../src/cli/build-identity.js";
import { testScratchRoot } from "./scratch.js";
import { runHookCommand } from "../src/cli/hook.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const contract = await import(pathToFileURL(path.join(repoRoot, "esbuild.config.mjs")).href);
const cli = (entry: string, args: string[]) =>
  run(process.execPath, [entry, ...args], { windowsHide: true, timeout: 10_000 });

test("CLI embeds its build identity; moved copies ignore adjacent package version", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "cli-build-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "cli.mjs");
  const [{ options }] = contract.rootBundleOptions(repoRoot);
  await esbuild.build({ ...options, outfile: entry, logLevel: "silent" });
  const json = JSON.parse((await cli(entry, ["version", "--json"])).stdout);
  assert.match(json.commit, /^[a-f0-9]{40}$/);
  assert.equal(
    json.version,
    JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")).version,
  );
  assert.ok(Number.isFinite(Date.parse(json.builtAt)));
  assert.equal(typeof json.dirty, "boolean");
  assert.equal(json.runtimePath, entry);
  assert.match((await cli(entry, ["--version"])).stdout, /Tent .*commit [a-f0-9]{12}; built/);
  const moved = path.join(root, "moved");
  await fs.mkdir(moved);
  const movedEntry = path.join(moved, "cli.mjs");
  await fs.rename(entry, movedEntry);
  await fs.writeFile(path.join(moved, "package.json"), JSON.stringify({ version: "999.0.0" }));
  const movedJson = JSON.parse((await cli(movedEntry, ["version", "--json"])).stdout);
  assert.deepEqual(movedJson, { ...json, runtimePath: movedEntry });
  const source = JSON.parse(
    (
      await run(process.execPath, ["--import", "tsx", "src/cli/tent.ts", "version", "--json"], {
        cwd: repoRoot,
        windowsHide: true,
        timeout: 10_000,
      })
    ).stdout,
  );
  assert.equal(source.builtAt, null);
  assert.equal(source.commit, json.commit);
  assert.equal(source.runtimePath, path.join(repoRoot, "src/cli/tent.ts"));
});

test("self-contained plugin runtime has embedded identity without source or package metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "plugin-build-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await contract.buildPluginRuntime(repoRoot, root);
  const identity = JSON.parse(
    (await cli(path.join(root, "cli.mjs"), ["version", "--json"])).stdout,
  );
  assert.match(identity.commit, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(identity.builtAt)));
  assert.equal(identity.runtimePath, path.join(root, "cli.mjs"));
});

test("source identity has no build time; mismatch is limited to Tent source checkouts", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "source-build-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src/cli"), { recursive: true });
  await fs.writeFile(path.join(root, "src/cli/tent.ts"), "source");
  await fs.writeFile(path.join(root, "esbuild.config.mjs"), "build");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "vibe-tent", version: "2.0.0" }),
  );
  // A nested source copy must not inherit the containing repository's identity.
  assert.deepEqual(await readBuildIdentity(root), {
    version: "2.0.0",
    commit: null,
    builtAt: null,
    dirty: null,
  });
  const git = (args: string[]) => run("git", ["-C", root, ...args], { windowsHide: true });
  await git(["init"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const identity = await readBuildIdentity(root);
  assert.equal(identity.builtAt, null);
  assert.equal(identity.dirty, false);
  assert.equal(await sourceBuildMismatch(root, identity), undefined);
  const inheritedGitDir = (
    await run("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"], { windowsHide: true })
  ).stdout.trim();
  const probe = `
    import { readBuildIdentity, sourceBuildMismatch } from ${JSON.stringify(new URL("../src/cli/build-identity.ts", import.meta.url).href)};
    import { buildIdentity } from ${JSON.stringify(new URL("../scripts/build-identity.mjs", import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    console.log(JSON.stringify({
      source: await readBuildIdentity(root),
      built: buildIdentity(root),
      mismatch: await sourceBuildMismatch(root, ${JSON.stringify(identity)}) ?? null,
    }));
  `;
  const polluted = JSON.parse(
    (
      await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
        cwd: repoRoot,
        windowsHide: true,
        env: { ...process.env, GIT_DIR: inheritedGitDir, GIT_WORK_TREE: repoRoot },
      })
    ).stdout,
  );
  assert.deepEqual(polluted.source, identity);
  assert.deepEqual({ ...polluted.built, builtAt: null }, identity);
  assert.equal(polluted.mismatch, null);
  await fs.writeFile(path.join(root, "src/cli/tent.ts"), "updated source");
  assert.equal((await readBuildIdentity(root)).dirty, true);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "next fixture",
  ]);
  assert.match(
    (await sourceBuildMismatch(root, identity))!,
    /runtime build differs.*runtime [a-f0-9]{12}, source [a-f0-9]{12}/,
  );
  await scaffoldInWorkspace(new NodeFs(root), { name: "identity" });
  const start = await runHookCommand("start", ["--host", "codex"], {
    packageRoot: repoRoot,
    stdin: JSON.stringify({ hook_event_name: "SessionStart", cwd: root }),
  });
  const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Build: Tent .*; source/);
  assert.match(context, /runtime build differs from Workspace source/);
  assert.ok(Buffer.byteLength(context) < 2048);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "unrelated-project", version: "2.0.0" }),
  );
  assert.equal(await sourceBuildMismatch(root, identity), undefined);
});
