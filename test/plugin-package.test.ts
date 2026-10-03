import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractOutLinksDetailed } from "../src/markdown/links.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = path.join(root, ".scratch");
const run = promisify(execFile);

test(
  "plugin bundle carries its marketplace and runtime without host restrictions",
  { timeout: 60_000 },
  async (t) => {
    await fs.mkdir(scratch, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(scratch, "plugin-portable-"));
    t.after(() => fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
    const bundle = path.join(fixture, "plugins", "tent");
    await run(process.execPath, ["scripts/build-plugin.mjs", bundle], {
      cwd: root,
      windowsHide: true,
      timeout: 45_000,
    });
    const manifest = JSON.parse(await fs.readFile(path.join(bundle, "package.json"), "utf8"));
    assert.equal("os" in manifest, false);
    assert.equal("cpu" in manifest, false);
    assert.equal("libc" in manifest, false);
    await assert.rejects(fs.access(path.join(bundle, "node_modules")), { code: "ENOENT" });
    assert.ok((await fs.stat(path.join(bundle, "cli.mjs"))).size > 0);
    assert.ok((await fs.stat(path.join(bundle, "ui-dist/app.js"))).size > 0);
    assert.ok((await fs.readdir(path.join(bundle, "ui-dist/fonts/Xiaolai"))).length > 0);
    await assert.rejects(fs.access(path.join(bundle, "ui-dist/snapshot.json")), { code: "ENOENT" });
    const catalogue = JSON.parse(
      await fs.readFile(path.join(fixture, ".agents/plugins/marketplace.json"), "utf8"),
    );
    assert.equal(catalogue.plugins[0].source.path, "./plugins/tent");
  },
);

test(
  "standalone plugin runs direct documents and two advisory hooks without a Service",
  { timeout: 180_000 },
  async (t) => {
    await fs.mkdir(scratch, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(scratch, "plugin-package-"));
    t.after(() => fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
    const bundle = path.join(fixture, "distribution with spaces", "plugins", "tent");
    const workspace = path.join(fixture, "user project"),
      dataDir = path.join(fixture, "absent service state");
    await fs.mkdir(workspace);
    await run(process.execPath, ["scripts/build-plugin.mjs", bundle], {
      cwd: root,
      windowsHide: true,
      timeout: 60_000,
    });
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
    for (const relative of await fs.readdir(bundle, { recursive: true })) {
      if (
        (!relative.startsWith("skills") && !relative.startsWith("skill-resources")) ||
        !relative.endsWith(".md")
      )
        continue;
      const file = path.join(bundle, relative);
      for (const link of extractOutLinksDetailed(await fs.readFile(file, "utf8"))) {
        const target = link.raw.split("#")[0]!;
        if (target && !/^[a-z]+:/i.test(target) && !target.includes("<"))
          await fs.access(path.resolve(path.dirname(file), target));
      }
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
      "/context/context.md",
      "--target",
      role.roleId,
      "--prompt",
      "Review this context",
    ]);
    const input = await json(["card", "show", card.cardId]);
    const before = (await json(["node", "get", node.nodeId, "--full"])).node;
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
    assert.equal(historical.node.text, "Original input\n");
    const taken = await json(["card", "take", card.cardId, "--role", role.roleId]);
    assert.equal(taken.state, "consumed");
    assert.equal((await json(["card", "take", card.cardId, "--role", role.roleId])).replayed, true);
    await json([
      "card",
      "interrupt",
      card.cardId,
      "--role",
      role.roleId,
      "--commit",
      taken.version.commit,
    ]);
    const interrupted = await json(["card", "show", card.cardId]);
    assert.equal(interrupted.state, "interrupted");
    await json([
      "card",
      "continue",
      card.cardId,
      "--role",
      role.roleId,
      "--commit",
      interrupted.version.commit,
    ]);
    await assert.rejects(
      cli(["node", "write", node.nodeId, "--body", "Lost", "--base-etag", before.etag]),
      /conflict|etag/i,
    );
    const hooks = JSON.parse(
      await fs.readFile(path.join(bundle, "hooks/hooks.json"), "utf8"),
    ).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ["SessionStart", "Stop"]);
    assert.equal(hooks.Stop[0].hooks[0].async, true);
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
    assert.doesNotMatch(start, /SKILL\.md|\$tent-|reconcile|baseline|sessionToken/);
    assert.match(JSON.parse(await hook("Stop")).systemMessage, /未证实|unverified/);
    await assert.rejects(fs.access(dataDir), { code: "ENOENT" });
    await assert.rejects(fs.access(trap), { code: "ENOENT" });
    // A broken CLI is not repaired with a cwd/global runtime.
    await fs.rename(path.join(bundle, "cli.mjs"), path.join(bundle, "cli.saved.mjs"));
    await assert.rejects(cli(["node", "list"]), /ENOENT/);
  },
);
