import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidTentIndexMarker } from "../src/core/scaffold.js";
import { listBundledSkillNames } from "./fixtures/bundled-skills.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliSource = path.join(repoRoot, "src", "cli", "tent.ts");
const tsxImport = import.meta.resolve("tsx");
const scratchRoot = path.join(repoRoot, ".scratch");
const temporaryRoots: string[] = [];
async function temporaryDirectory(prefix: string): Promise<string> {
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(scratchRoot, prefix)));
  temporaryRoots.push(root);
  return root;
}
after(async () => {
  for (const root of temporaryRoots) {
    assert.equal(path.dirname(root), await fs.realpath(scratchRoot));
    await fs.rm(root, { recursive: true, force: true });
  }
});
const gitIdentity = {
  GIT_AUTHOR_NAME: "The Tent Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "The Tent Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  envExtra: Record<string, string> = {},
  timeoutMs?: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        TENT_SERVICE_DATA_DIR: path.join(scratchRoot, "package-no-service"),
        ...gitIdentity,
        ...envExtra,
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout =
      timeoutMs == null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (timeout != null) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout != null) clearTimeout(timeout);
      resolve({
        code,
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out after ${timeoutMs}ms.` : stderr,
        timedOut,
      });
    });
  });
}

async function runOk(
  command: string,
  args: string[],
  cwd: string,
  envExtra: Record<string, string> = {},
): Promise<RunResult> {
  const result = await run(command, args, cwd, envExtra);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runCli(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

async function runCliOk(cwd: string, ...args: string[]): Promise<RunResult> {
  return runOk(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

test("tent new adopts an existing project without touching project files", async () => {
  const workspace = await temporaryDirectory("tent-adopt-");
  const readme = path.join(workspace, "README.md");
  const agents = path.join(workspace, "AGENTS.md");
  await fs.writeFile(readme, "# Existing project\n", "utf8");
  await fs.writeFile(agents, "# Existing rules\n", "utf8");

  await runCliOk(workspace, "new", ".");

  assert.equal(await fs.readFile(readme, "utf8"), "# Existing project\n");
  assert.equal(await fs.readFile(agents, "utf8"), "# Existing rules\n");
  assert.equal(
    isValidTentIndexMarker(await fs.readFile(path.join(workspace, ".tent", "index.md"), "utf8")),
    true,
  );
  assert.equal(await exists(path.join(workspace, ".tent", "types.json")), false);
  assert.equal(await exists(path.join(workspace, ".tent", "temp")), true);
  assert.equal(await exists(path.join(workspace, ".git")), false);
  assert.match(await fs.readFile(path.join(workspace, ".gitignore"), "utf8"), /\.tent\//);

  const repeated = await runCli(workspace, "new", ".");
  assert.notEqual(repeated.code, 0);
  assert.match(repeated.stderr, /already a Tent/);
});

test("removed legacy and migration commands are not part of the CLI", async () => {
  const removed = [
    "migrate",
    "import",
    "dispatch",
    "task-ack",
    "task-cancel",
    "new-box",
    "tag",
    "untag",
    "tag-new",
    "tag-rm",
    "fork",
    "clean-temp",
    "okf-sync",
    "session",
    "context",
    "tools",
    "agent-hooks",
    "migration",
    "user",
  ];
  for (const command of removed) {
    const result = await runCli(repoRoot, command);
    assert.notEqual(result.code, 0, `${command} must not remain callable`);
    assert.match(result.stderr, new RegExp(`Unknown command: ${command}`));
  }
});

test("retired skill-install command cannot change a user skill directory", async () => {
  const target = await temporaryDirectory("tent-retired-skill-install-");
  const userSkill = path.join(target, "tent-card", "SKILL.md");
  await fs.mkdir(path.dirname(userSkill), { recursive: true });
  await fs.writeFile(userSkill, "# user skill\n");
  const result = await runCli(repoRoot, "skill-install", "--dir", target, "--force");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown command: skill-install/);
  assert.equal(await fs.readFile(userSkill, "utf8"), "# user skill\n");
});

test("CLI help and version expose only the current surface", async () => {
  const help = await runCliOk(repoRoot, "--help");
  assert.match(help.stdout, /tent node/);
  assert.match(help.stdout, /new <workspace-path>/);
  assert.match(help.stdout, /independent local Git/);
  assert.doesNotMatch(help.stdout, /--repair-existing/);
  assert.doesNotMatch(help.stdout, /init-map|approved-digest/);
  assert.doesNotMatch(help.stdout, /skill-install/);
  assert.doesNotMatch(help.stdout, /tent migrate\b|new-box|task-ack|clean-temp|--vault/);

  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(
    (await runCliOk(repoRoot, "--version")).stdout.startsWith(`Tent ${pkg.version} (commit `),
  );
  assert.equal(
    (await runCliOk(repoRoot, "-v")).stdout,
    (await runCliOk(repoRoot, "--version")).stdout,
  );
});

test("packed npm runtime installs current dependencies and only the direct CLI", async (t) => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    t.skip("package smoke runs under npm test");
    return;
  }
  const sourcePackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const expectedDependencies = {
    "mdast-util-from-markdown": "^2.0.3",
    yaml: "2.9.0",
    zod: "4.5.4",
  };
  assert.deepEqual(sourcePackage.dependencies ?? {}, expectedDependencies);
  const packDir = await temporaryDirectory("tent-pack-");
  for (const file of ["snapshot.json", "pack-probe.map"]) {
    const probe = path.join(repoRoot, "ui-dist", file);
    try {
      await fs.writeFile(probe, "Private development data must not ship", { flag: "wx" });
      t.after(() => fs.unlink(probe));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const packed = await runOk(
    process.execPath,
    [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--dry-run=false",
      "--json",
      "--pack-destination",
      packDir,
    ],
    repoRoot,
  );
  const packageInfo = JSON.parse(packed.stdout)[0];
  const packedPaths = packageInfo.files.map((entry: { path: string }) => entry.path);
  assert.ok(packedPaths.includes("cli.mjs"));
  for (const file of ["index.html", "app.js", "app.css", "favicon.svg", "THIRD_PARTY_NOTICES.txt"])
    assert.ok(packedPaths.includes(`ui-dist/${file}`), `UI asset is packed: ${file}`);
  assert.ok(packedPaths.some((file: string) => file.startsWith("ui-dist/fonts/Xiaolai/")));
  assert.equal(packedPaths.includes("ui-dist/snapshot.json"), false);
  assert.equal(
    packedPaths.some((file: string) => file.startsWith("ui-dist/") && file.endsWith(".map")),
    false,
  );
  assert.equal(packedPaths.includes("service.mjs"), false);
  assert.equal(packedPaths.includes("mcp.mjs"), false);
  assert.ok(packedPaths.includes("THIRD_PARTY_NOTICES.md"));
  assert.equal(
    packedPaths.includes("third_party/licenses/eventsource-parser-4.1.1-LICENSE"),
    false,
  );
  assert.equal(
    packedPaths.includes("third_party/licenses/agentclientprotocol-sdk-1.4.0-LICENSE"),
    false,
  );
  for (const license of [
    "react-aria-components-1.21.0-LICENSE",
    "libavoid-js-0.4.5-LICENSE",
    "excalidraw-0.18.1-LICENSE",
  ]) {
    assert.ok(
      !packedPaths.includes(`third_party/licenses/${license}`),
      `npm package excludes archived Desktop license ${license}`,
    );
  }
  for (const skill of ["tent-init", "tent-node", "tent-role", "tent-card"])
    assert.ok(packedPaths.includes(`skills/${skill}/SKILL.md`));
  assert.equal(
    packedPaths.some((entry: string) => /tent-init\/vendor\//.test(entry)),
    false,
  );
  assert.ok(packedPaths.includes("skill-resources/scripts/tent.mjs"));
  assert.ok(packedPaths.includes("skill-resources/references/input.md"));
  assert.equal(
    packedPaths.some((entry: string) => /^(desktop|src|test|node_modules)\//.test(entry)),
    false,
    "public tarball must not contain Desktop/editor or development trees",
  );
  const tarball = path.join(packDir, packageInfo.filename);
  const parent = await temporaryDirectory("tent-package-");
  const prefix = path.join(parent, "install");
  const workspace = path.join(parent, "workspace");
  const npmLogs = path.join(parent, "npm-logs");

  try {
    await fs.mkdir(prefix, { recursive: true });
    await fs.mkdir(npmLogs, { recursive: true });
    const install = await run(
      process.execPath,
      [npmCli, "install", "--ignore-scripts", "--dry-run=false", "--prefix", prefix, tarball],
      repoRoot,
      { npm_config_logs_dir: npmLogs },
      180_000,
    );
    const npmDebugLogs = install.code === 0 ? "" : await readNpmDebugLogs(npmLogs);
    assert.equal(
      install.code,
      0,
      `ordinary bounded npm install failed${install.timedOut ? " (timed out)" : ""}\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}\nnpm debug logs:\n${npmDebugLogs}`,
    );
    const installed = path.join(prefix, "node_modules", packageInfo.name);
    const cli = path.join(installed, "cli.mjs");
    const installedPackage = JSON.parse(
      await fs.readFile(path.join(installed, "package.json"), "utf8"),
    );
    assert.deepEqual(installedPackage.dependencies ?? {}, expectedDependencies);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "# keep\n", "utf8");
    await runOk(process.execPath, [cli, "new", "."], workspace);
    assert.equal(await fs.readFile(path.join(workspace, "README.md"), "utf8"), "# keep\n");
    assert.equal(await exists(path.join(workspace, ".tent", "index.md")), true);
    const help = await runOk(process.execPath, [cli, "--help"], workspace);
    assert.match(help.stdout, /tent node/);
    assert.match(
      (await runOk(process.execPath, [cli, "ui", "--help"], workspace)).stdout,
      /foreground/,
    );
    assert.doesNotMatch(help.stdout, /new-box|tent migrate\b|--vault/);
    assert.equal(await exists(path.join(installed, "service.mjs")), false);
    assert.deepEqual(installedPackage.bin, { tent: "./cli.mjs" });
    const bundledSkills = await listBundledSkillNames(repoRoot);
    assert.ok(bundledSkills.length > 0);
    for (const name of bundledSkills) {
      assert.equal(await exists(path.join(installed, "skills", name, "SKILL.md")), true);
    }
    const skillsRoot = path.join(repoRoot, "skills");
    for (const entry of await fs.readdir(skillsRoot, { recursive: true })) {
      if (!(await fs.stat(path.join(skillsRoot, entry))).isFile()) continue;
      const relative = entry.replaceAll("\\", "/");
      assert.ok(
        packedPaths.includes(`skills/${relative}`),
        `missing packed skill resource: ${relative}`,
      );
      assert.deepEqual(
        await fs.readFile(path.join(installed, "skills", entry)),
        await fs.readFile(path.join(skillsRoot, entry)),
      );
    }
    assert.equal(await exists(path.join(installed, "LICENSE")), true);
    assert.equal(await exists(path.join(installed, "docs", "SPEC.md")), true);
  } finally {
    assert.equal(path.dirname(parent), await fs.realpath(scratchRoot));
    assert.equal(path.dirname(packDir), await fs.realpath(scratchRoot));
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(packDir, { recursive: true, force: true });
  }
});

async function readNpmDebugLogs(root: string): Promise<string> {
  try {
    const entries = (await fs.readdir(root)).filter((entry) => entry.endsWith(".log"));
    const candidates = await Promise.all(
      entries.map(async (entry) => ({ entry, stat: await fs.stat(path.join(root, entry)) })),
    );
    candidates.sort(
      (left, right) =>
        right.stat.mtimeMs - left.stat.mtimeMs || left.entry.localeCompare(right.entry),
    );

    let remainingBytes = 64 * 1024;
    const logs: string[] = [];
    for (const { entry, stat } of candidates.slice(0, 3)) {
      if (remainingBytes === 0) break;
      const bytesToRead = Math.min(stat.size, remainingBytes);
      const buffer = Buffer.alloc(bytesToRead);
      const handle = await fs.open(path.join(root, entry), "r");
      let bytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(
          buffer,
          0,
          bytesToRead,
          Math.max(0, stat.size - bytesToRead),
        ));
      } finally {
        await handle.close();
      }
      remainingBytes -= bytesRead;
      const truncated = stat.size > bytesRead ? ` (tail ${bytesRead}/${stat.size} bytes)` : "";
      logs.push(`--- ${entry}${truncated} ---\n${buffer.subarray(0, bytesRead).toString("utf8")}`);
    }
    return logs.join("\n") || "<none>";
  } catch {
    return "<unavailable>";
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
