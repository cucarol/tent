import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

test("开源可移植性:发布源文件不含开发者机器绝对路径", async () => {
  const tracked = gitTrackedFiles();
  for (const retiredRoot of [".tent/", "output/"]) {
    assert.equal(
      tracked.some((entry) => entry === retiredRoot.slice(0, -1) || entry.startsWith(retiredRoot)),
      false,
      `${retiredRoot} is machine-local output and must not be Git-tracked`,
    );
  }

  const localRoots = [repoRoot, os.homedir()].flatMap((entry) => [
    entry,
    entry.replaceAll("\\", "/"),
  ]);
  const forbidden = [
    ...localRoots.map((entry) => new RegExp(escapeRegExp(entry), "i")),
    new RegExp(`C:[\\\\/]+${"cuca" + "rol"}[\\\\/]+_code[\\\\/]+Tent`, "i"),
  ];
  for (const entry of tracked) {
    const file = path.join(repoRoot, entry);
    if (!(await exists(file))) continue;
    const buffer = await fs.readFile(file);
    if (buffer.includes(0)) continue;
    const raw = buffer.toString("utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(raw, pattern, `${entry} 包含本机绑定路径`);
    }
  }

  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "manifest.json"), "utf8"));
  const releaseWorkflow = await fs.readFile(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const readmeZh = await fs.readFile(path.join(repoRoot, "README.zh-CN.md"), "utf8");
  const spec = await fs.readFile(path.join(repoRoot, "docs", "SPEC.md"), "utf8");
  await fs.readFile(path.join(repoRoot, "skills", "tent-init", "SKILL.md"), "utf8");
  const nodeMaintenance = await fs.readFile(
    path.join(repoRoot, "skill-resources", "references", "node-maintenance.md"),
    "utf8",
  );
  const recipients = await fs.readFile(
    path.join(repoRoot, "skill-resources", "references", "roles.md"),
    "utf8",
  );
  const inputSkill = await fs.readFile(
    path.join(repoRoot, "skills", "tent-node", "SKILL.md"),
    "utf8",
  );
  assert.equal(pkg.bin.tent, "./cli.mjs");
  assert.equal(pkg.bin["tent-service"], undefined);
  assert.equal(pkg.bin["tent-mcp"], undefined);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, "cucarol");
  assert.equal(pkg.author, manifest.author);
  assert.equal(pkg.version, "0.1.1");
  assert.equal(manifest.name, "Tent");
  assert.equal(
    manifest.minAppVersion,
    undefined,
    "release manifest has no Obsidian compatibility axis",
  );
  assert.equal(manifest.isDesktopOnly, undefined, "release manifest has no Obsidian plugin flag");
  assert.equal(pkg.repository.url, "git+https://github.com/cucarol/tent.git");
  assert.equal(pkg.bugs.url, "https://github.com/cucarol/tent/issues");
  assert.equal(pkg.homepage, "https://github.com/cucarol/tent#readme");
  assert.equal(pkg.version, manifest.version, "npm package version matches release manifest");
  assert.match(pkg.description, /^[\x20-\x7E]+\.$/, "npm description 使用完整英文句子");
  for (const keyword of ["cli", "okf", "coding-agents"]) {
    assert.ok(pkg.keywords.includes(keyword), `npm keywords 包含 ${keyword}`);
  }
  assert.equal(pkg.keywords.includes("obsidian"), false, "Obsidian plugin keywords are retired");
  assert.equal(
    pkg.keywords.includes("obsidian-plugin"),
    false,
    "Obsidian plugin keywords are retired",
  );
  assert.equal(pkg.devDependencies?.obsidian, undefined, "obsidian devDependency is retired");
  assert.equal(pkg.scripts?.["build:plugin"], undefined, "build:plugin script is retired");
  assert.equal(pkg.files.includes("main.js"), false, "npm package no longer ships plugin main.js");
  assert.equal(
    await exists(path.join(repoRoot, "main.js")),
    false,
    "retired root plugin bundle is deleted",
  );
  assert.equal(
    pkg.files.includes("styles.css"),
    false,
    "npm package no longer ships plugin styles.css",
  );
  assert.equal(
    pkg.files.includes("versions.json"),
    false,
    "npm package no longer ships Obsidian versions.json",
  );
  assert.match(releaseWorkflow, /npm pack --ignore-scripts/);
  assert.doesNotMatch(releaseWorkflow, /npm run desktop:package|release\/\*-portable\.exe/);
  assert.doesNotMatch(releaseWorkflow, /styles\.css|versions\.json/);
  assert.equal(
    await exists(path.join(repoRoot, "src", "plugin")),
    false,
    "src/plugin production source is retired",
  );
  assert.equal(
    await exists(path.join(repoRoot, "versions.json")),
    false,
    "versions.json is retired",
  );
  assert.equal(
    await exists(path.join(repoRoot, "test", "plugin.test.ts")),
    false,
    "plugin-only tests are retired",
  );
  assert.ok(pkg.files.includes("skills/"), "npm 发布包包含 bundled skills/");
  assert.ok(pkg.files.includes("cli.mjs"), "npm 发布包包含 CLI bundle");
  assert.equal(pkg.files.includes("service.mjs"), false, "Service bundle is retired");
  assert.equal(pkg.files.includes("mcp.mjs"), false, "npm 发布包不包含 Tent MCP bundle");
  assert.equal(await exists(path.join(repoRoot, "LICENSE")), true);
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-agent", "SKILL.md")), false);
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-task", "SKILL.md")), false);
  const skillDirectories = (
    await fs.readdir(path.join(repoRoot, "skills"), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory());
  const skillEntrypoints = await Promise.all(
    skillDirectories.map(async (entry) =>
      (await exists(path.join(repoRoot, "skills", entry.name, "SKILL.md")))
        ? entry.name
        : undefined,
    ),
  );
  assert.deepEqual(skillEntrypoints.filter((name) => name !== undefined).sort(), [
    "tent-card",
    "tent-init",
    "tent-node",
    "tent-role",
  ]);
  assert.equal(
    await exists(path.join(repoRoot, "skill-resources", "references", "node-maintenance.md")),
    true,
  );
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-init", "vendor")), false);
  assert.equal(await exists(path.join(repoRoot, "src", "tent-init-map")), false);
  assert.equal(await exists(path.join(repoRoot, "skills", "tent-genesis", "SKILL.md")), false);
  assert.equal(await exists(path.join(repoRoot, "src", "service", "provider-catalog.ts")), false);
  for (const retiredProvider of ["grok", "codex", "claude", "opencode", "copilot", "pi"]) {
    assert.equal(
      await exists(path.join(repoRoot, "src", "adapters", `${retiredProvider}-acp`)),
      false,
      `${retiredProvider}-acp provider source is retired`,
    );
  }
  assert.equal(await exists(path.join(repoRoot, "src", "adapters", "acp", "index.ts")), false);
  assert.equal(
    await exists(path.join(repoRoot, "src", "service", "tool-approval-store.ts")),
    false,
  );
  for (const retiredTest of [
    "acp-assistant-report.test.ts",
    "acp-auth-methods.test.ts",
    "grok-acp-adapter.test.ts",
    "grok-acp-live.e2e.ts",
    "mainstream-acp-adapters.test.ts",
    "mainstream-acp-cli-live.e2e.ts",
  ]) {
    assert.equal(
      await exists(path.join(repoRoot, "test", retiredTest)),
      false,
      `${retiredTest} is retired`,
    );
  }
  assert.equal(pkg.scripts?.["test:grok-e2e"], undefined);
  assert.equal(pkg.scripts?.["test:foreground-e2e"], undefined);
  // Both languages carry the same install path and Node type rule.
  for (const text of [readme, readmeZh]) {
    assert.match(text, /npm run plugin:build/);
    assert.match(text, /release\/plugins\/tent/);
    assert.match(text, /codex plugin add tent@tent-local/);
    assert.match(text, /`primary\[-secondary\]`/);
  }
  assert.ok(pkg.files.includes("README.zh-CN.md"), "npm package carries the linked Chinese README");
  assert.match(spec, /three semantic concepts are Node, Role, and Card/i);
  assert.match(spec, /Retired commands and wire fields are removed rather than kept as aliases/);
  assert.doesNotMatch(spec, /temp\/<role>\/reports\//);
  // Installation metadata and resources are contracts; prose remains editable.
  const { parseFrontmatter } = await import("../src/core/frontmatter.js");
  for (const name of skillEntrypoints.filter((name): name is string => name !== undefined)) {
    const skill = await fs.readFile(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");
    const metadata = parseFrontmatter(skill).data;
    assert.equal(metadata.name, name);
    assert.equal(typeof metadata.description, "string");
    assert.ok((metadata.description as string).trim());
    assert.equal(await exists(path.join(repoRoot, "skills", name, "agents", "openai.yaml")), true);
  }
  assert.ok(nodeMaintenance.trim(), "Node maintenance resource must be included");
  assert.ok(recipients.trim(), "Role command resource must be included");
  const canonicalPublicContracts = [spec, inputSkill, recipients].join("\n");
  for (const retired of [
    /agent:<agentId>/i,
    /AgentDefinition/i,
    /LaunchProfile/i,
    /AgentProfile/i,
    /agent-profiles/i,
    /standing roster/i,
    /roster authorization/i,
    /out-of-roster/i,
    /authorized Agent roster/i,
    /\basSub\b/i,
    /concept\.(changed|removed)/i,
    /\bboxId\b/i,
    /\bUserAsk\b/i,
    /task\.askUser/i,
    /Settings route/i,
    /route:<routeId>/i,
    /\bdeliveryId\b/i,
    /task\.deliver/i,
    /\bparentActor\b/i,
    /\bactiveDeliveryId\b/i,
    /\blastReturn\b/i,
    /\bTaskResult\b/i,
    /\bWorkspaceLane\b/i,
    /\bcurrentResultId\b/i,
    /\bacceptMode\b/i,
    /task\.(?:submit|accept|reject|cancel|bindOutput)/i,
    /\bProposal\b|proposal\.(?:list|submit|resolve)|tent propose/,
  ]) {
    assert.doesNotMatch(canonicalPublicContracts, retired);
  }
});

test("docs/skill drift: current Node/Role/Card protocol and canonical type", async () => {
  const spec = await fs.readFile(path.join(repoRoot, "docs", "SPEC.md"), "utf8");

  // SPEC: canonical Node type, immutable Card, and optional Role.
  assert.match(spec, /a Node has one `type`, exactly `goal`, `prompt` or `output`/);
  assert.doesNotMatch(spec, /NODE_TYPE_PRESETS|primary\[-secondary\]/);
  assert.match(spec, /three semantic concepts are Node, Role, and Card/i);
  assert.doesNotMatch(spec, /TaskResult|WorkspaceLane|currentResultId|acceptMode|task\.bindOutput/);
  assert.doesNotMatch(spec, /Base type definitions may set optional `workspacePointer: true`/);
  assert.doesNotMatch(spec, /Built-in `output` enables the flag/);
  assert.doesNotMatch(spec, /multiple workspace pointer nodes/);
  assert.doesNotMatch(spec, /workspacePointer/);

  // Obsidian plugin production source is retired; no plugin UI to reintroduce workspacePointer.
  assert.equal(await exists(path.join(repoRoot, "src", "plugin")), false);

  // Retired direct-write commands are removed from the public CLI surface.
  const tentCli = await fs.readFile(path.join(repoRoot, "src", "cli", "tent.ts"), "utf8");
  assert.doesNotMatch(tentCli, /requires a workspace pointer/);
  assert.doesNotMatch(tentCli, /has no workspace pointer/);
  assert.doesNotMatch(tentCli, /require-check requires a workspace root/);
  assert.doesNotMatch(tentCli, /case "(?:complete|stamp|grant-readable)"/);
  assert.doesNotMatch(tentCli, /\bcomplete\|stamp\b|\bgrant-readable\b/);
});

test("OKF 0.2 validates YAML and reserved documents separately from link integrity", async (t) => {
  const scratch = path.join(repoRoot, ".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, "okf-check-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const check = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/okf-check.mjs"), dir, "--json", ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, TENT_OKF_BUNDLE: "" },
      },
    );
    assert.notEqual(result.status, 2, result.stderr);
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  await fs.writeFile(
    path.join(dir, "index.md"),
    '---\nokf_version: "0.2"\n---\n# Index\n- [Entry](<space concept.md>)\n',
  );
  await fs.writeFile(
    path.join(dir, "space concept.md"),
    '---\ntype: CustomType\ncustom: {nested: [1, 2]}\nverified: {by: "human:test", at: "2026-09-18T00:00:00Z"}\n---\n[Root](/index.md)\n[Missing][m]\n\n[m]: missing.md\n\n`[Example](code.md)`\n',
  );
  let result = check();
  assert.equal(result.status, 0);
  assert.equal(result.report.conformant, true);
  assert.deepEqual(
    result.report.linkIntegrity.issues.map((issue: { target: string }) => issue.target),
    ["missing.md"],
  );
  result = check("--check-links");
  assert.equal(result.status, 1);
  assert.equal(result.report.conformant, true);
  await fs.writeFile(path.join(dir, "missing.md"), "---\ntype: note\n---\n");
  assert.equal(check("--check-links").status, 0);
  for (const invalid of [
    "---\ntype: [broken\n---\n",
    "---\ntype: 42\n---\n",
    "---\ntype: ''\n---\n",
    "No frontmatter",
  ]) {
    await fs.writeFile(path.join(dir, "missing.md"), invalid);
    assert.equal(check().report.conformant, false, invalid);
  }
  await fs.writeFile(path.join(dir, "missing.md"), "---\ntype: note\n---\n");
  await fs.writeFile(path.join(dir, "index.md"), "---\ntype: index\n---\n# Index\n");
  assert.equal(check().report.errors[0].rule, "§8");
  await fs.writeFile(path.join(dir, "index.md"), "# Index\n");
  await fs.writeFile(path.join(dir, "log.md"), "# Updates\n\n## 2026-02-30\n- Impossible date\n");
  assert.equal(check().report.errors[0].rule, "§9");
});

test("OKF workspace validation skips runtime files but includes Role and Note documents", async (t) => {
  const scratch = path.join(repoRoot, ".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, "okf-workspace-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const folder of ["temp", "roles", "notes"])
    await fs.mkdir(path.join(dir, ".tent", folder), { recursive: true });
  await fs.writeFile(path.join(dir, ".tent/temp/trace.md"), "Runtime only");
  await fs.writeFile(path.join(dir, ".tent/roles/role-test.md"), "---\ntype: role\n---\n");
  await fs.writeFile(path.join(dir, ".tent/notes/note-test.md"), "---\ntype: note\n---\n");
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/okf-check.mjs"), "--workspace", dir, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files, 2);
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function gitTrackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
