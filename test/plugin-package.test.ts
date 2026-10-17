import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = path.join(root, ".scratch");
const run = promisify(execFile);
let fixture: string;
let distribution: string;
const bundleFor = (host: string) => path.join(distribution, host, "plugins/tent");
before(
  async () => {
    await fs.mkdir(scratch, { recursive: true });
    fixture = await fs.mkdtemp(path.join(scratch, "plugin-packages-"));
    distribution = path.join(fixture, "distribution with spaces");
    await run(process.execPath, ["scripts/build-plugin.mjs", distribution], {
      cwd: root,
      windowsHide: true,
      timeout: 60_000,
    });
  },
  { timeout: 70_000 },
);
after(async () => {
  if (fixture)
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

test(
  "plugin bundle carries its marketplace and runtime without host restrictions",
  { timeout: 60_000 },
  async (t) => {
    const bundle = bundleFor("codex");
    const manifest = JSON.parse(await fs.readFile(path.join(bundle, "package.json"), "utf8"));
    assert.equal("os" in manifest, false);
    assert.equal("cpu" in manifest, false);
    assert.equal("libc" in manifest, false);
    await assert.rejects(fs.access(path.join(bundle, "node_modules")), { code: "ENOENT" });
    assert.ok((await fs.stat(path.join(bundle, "cli.mjs"))).size > 0);
    assert.ok((await fs.stat(path.join(bundle, "ui-dist/app.js"))).size > 0);
    await assert.rejects(fs.access(path.join(bundle, "ui-dist/fonts")), { code: "ENOENT" });
    assert.doesNotMatch(
      await fs.readFile(path.join(bundle, "ui-dist/THIRD_PARTY_NOTICES.txt"), "utf8"),
      /excalidraw/i,
    );
    await assert.rejects(fs.access(path.join(bundle, "ui-dist/snapshot.json")), { code: "ENOENT" });
    const catalogue = JSON.parse(
      await fs.readFile(path.join(distribution, "codex/.agents/plugins/marketplace.json"), "utf8"),
    );
    assert.equal(catalogue.plugins[0].source.path, "./plugins/tent");
  },
);

test("both host packages carry the same common payload and separate native shells", async () => {
  const { validateHostPackage } = await import(
    new URL("../scripts/validate-plugin.mjs", import.meta.url).href
  );
  const codex = bundleFor("codex"),
    claude = bundleFor("claude-code");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  for (const [host, manifestPath] of [
    ["codex", ".codex-plugin/plugin.json"],
    ["claude-code", ".claude-plugin/plugin.json"],
  ]) {
    const bundle = bundleFor(host!);
    await validateHostPackage(bundle, host);
    const manifest = JSON.parse(await fs.readFile(path.join(bundle, manifestPath!), "utf8"));
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.name, "tent");
    assert.deepEqual(
      await fs.readFile(path.join(bundle, "skills/tent-init/references/host-hooks.md")),
      await fs.readFile(path.join(root, "plugins", host!, "tent/host-hooks.md")),
    );
    await assert.rejects(fs.access(path.join(bundle, "host-hooks.md")), { code: "ENOENT" });
  }
  const commonFiles = ["cli.mjs", "package.json", "THIRD_PARTY_NOTICES.txt", "LICENSE"];
  for (const dir of ["ui-dist", "docs", "skill-resources", "skills"]) {
    const codexFiles = (await fs.readdir(path.join(codex, dir), { recursive: true })).map(
      (f) => `${dir}/${f.replaceAll("\\", "/")}`,
    );
    for (const file of codexFiles) {
      if (file.includes("/agents") || file.endsWith("/host-hooks.md")) continue;
      if ((await fs.stat(path.join(codex, file))).isFile()) commonFiles.push(file);
    }
  }
  for (const file of commonFiles)
    assert.deepEqual(
      await fs.readFile(path.join(codex, file)),
      await fs.readFile(path.join(claude, file)),
      file,
    );
  for (const skill of ["tent-card", "tent-init", "tent-node", "tent-role"])
    await assert.rejects(fs.access(path.join(claude, "skills", skill, "agents")), {
      code: "ENOENT",
    });
  await assert.rejects(fs.access(path.join(claude, ".codex-plugin")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(codex, ".claude-plugin")), { code: "ENOENT" });
  assert.deepEqual(
    await fs.readFile(path.join(codex, "hooks/hooks.json")),
    await fs.readFile(path.join(root, "plugins/codex/tent/hooks/hooks.json")),
  );
  assert.equal(
    createHash("sha256")
      .update(await fs.readFile(path.join(codex, "hooks/hooks.json")))
      .digest("hex"),
    "142e9524a80ca621779fcf723f39a6d49ec5852dbdb9abb4aa888194c66e6ba7",
    "Published Codex Hook definitions retain their trust identity",
  );
  const catalogue = JSON.parse(
    await fs.readFile(
      path.join(distribution, "claude-code/.claude-plugin/marketplace.json"),
      "utf8",
    ),
  );
  assert.equal(catalogue.owner.name, "cucarol");
  assert.equal(catalogue.plugins[0].source, "./plugins/tent");
  await assert.rejects(
    run(process.execPath, ["scripts/build-plugin.mjs", distribution], {
      cwd: root,
      windowsHide: true,
    }),
    /EEXIST/,
  );
});

test(
  "Git distribution has two root catalogues and publishes a single root commit without source or index changes",
  { timeout: 60_000 },
  async () => {
    const { publishPluginDistribution } = await import(
      new URL("../scripts/publish-plugin-dist.mjs", import.meta.url).href
    );
    const remote = path.join(fixture, "distribution-remote.git");
    const git = async (...args: string[]) =>
      (await run("git", args, { cwd: root, windowsHide: true })).stdout.trim();
    await git("init", "--bare", remote);
    const head = await git("rev-parse", "HEAD");
    const emptyTree = await git("--git-dir", remote, "write-tree");
    const main = await git(
      "--git-dir",
      remote,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      emptyTree,
      "-m",
      "Preserve this branch",
    );
    await git("--git-dir", remote, "update-ref", "refs/heads/main", main);
    const beforeIndex = await git("diff", "--cached", "--raw");
    const published = await publishPluginDistribution(distribution, remote);
    assert.equal(await git("--git-dir", remote, "rev-list", "--count", "plugin-dist"), "1");
    assert.equal(await git("--git-dir", remote, "rev-parse", "main"), main);
    assert.equal(await git("rev-parse", "HEAD"), head);
    assert.equal(await git("diff", "--cached", "--raw"), beforeIndex);
    const paths = (
      await git("--git-dir", remote, "ls-tree", "-r", "--name-only", "plugin-dist")
    ).split("\n");
    assert.ok(paths.every((file) => /^(codex|claude-code|\.agents|\.claude-plugin)\//.test(file)));
    for (const [host, cataloguePath] of [
      ["codex", ".agents/plugins/marketplace.json"],
      ["claude-code", ".claude-plugin/marketplace.json"],
    ]) {
      const catalogue = JSON.parse(
        await git("--git-dir", remote, "show", `plugin-dist:${cataloguePath}`),
      );
      assert.equal(catalogue.name, "tent");
      assert.deepEqual(
        catalogue.plugins[0].source,
        host === "codex"
          ? { source: "local", path: "./codex/plugins/tent" }
          : "./claude-code/plugins/tent",
      );
      assert.ok(paths.includes(`${host}/plugins/tent/cli.mjs`));
    }
    const republished = await publishPluginDistribution(distribution, remote);
    assert.equal(republished.tree, published.tree);
    assert.equal(await git("--git-dir", remote, "rev-list", "--count", "plugin-dist"), "1");
    assert.equal(await git("--git-dir", remote, "rev-parse", "plugin-dist"), republished.commit);
    assert.equal(await git("--git-dir", remote, "rev-parse", "main"), main);
  },
);

test("Claude Code Hook commands use their own bundle even when PLUGIN_ROOT points elsewhere", async () => {
  const bundle = bundleFor("claude-code"),
    workspace = path.join(fixture, "claude user project");
  await fs.mkdir(workspace);
  await run(
    process.execPath,
    [path.join(bundle, "skill-resources/scripts/tent.mjs"), "new", workspace],
    { cwd: workspace, windowsHide: true },
  );
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: bundle,
    PLUGIN_ROOT: path.join(fixture, "wrong plugin"),
  };
  const hooks = JSON.parse(await fs.readFile(path.join(bundle, "hooks/hooks.json"), "utf8")).hooks;
  const invoke = (event: string) =>
    new Promise<string>((resolve, reject) => {
      const child = exec(
        hooks[event][0].hooks[0].command,
        { cwd: workspace, env, windowsHide: true, timeout: 30_000 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
      );
      child.stdin!.end(
        JSON.stringify({ hook_event_name: event, session_id: "claude-fixture", cwd: workspace }),
      );
    });
  const start = JSON.parse(await invoke("SessionStart")).hookSpecificOutput.additionalContext;
  assert.ok(start.includes(JSON.stringify(path.join(bundle, "cli.mjs"))));
  // Missing native prompt identity is a Claude-specific silent Stop, proving fixed host routing.
  assert.deepEqual(JSON.parse(await invoke("Stop")), {});
  const { validateHostPackage } = await import(
    new URL("../scripts/validate-plugin.mjs", import.meta.url).href
  );
  const launcher = path.join(bundle, "hooks/session.mjs");
  await fs.rename(launcher, `${launcher}.saved`);
  try {
    await assert.rejects(validateHostPackage(bundle, "claude-code"), /ENOENT/);
  } finally {
    await fs.rename(`${launcher}.saved`, launcher);
  }
});

test(
  "standalone plugin runs direct documents and two advisory hooks without a Service",
  { timeout: 180_000 },
  async (t) => {
    const bundle = bundleFor("codex");
    const workspace = path.join(fixture, "user project"),
      dataDir = path.join(fixture, "absent service state");
    await fs.mkdir(workspace);
    const expectedSkills = ["tent-card", "tent-init", "tent-node", "tent-role"];
    assert.deepEqual((await fs.readdir(path.join(bundle, "skills"))).sort(), expectedSkills);
    for (const skill of expectedSkills) {
      assert.equal(
        await fs.readFile(path.join(bundle, "skills", skill, "SKILL.md"), "utf8"),
        await fs.readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8"),
      );
      assert.ok(
        (
          await fs.readFile(path.join(bundle, "skills", skill, "agents/openai.yaml"), "utf8")
        ).includes(`$tent:${skill}`),
      );
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(bundle, ".codex-plugin/plugin.json"), "utf8"),
    );
    assert.equal(manifest.mcpServers, undefined);
    assert.equal(manifest.mcp, undefined);
    // Deliberately unavailable: none of these document/Hook operations can attach it.
    await assert.rejects(fs.access(path.join(bundle, "service.mjs")), { code: "ENOENT" });
    const trap = path.join(workspace, "wrong-runtime-used");
    await fs.writeFile(
      path.join(workspace, "service.mjs"),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(trap)},'bad');process.exit(91);`,
    );
    const env = { ...process.env, TENT_SERVICE_DATA_DIR: dataDir, PLUGIN_ROOT: bundle };
    const launcher = path.join(bundle, "skill-resources/scripts/tent.mjs");
    const cli = async (args: string[], stdin?: string) => {
      const child = run(process.execPath, [launcher, ...args], {
        cwd: workspace,
        env,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      child.child.stdin!.end(stdin);
      return child;
    };
    const json = async (args: string[], stdin?: string) =>
      JSON.parse((await cli([...args, "--json"], stdin)).stdout);
    await cli(["new", workspace]);
    const node = (
      await json(["node", "create", "context", "--type", "prompt", "--body", "Original input"])
    ).node;
    const role = await json(["role", "create", "--title", "Reviewer", "--body", "Review only"]);
    const card = await json([
      "card",
      "create",
      "--source",
      ".tent/context/context.md",
      "--target",
      role.roleId,
      "--prompt",
      "Review this context",
    ]);
    const input = await json(["card", "show", card.cardId]);
    assert.equal(input.sources[0].version.path, "context/context.md");
    const before = await json(["node", "get", node.nodeId, "--full"]);
    await json([
      "node",
      "write",
      node.nodeId,
      "--body",
      "Live changed",
      "--base-etag",
      before.etag,
    ]);
    const historical = await json([
      "node",
      "get",
      node.nodeId,
      "--version-json",
      JSON.stringify(input.sources[0].version),
    ]);
    assert.equal(historical.text, "Original input\n");
    const taken = await json(["card", "take", card.cardId, "--role", role.roleId]);
    assert.equal(taken.state, "consumed");
    assert.equal("progress" in taken, false);
    assert.equal((await json(["card", "take", card.cardId, "--role", role.roleId])).replayed, true);
    await assert.rejects(cli(["card", "interrupt", card.cardId]), /Unknown card command/);
    await assert.rejects(
      cli(["node", "write", node.nodeId, "--body", "Lost", "--base-etag", before.etag]),
      /conflict|etag/i,
    );
    const hooks = JSON.parse(
      await fs.readFile(path.join(bundle, "hooks/hooks.json"), "utf8"),
    ).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ["SessionStart", "Stop"]);
    assert.equal(hooks.Stop[0].hooks[0].async, undefined);
    const hook = (event: string, extra: Record<string, unknown> = {}) =>
      new Promise<string>((resolve, reject) => {
        const child = exec(
          hooks[event][0].hooks[0].command,
          { cwd: workspace, env, windowsHide: true, timeout: 30_000 },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
        );
        child.stdin!.end(
          JSON.stringify({
            hook_event_name: event,
            session_id: "fixture-session",
            cwd: workspace,
            ...extra,
          }),
        );
      });
    const start = JSON.parse(await hook("SessionStart")).hookSpecificOutput.additionalContext;
    assert.ok(start.includes(workspace));
    assert.ok(start.includes(JSON.stringify(path.join(bundle, "cli.mjs"))));
    assert.match(start, /workspace brief/);
    assert.doesNotMatch(start, /SKILL\.md|\$tent-|reconcile|baseline|sessionToken/);
    assert.match(
      JSON.parse(await hook("Stop")).systemMessage,
      /Stop session and turn identities are required/,
    );
    const transcript = path.join(workspace, "turn.jsonl");
    await fs.writeFile(path.join(workspace, "new.svg"), "<svg>private payload</svg>");
    await fs.writeFile(
      transcript,
      [
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "turn-1",
            item: {
              type: "FileChange",
              status: "completed",
              changes: { "new.svg": { type: "add" } },
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const stopInput = { turn_id: "turn-1", transcript_path: transcript };
    const stop = await hook("Stop", stopInput);
    assert.ok(Buffer.byteLength(stop) <= 2048);
    assert.deepEqual(JSON.parse(stop), {});
    const observationDir = path.join(workspace, ".tent", "temp", "observations");
    await assert.rejects(fs.access(observationDir), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await hook("Stop", stopInput)), {});
    await assert.rejects(fs.access(path.join(workspace, ".tent", "temp", "stop-reviews")), {
      code: "ENOENT",
    });
    await assert.rejects(fs.access(dataDir), { code: "ENOENT" });
    await assert.rejects(fs.access(trap), { code: "ENOENT" });
    // A broken CLI is not repaired with a cwd/global runtime.
    await fs.rename(path.join(bundle, "cli.mjs"), path.join(bundle, "cli.saved.mjs"));
    await assert.rejects(cli(["node", "list"]), /ENOENT/);
  },
);
