import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import { isCodeSource, type RepositorySource } from "../src/core/base/repository-imports.js";
import { draftWorkspaceModules } from "../src/core/check/workspace-draft.js";
import { checkModuleMap } from "../src/core/check/module-map.js";
import type { WorkspaceScanResult } from "../src/core/check/workspace-scan.js";
import { readRepositorySources } from "../src/fs/repository-sources.js";
import { readWorkspaceScanRepository } from "../src/fs/workspace-scan.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { readWorkspaceDraftReport } from "./workspace-draft-report.js";

const source = (file: string, value?: unknown): RepositorySource => ({
  path: file,
  ...(value === undefined ? {} : { content: JSON.stringify(value) }),
});
function draft(sources: RepositorySource[]) {
  const facts = repositoryFacts(sources);
  const scan: WorkspaceScanResult = {
    head: null,
    coverage: {
      trackedFiles: sources.length,
      coveredFiles: 0,
      uncoveredFiles: sources.map((item) => item.path),
      directories: [],
    },
    inspectionErrors: [],
    ...facts,
  };
  const result = draftWorkspaceModules(scan);
  const check = checkModuleMap({
    trackedFiles: scan.coverage.uncoveredFiles,
    imports: facts.imports.edges,
    commits: [],
    nodes: result.nodes,
  });
  const owner = (file: string) =>
    result.nodes.find((node) =>
      node.materials.some((item) =>
        item.kind === "file"
          ? item.path === file
          : file.startsWith(item.path + (item.kind === "directory" ? "/" : "")),
      ),
    )!;
  return { ...result, facts, check, owner };
}

test("package bin/main/conditional exports select existing literal local directories only", () => {
  const result = draft([
    source("package.json", {
      bin: { run: "./launch/run", external: "../outside/run", abs: "/root/run" },
      main: "engine/main.json",
      exports: {
        ".": { import: "./api/entry.json", default: [null, "./fallback/entry"] },
        "./wild/*": "./wild/*.json",
        "./url": "https://example.org/remote/data.json",
        "./variable": "./$ENTRY/run",
        "./query": "./query/item.json?raw",
        "./missing": "./missing/nope",
      },
    }),
    source("packages/tool/package.json", { bin: "commands/tool" }),
    ...[
      "launch/run",
      "launch/icon.png",
      "engine/main.json",
      "api/entry.json",
      "fallback/entry",
      "wild/literal.json",
      "outside/run",
      "remote/data.json",
      "$ENTRY/run",
      "query/item.json",
      "packages/tool/commands/tool",
      "packages/tool/settings/local.json",
    ].map((file) => source(file)),
  ]);
  assert.deepEqual(result.facts.productMaterials, [
    { path: "api", kind: "directory" },
    { path: "engine", kind: "directory" },
    { path: "fallback", kind: "directory" },
    { path: "launch", kind: "directory" },
    { path: "packages/tool/commands", kind: "directory" },
  ]);
  assert.notEqual(result.owner("launch/run").name, "Setup");
  assert.equal(result.owner("launch/icon.png").id, result.owner("launch/run").id);
  assert.equal(result.owner("packages/tool/settings/local.json").name, "Setup");
  assert.equal(result.owner("wild/literal.json").name, "Setup");
  assert.ok(
    result.nodes
      .filter((node) => node.name !== "Setup")
      .every((node) => node.materials.every((item) => item.track === "structure")),
  );
  assert.equal(result.facts.imports.scannedFiles, 0);
  assert.deepEqual(result.facts.imports.edges, []);
  assert.ok(result.check.modules.every((item) => item.productionFiles === 0));
  assert.ok(!result.nodes.some((node) => node.name === "Tests"));
});

test("root package entries remain explicit file materials without inventing code or a root directory", () => {
  const result = draft([
    source("package.json", { bin: "./run" }),
    source("run"),
    source("notes.md"),
  ]);
  assert.deepEqual(result.facts.productMaterials, [{ path: "run", kind: "file" }]);
  assert.deepEqual(result.nodes.find((node) => node.name === "run")?.materials, [
    { path: "run", kind: "file" },
  ]);
  assert.equal(result.owner("notes.md").name, "Setup");
});

test("Claude manifest recognizes documented components and literal custom component paths", () => {
  const result = draft([
    source(".claude-plugin/plugin.json", {
      skills: "./extra/skills/",
      hooks: ["./config/hooks.json"],
      commands: {
        about: { source: "./custom/about.md" },
        inline: { content: "./not-a-path/file" },
      },
      experimental: { monitors: "./watch/config.json" },
      mcpServers: { shell: { command: "./unrelated/run" } },
    }),
    ...[
      "bin/run",
      "monitors/monitors.json",
      "skills/run/SKILL.md",
      "skills/run/icon.png",
      "commands/status.md",
      "agents/reviewer.md",
      "hooks/hooks.json",
      ".mcp.json",
      ".lsp.json",
      "output-styles/brief.md",
      "themes/dark.json",
      "workflows/tasks.js",
      "settings.json",
      "extra/skills/run/SKILL.md",
      "extra/local.txt",
      "config/hooks.json",
      "custom/about.md",
      "watch/config.json",
      "unrelated/run",
      "not-a-path/file",
      ".claude/settings.json",
      ".codex/config.toml",
      ".github/workflows/ci.yml",
      "notes.md",
    ].map((file) => source(file)),
  ]);
  for (const file of [
    ".claude-plugin/plugin.json",
    "bin/run",
    "monitors/monitors.json",
    "skills/run/SKILL.md",
    "extra/skills/run/SKILL.md",
    "config/hooks.json",
    "custom/about.md",
  ])
    assert.notEqual(result.owner(file).name, "Setup", file);
  for (const file of [
    "extra/local.txt",
    "unrelated/run",
    "not-a-path/file",
    ".claude/settings.json",
    ".codex/config.toml",
    ".github/workflows/ci.yml",
    "notes.md",
  ])
    assert.equal(result.owner(file).name, "Setup", file);
  assert.equal(result.owner("skills/run/icon.png").id, result.owner("skills/run/SKILL.md").id);
  for (const file of ["bin/run", "monitors/monitors.json", "skills/run/SKILL.md"])
    assert.equal(isCodeSource(file), false);
  assert.deepEqual(result.facts.imports.edges, []);
});

test("Codex components require its root marker; normal host/config/Markdown paths remain Setup", () => {
  const files = [
    "skills/run/SKILL.md",
    "hooks/hooks.json",
    "assets/icon.png",
    ".mcp.json",
    ".app.json",
    "extra/skill/SKILL.md",
    "mapped/config.json",
    "bin/run",
    "monitors/monitors.json",
    ".claude/settings.json",
    ".codex/config.toml",
    ".github/workflows/ci.yml",
    "notes.md",
  ];
  const absent = draft(files.map((file) => source(file)));
  assert.deepEqual(absent.facts.productMaterials, []);
  assert.deepEqual(
    absent.nodes.map((node) => node.name),
    ["Setup"],
  );
  const nested = draft([
    source("nested/.codex-plugin/plugin.json"),
    ...files.map((file) => source(file)),
  ]);
  assert.deepEqual(nested.facts.productMaterials, []);
  const present = draft([
    source(".codex-plugin/plugin.json", {
      skills: ["./extra/skill/"],
      apps: "./mapped/config.json",
      hooks: [{ command: "./bin/run" }],
      interface: { logo: "https://example.org/no.png" },
    }),
    ...files.map((file) => source(file)),
  ]);
  for (const file of files.slice(0, 7)) assert.notEqual(present.owner(file).name, "Setup", file);
  for (const file of files.slice(7)) assert.equal(present.owner(file).name, "Setup", file);
  assert.ok(present.check.modules.every((item) => item.productionFiles === 0));
});

test("Docs owns tracked guidance and screenshots together; fixed names remain guidance elsewhere", () => {
  const result = draft([
    ...[
      "docs/roulette.md",
      "docs/nested/avatar.markdown",
      "docs/rules.txt",
      "docs/shots/one.png",
      "doc/manual.txt",
      "docs/data.json",
      "nested/docs/other.md",
      "AGENTS.md",
      "nested/DESIGN.rst",
      "README.md",
    ].map((file) => source(file)),
  ]);
  assert.deepEqual(result.facts.guidanceFiles, [
    "AGENTS.md",
    "README.md",
    "doc/manual.txt",
    "docs/nested/avatar.markdown",
    "docs/roulette.md",
    "docs/rules.txt",
    "nested/DESIGN.rst",
  ]);
  const docs = result.owner("docs/roulette.md");
  assert.equal(docs.name, "Docs module 2");
  assert.equal(result.owner("docs/shots/one.png").id, docs.id);
  assert.deepEqual(result.nodes.find((node) => node.id === docs.id)?.materials, [
    { path: "docs", kind: "directory", track: "structure" },
  ]);
  assert.ok(!result.nodes.some((node) => node.name === "Assets" || node.name === "Tests"));
  assert.equal(result.owner("nested/docs/other.md").name, "Setup");
});

test("documented product directories survive wrappers and Docs stays one subtree despite sample imports", () => {
  const result = draft([
    source(".claude-plugin/plugin.json"),
    source("bin/nested/task.test.ts"),
    { path: "docs/samples/main.js", content: 'import "../../app/main.js";' },
    { path: "app/main.js", content: 'import "../docs/samples/main.js";' },
    source("docs/shots/one.png"),
  ]);
  assert.equal(result.owner("bin/nested/task.test.ts").name, "bin");
  assert.ok(!result.nodes.some((node) => node.name === "Tests"));
  assert.equal(result.owner("docs/samples/main.js").name, "Docs");
  assert.equal(result.owner("docs/shots/one.png").name, "Docs");
  assert.notEqual(result.owner("app/main.js").id, result.owner("docs/samples/main.js").id);
  assert.equal(result.facts.imports.edges.length, 2);
});

for (const count of [1, 11])
  test(`mixed source/product directories retain a nested product boundary beside ${count} code files`, () => {
    const sources = [
      source("package.json", { exports: { ".": "./plugin/skills/a/SKILL.md" } }),
      source("plugin/skills/a/SKILL.md"),
      ...Array.from({ length: count }, (_, i) => ({
        path: `plugin/src/a${i}.ts`,
        content: "export {};",
      })),
    ];
    const result = draft(sources);
    assert.deepEqual(result.facts.productMaterials, [
      { path: "plugin/skills/a", kind: "directory" },
    ]);
    const product = result.nodes.find((node) =>
      node.materials.some(
        (item) =>
          item.kind === "directory" &&
          item.path === "plugin/skills/a" &&
          item.track === "structure",
      ),
    );
    assert.ok(product, "the explicit product directory needs its own structure draft");
    const ancestors: string[] = [];
    let parent = product.parentId;
    while (parent) {
      const node = result.nodes.find((node) => node.id === parent)!;
      ancestors.unshift(node.materials[0]!.path);
      parent = node.parentId;
    }
    assert.deepEqual(ancestors, ["plugin", "plugin/skills"]);
    assert.deepEqual(result.check.modules.find((node) => node.id === product.id)?.files, [
      "plugin/skills/a/SKILL.md",
    ]);
    const codeOnly = draft(sources.filter((item) => item.path !== "plugin/skills/a/SKILL.md"));
    const codeGroups = (value: ReturnType<typeof draft>) =>
      value.check.modules
        .map((node) => node.files.filter(isCodeSource))
        .filter((files) => files.length)
        .sort((a, b) => a[0]!.localeCompare(b[0]!));
    assert.deepEqual(
      codeGroups(result),
      codeGroups(codeOnly),
      "sibling code grouping remains intact",
    );
    assert.equal(
      result.check.modules.reduce((n, node) => n + node.productionFiles, 0),
      count,
    );
    assert.ok(result.check.modules.every((node) => node.productionFiles <= 10));
    assert.deepEqual(result.check.issues, []);
    assert.deepEqual(draft([...sources].reverse()).batch, result.batch);
  });

for (const entry of ["plugin/main.ts", "plugin/run", "plugin/run.sh"])
  test(`explicit parent and child product declarations remain distinct with ${entry}`, () => {
    const sources = [
      source("package.json", { bin: "./" + entry, exports: "./plugin/skills/a/SKILL.md" }),
      source(entry),
      source("plugin/skills/a/SKILL.md"),
    ];
    const expected = [
      { path: "plugin", kind: "directory" },
      { path: "plugin/skills/a", kind: "directory" },
    ];
    const result = draft(sources);
    assert.deepEqual(result.facts.productMaterials, expected);
    const directoryNode = (value: ReturnType<typeof draft>, directory: string) =>
      value.nodes.find((node) =>
        node.materials.some(
          (item) =>
            item.kind === "directory" && item.path === directory && item.track === "structure",
        ),
      )!;
    const parent = directoryNode(result, "plugin");
    const intermediate = directoryNode(result, "plugin/skills");
    const child = directoryNode(result, "plugin/skills/a");
    assert.ok(parent && intermediate && child);
    assert.equal(intermediate.parentId, parent.id);
    assert.equal(child.parentId, intermediate.id);
    assert.deepEqual(result.check.modules.find((node) => node.id === parent.id)?.files, [entry]);
    assert.deepEqual(result.check.modules.find((node) => node.id === child.id)?.files, [
      "plugin/skills/a/SKILL.md",
    ]);
    assert.deepEqual(result.check.issues, []);
    const extended = draft([
      source("package.json", {
        bin: { run: "./" + entry, alias: "./" + entry },
        exports: ["./plugin/skills/a/SKILL.md", "./plugin/skills/a/SKILL.md"],
      }),
      ...sources.slice(1),
      source("plugin/settings.json"),
      source("plugin/skills/a/icon.png"),
      source("outside/config.json"),
      source("test/entry.test.ts"),
    ]);
    assert.deepEqual(
      extended.facts.productMaterials,
      expected,
      "only identical boundaries deduplicate",
    );
    const owner = (file: string) =>
      extended.check.modules.find((node) => node.files.includes(file))!;
    assert.equal(owner(entry).id, directoryNode(extended, "plugin").id);
    assert.equal(owner("plugin/settings.json").id, owner(entry).id);
    assert.equal(
      owner("plugin/skills/a/icon.png").id,
      directoryNode(extended, "plugin/skills/a").id,
    );
    assert.ok(
      extended.nodes
        .find((node) => node.name === "Setup")
        ?.materials.some((item) => item.path === "outside" && item.kind === "directory"),
    );
    assert.ok(
      extended.nodes
        .find((node) => node.name === "Tests")
        ?.materials.some((item) => item.path === "test" && item.kind === "directory"),
    );
    assert.equal(
      extended.check.modules.reduce((n, node) => n + node.productionFiles, 0),
      Number(isCodeSource(entry)),
    );
    assert.deepEqual(extended.check.issues, []);
    assert.deepEqual(draft([...sources].reverse()).batch, result.batch);
  });

test("scan and CLI draft read only opted-in manifest bytes; guidance stays path-only and receipts stay bounded", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "scan-products-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await scaffoldInWorkspace(openTestFs(root), { name: "Products" });
  const content: Record<string, string> = {
    "package.json": JSON.stringify({
      bin: "./launch/run",
      main: "./main-data/entry.json",
      exports: { ".": "./public-data/entry.json" },
    }),
    ".claude-plugin/plugin.json": "{}",
    "launch/run": "#!/bin/sh\nexit 1\n",
    "main-data/entry.json": "{}",
    "public-data/entry.json": "{}",
    "bin/plugin-run": "#!/bin/sh\n",
    "monitors/monitors.json": "{}",
    "skills/run/SKILL.md": "Skill body must not be read",
    "docs/shots/one.png": "image bytes",
    "test/entry.test.ts": "export const tested = 1;",
    ...Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`docs/rule-${i}.md`, "Rules body"]),
    ),
  };
  for (const [file, text] of Object.entries(content)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  await fs.mkdir(path.join(root, ".scratch"));
  await git(
    root,
    "add",
    "package.json",
    ".claude-plugin",
    "launch",
    "main-data",
    "public-data",
    "bin",
    "monitors",
    "skills",
    "docs",
    "test",
  );
  const plain = await readRepositorySources(root, Object.keys(content));
  assert.ok(
    plain.files
      .filter((file) => file.path !== "test/entry.test.ts")
      .every((file) => file.content === undefined),
  );
  const repository = await readWorkspaceScanRepository(root);
  assert.deepEqual(repository.sources.errors, []);
  assert.equal(
    repository.sources.files.find((file) => file.path === "package.json")?.content,
    content["package.json"],
  );
  assert.equal(
    repository.sources.files.find((file) => file.path === ".claude-plugin/plugin.json")?.content,
    "{}",
  );
  for (const file of [
    "docs/rule-0.md",
    "skills/run/SKILL.md",
    "monitors/monitors.json",
    "launch/run",
  ])
    assert.equal(repository.sources.files.find((item) => item.path === file)?.content, undefined);
  await fs.writeFile(path.join(root, "docs/untracked.md"), "Untracked body");
  const scanned = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(scanned.exitCode, 0, scanned.stderr);
  const facts = JSON.parse(scanned.stdout);
  assert.equal(facts.guidanceFiles.length, 60);
  assert.ok(!facts.guidanceFiles.includes("docs/untracked.md"));
  for (const dir of ["launch", "main-data", "public-data", "bin", "skills", "monitors"])
    assert.ok(
      facts.productMaterials.some((item: { path: string }) => item.path === dir),
      dir,
    );
  const prepared = await runWorkspaceCommand("scan", ["--draft", ".scratch/batch.json", "--json"], {
    workspace: root,
  });
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  assert.ok(Buffer.byteLength(prepared.stdout) <= 4096);
  const receipt = JSON.parse(prepared.stdout);
  const report = readWorkspaceDraftReport(
    await fs.readFile(path.join(root, ".scratch/batch.report.json"), "utf8"),
  );
  assert.equal(receipt.counts.guidanceFiles, 60);
  assert.equal(receipt.examples.guidanceFiles.length + receipt.omitted.guidanceFiles.count, 60);
  assert.equal(report.guidanceFiles.length, 60);
  const batch = JSON.parse(await fs.readFile(path.join(root, ".scratch/batch.json"), "utf8"));
  assert.ok(batch.items.some((item: { name: string }) => item.name === "Tests"));
  for (const dir of ["launch", "main-data", "public-data", "bin", "skills", "monitors"])
    assert.ok(
      report.modules.some(
        (item) => item.name !== "Setup" && item.files.some((file) => file.startsWith(dir + "/")),
      ),
      dir,
    );
  const docs = report.modules.find((item) => item.name === "Docs")!;
  assert.equal(docs.files.length, 61);
  assert.equal(docs.productionFiles, 0);
  assert.ok(report.modules.every((item) => item.productionFiles === 0));
});
