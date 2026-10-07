import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { git } from "./helpers.js";

test("direct export preserves published Git sources after live rename/deletion and rejects invalid history", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "direct-export-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await initializeTentWorkspace(workspace);
  const tentRoot = path.join(workspace, ".tent"),
    adapter = new NodeFs(tentRoot);
  assert.equal(await adapter.exists("roles.json"), false);
  const globals = { workspace, json: true };
  const parse = (r: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(r.exitCode, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const node = parse(
    await runNodeCommand(
      "create",
      ["Source", "--type", "prompt", "--body", "Exact original"],
      globals,
    ),
  ).node;
  const role = parse(
    await runRoleCommand("create", ["--title", "Direction", "--body", "Original purpose"], globals),
  );
  const card = parse(
    await runCardCommand(
      "create",
      [
        "--prompt",
        "Read originals",
        "--source",
        ".tent/Source/Source.md",
        "--source",
        `.tent/roles/${role.roleId}.md`,
        "--source",
        "./external.txt",
      ],
      globals,
    ),
  );
  const published = parse(await runCardCommand("show", [card.cardId], globals));
  assert.deepEqual(
    published.sources
      .slice(0, 2)
      .map((source: { version: { path: string } }) => source.version.path),
    ["Source/Source.md", `roles/${role.roleId}.md`],
  );
  await runNodeCommand("rename", [node.nodeId, "Moved"], globals).then(parse);
  await fs.unlink(path.join(tentRoot, "roles", `${role.roleId}.md`));
  await adapter.writeFile("temp/not-exported.json", "runtime only");
  await fs.writeFile(path.join(workspace, "external.txt"), "external bytes stay external");
  const before = await git(tentRoot, "status", "--porcelain");
  const exported = parse(
    await runWorkspaceCommand("export", ["--output", "output/context"], globals),
  );
  assert.equal(
    (await fs.readdir(path.join(exported.outputDir, ".tent/.git"))).some((name) =>
      /^tent-(?:history-index|derived-.*)\.json/.test(name),
    ),
    false,
  );
  const restored = new NodeFs(path.join(exported.outputDir, ".tent"));
  assert.equal(
    await restored.readFile(`cards/${card.cardId}.md`),
    await adapter.readFile(`cards/${card.cardId}.md`),
  );
  for (const source of published.sources.filter(
    (source: { version?: unknown }) => source.version,
  )) {
    assert.equal(
      await restored.history.read(source.version),
      await adapter.history.read(source.version),
    );
  }
  assert.equal(await restored.exists("temp/not-exported.json"), false);
  await assert.rejects(fs.stat(path.join(exported.outputDir, "external.txt")), { code: "ENOENT" });
  const manifest = JSON.parse(await fs.readFile(exported.manifestPath, "utf8"));
  assert.ok(
    manifest.externalNotPacked.some(
      (item: { resource?: string }) => item.resource === "../../external.txt",
    ),
  );
  assert.equal(await git(tentRoot, "status", "--porcelain"), before);
  const raw = await adapter.readFile(`cards/${card.cardId}.md`),
    parsed = parseFrontmatter(raw);
  const sources = parsed.data.sources as { version?: { commit: string } }[];
  sources[0]!.version!.commit = "0".repeat(40);
  await fs.writeFile(
    path.join(tentRoot, "cards", `${card.cardId}.md`),
    serializeFrontmatter(parsed.data, parsed.body),
  );
  const rejected = await runWorkspaceCommand("export", ["--output", "output/bad-history"], globals);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /Git|commit|history/i);
  await assert.rejects(fs.stat(path.join(workspace, "output/bad-history")), { code: "ENOENT" });
});
