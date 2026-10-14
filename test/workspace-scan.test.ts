import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { scanWorkspace, formatWorkspaceScan } from "../src/core/workspace-scan.js";
import { readWorkspaceScanRepository, scanFileKind } from "../src/fs/workspace-scan.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";
import { repositoryFacts } from "../src/core/repository-facts.js";

async function fixture(t: TestContext, initializeGit = true) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "workspace-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  if (initializeGit) await git(root, "init", "-b", "main");
  if (initializeGit) await fs.appendFile(path.join(root, ".git/info/exclude"), "\n/.tent/\n");
  await scaffoldInWorkspace(new NodeFs(root), { name: "Scan" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  const write = async (file: string, text = "text") => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  const node = (name: string, data: Record<string, unknown>, body = "") =>
    adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter({ id: `node-${name}`, type: "prompt", ...data }, body),
    );
  return { root, adapter, write, node };
}

async function snapshot(root: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const file = path.join(root, entry.name),
      relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, await snapshot(file, `${relative}/`));
    else
      files[relative] = createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
  }
  return files;
}

test("scan text bounds retained fact groups and escapes path control characters", () => {
  const report = {
    head: null,
    coverage: {
      trackedFiles: 8,
      coveredFiles: 0,
      uncoveredFiles: [],
      directories: Array.from({ length: 8 }, (_, i) => ({ directory: `dir${i}`, count: 1 })),
    },
    inspectionErrors: [],
    ...repositoryFacts([
      { path: "a\nbreak/AGENTS.md" },
      { path: "b\u2029/CONTRIBUTING.md" },
      ...Array.from({ length: 8 }, (_, i) => ({ path: `guide${i}/AGENTS.md` })),
    ]),
  };
  const text = formatWorkspaceScan(report);
  assert.equal(text.split("\n").filter((line) => line.startsWith("uncovered ")).length, 3);
  assert.match(text, /a\\nbreak/);
  assert.match(text, /b\\u2029/);
  assert.match(text, /guidance .*; \+5 more/);
});

test("scan removes .tent files and diagnostics even when repository input contains them", async (t) => {
  const { root, adapter, write, node } = await fixture(t);
  await write("src/main.ts", "export const value = 1;");
  await node("Root", { sources: [{ resource: "../../", track: "structure" }] });
  const baseline = {
    head: null,
    trackedFiles: ["src/main.ts"],
    sources: { files: [{ path: "src/main.ts", content: "export const value = 1;" }], errors: [] },
  };
  const polluted = {
    ...baseline,
    trackedFiles: [...baseline.trackedFiles, ".tent/cache/AGENTS.md"],
    sources: {
      files: [...baseline.sources.files, { path: ".tent/cache/AGENTS.md", content: "internal" }],
      errors: [{ file: ".tent/cache/AGENTS.md", reason: "internal failure" }],
    },
  };
  assert.deepEqual(
    await scanWorkspace(adapter, root, polluted, scanFileKind),
    await scanWorkspace(adapter, root, baseline, scanFileKind),
  );
});

test("scan uses active material coverage, excludes body links and respects directory boundaries", async (t) => {
  const { root, adapter, write, node } = await fixture(t);
  for (const file of [
    "src/core/a.ts",
    "src/core/nested/b.ts",
    "src/core-other/c.ts",
    "docs/section.md",
    "docs/body.md",
    "docs/ref.md",
    "docs/quoted.md",
    "docs/no.md",
    "guide/README.markdown",
    "README.md",
    "docs/gone.md",
  ])
    await write(file, "# Part\n");
  await node(
    "module",
    {
      resource: "../../src/core/",
      sources: [
        { resource: "../../docs/section.md#Part" },
        { resource: "ordinary description" },
        { resource: "https://example.invalid/x.md" },
        {
          resource: pathToFileURL(
            path.join(root, process.platform === "win32" ? "readme.md" : "README.md"),
          ).href,
        },
      ],
    },
    "[body](../../docs/body.md#Part)\n[ref][design]\n\n[design]: ../../docs/ref.md\n[unused]: ../../docs/no.md\n\n`[quoted](../../docs/quoted.md)`\n![image](../../docs/quoted.md)\n[remote](https://example.invalid/no.md)",
  );
  await node("docs", { resource: "../../guide/", status: "deprecated" });
  await node("missingdir", { resource: "../../gone/" });
  await adapter.writeFile(
    "roles/role-other.md",
    serializeFrontmatter(
      { type: "role", id: "role-other", resource: "../../docs/no.md" },
      "[quoted](../../docs/quoted.md)",
    ),
  );
  await git(root, "add", ".");
  await git(root, "commit", "-m", "first");
  await fs.unlink(path.join(root, "docs/gone.md"));
  await write("draft.md");
  await write("ignored.md");
  await write(".gitignore", ".tent/\nignored.md\n");
  const repository = await readWorkspaceScanRepository(root);
  repository.trackedFiles.push("gone/x.ts");
  const before = await snapshot(root);
  const result = await scanWorkspace(adapter, root, repository, scanFileKind);
  assert.deepEqual(result.inspectionErrors, []);
  assert.equal(result.coverage.coveredFiles, 5);
  assert.ok(result.coverage.uncoveredFiles.includes("guide/README.markdown"));
  assert.ok(result.coverage.uncoveredFiles.includes("src/core-other/c.ts"));
  assert.ok(result.coverage.uncoveredFiles.includes("docs/body.md"));
  assert.ok(!result.coverage.uncoveredFiles.includes("gone/x.ts"));
  assert.ok(result.coverage.uncoveredFiles.includes("docs/ref.md"));
  assert.ok(result.coverage.uncoveredFiles.includes("docs/quoted.md"));
  assert.ok(result.coverage.uncoveredFiles.includes("docs/no.md"));
  assert.ok(!repository.trackedFiles.includes("draft.md"));
  assert.ok(!repository.trackedFiles.includes("ignored.md"));
  assert.deepEqual(await snapshot(root), before);
  assert.equal(
    JSON.stringify(await scanWorkspace(adapter, root, repository, scanFileKind)),
    JSON.stringify(result),
  );
});

test("scan prefix coverage uses shared membership, including nested suffixes, without reading glob paths or writing", async (t) => {
  const { root, adapter, write, node } = await fixture(t);
  for (const file of ["src/card-a.ts", "src/card-nested/b.ts", "src/cardinal.ts", "docs/card-a.md"])
    await write(file, file.endsWith(".md") ? "# Card" : "export {};");
  await node("cardmap", {
    sources: [
      { resource: "../../src/card-*", track: "structure" },
      { resource: "../../docs/card-*" },
    ],
  });
  await git(root, "add", "src", "docs");
  await git(root, "commit", "-m", "prefix fixture");
  const repository = await readWorkspaceScanRepository(root);
  const before = await snapshot(root);
  const report = await scanWorkspace(adapter, root, repository, async (filename, heading) => {
    assert.ok(!filename.includes("*"));
    return scanFileKind(filename, heading);
  });
  assert.deepEqual(report.inspectionErrors, []);
  assert.equal(report.coverage.coveredFiles, 3);
  assert.deepEqual(report.coverage.uncoveredFiles, ["src/cardinal.ts"]);
  assert.deepEqual(await snapshot(root), before);
});

test("CLI scan summarizes facts without changing Git/Tent bytes and limits text only", async (t) => {
  const { root, write, node } = await fixture(t);
  for (let i = 0; i < 28; i++) await write(`dir${String(i).padStart(2, "0")}/doc.md`);
  await node("pointer", { resource: "../../dir00/" });
  await git(root, "add", ".");
  await git(root, "commit", "-m", "docs");
  await write("dir01/doc.md", "edited");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "one directory");
  await write("new.markdown");
  await write("dir02/doc.md", "uncommitted edit");
  const before = await snapshot(root);
  const first = await runWorkspaceCommand("scan", [], { workspace: root });
  const second = await runWorkspaceCommand("scan", [], { workspace: root });
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  const lines = first.stdout.trimEnd().split("\n");
  assert.ok(lines.length <= 24);
  assert.equal(lines.filter((line) => line.startsWith("uncovered ")).length, 3);
  assert.match(first.stdout, /all-facts tent workspace scan --json\n$/);
  const json = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(json.exitCode, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.coverage.directories.length, 27);
  assert.ok(!report.coverage.uncoveredFiles.includes("new.markdown"));
  assert.deepEqual(Object.keys(report).sort(), [
    "coverage",
    "dependencies",
    "flatDirectories",
    "generatedDirectories",
    "guidanceFiles",
    "head",
    "imports",
    "inspectionErrors",
  ]);
  assert.ok(
    report.dependencies.every(
      (graph: object) => !Object.prototype.hasOwnProperty.call(graph, "layers"),
    ),
  );
  assert.equal(first.stdout, formatWorkspaceScan(report) + "\n");
  assert.deepEqual(await snapshot(root), before);
});

test("material coverage preserves section addresses independently of body links and deprecated Nodes", async (t) => {
  const { root, adapter, write, node } = await fixture(t);
  for (const file of [
    "README.md",
    "docs/direct.md",
    "docs/transitive.md",
    "docs/broken.md",
    "docs/ambiguous.md",
    "docs/deprecated.md",
    "docs/material.md",
  ])
    await write(file, "# Part\n");
  await write("README.md", "[indirect](docs/transitive.md)\n");
  await write("docs/ambiguous.md", "# Part\nfirst\n# Part\nsecond\n");
  await node(
    "links",
    {
      resource: "../../README.md",
      sources: [{ resource: "../../docs/material.md#Missing" }],
    },
    "[valid](../../docs/direct.md#Part)\n[invalid](../../docs/broken.md#Missing)\n[ambiguous](../../docs/ambiguous.md#Part)\n[missing](../../docs/missing.md)\n[external](https://example.invalid/docs/transitive.md)",
  );
  await node("old", { status: "deprecated" }, "[old](../../docs/deprecated.md#Part)");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "document pointers");
  const before = await snapshot(root);
  const result = await scanWorkspace(
    adapter,
    root,
    await readWorkspaceScanRepository(root),
    scanFileKind,
  );
  assert.deepEqual(result.inspectionErrors, []);
  assert.equal(result.coverage.coveredFiles, 2);
  assert.deepEqual(result.coverage.uncoveredFiles, [
    "docs/ambiguous.md",
    "docs/broken.md",
    "docs/deprecated.md",
    "docs/direct.md",
    "docs/transitive.md",
  ]);
  assert.equal(await scanFileKind(path.join(root, "docs/direct.md"), "Part"), "file");
  assert.equal(await scanFileKind(path.join(root, "docs/broken.md"), "Missing"), undefined);
  assert.equal(await scanFileKind(path.join(root, "docs/ambiguous.md"), "Part"), undefined);
  assert.deepEqual(await snapshot(root), before);
});

test("scan reports source facts with no writes and never follows tracked source symlinks", async (t) => {
  const { root, write } = await fixture(t);
  await write("src/app/main.ts", "import '../core/value.js';\n");
  await write("src/core/value.ts", "export const value = 1;\n");
  await write("AGENTS.md", "Project instructions\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "sources");
  const before = await snapshot(root);
  const first = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(first.exitCode, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.deepEqual(report.imports.edges, [
    {
      from: "src/app/main.ts",
      to: "src/core/value.ts",
      kind: "file",
      specifier: "../core/value.js",
    },
  ]);
  assert.deepEqual(report.guidanceFiles, ["AGENTS.md"]);
  assert.deepEqual(await snapshot(root), before);
  assert.equal(
    (await runWorkspaceCommand("scan", ["--json"], { workspace: root })).stdout,
    first.stdout,
  );
  // A junction is available without symlink privilege on Windows. The source reader must
  // stop at that directory, not read another workspace through a tracked file path.
  const other = await fs.mkdtemp(path.join(testScratchRoot(), "scan-source-target-"));
  t.after(() => fs.rm(other, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await fs.writeFile(path.join(other, "value.ts"), "export const secret = 'outside';");
  await fs.rename(path.join(root, "src/core"), path.join(root, "src/original-core"));
  await fs.symlink(
    other,
    path.join(root, "src/core"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const blocked = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(blocked.exitCode, 1);
  const blockedReport = JSON.parse(blocked.stdout);
  assert.ok(
    blockedReport.inspectionErrors.some(
      (error: { node: string; reason: string }) =>
        error.node === "src/core/value.ts" && /plain directory/.test(error.reason),
    ),
  );
  assert.ok(!blocked.stdout.includes("outside"));
  await fs.unlink(path.join(root, "src/core"));
});

test("scan never executes a configured Git clean filter for uncommitted Markdown", async (t) => {
  const { root, adapter, write } = await fixture(t);
  await write("doc.md", "before\n");
  await write(".gitattributes", "*.md filter=scan-probe\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "filter fixture");
  await write(
    "filter.mjs",
    "import fs from 'node:fs';fs.writeFileSync('filter-ran','yes');process.stdout.write(fs.readFileSync(0));",
  );
  await git(root, "config", "filter.scan-probe.clean", "node filter.mjs");
  await write("doc.md", "after\n");
  const before = await snapshot(root);
  const result = await scanWorkspace(
    adapter,
    root,
    await readWorkspaceScanRepository(root),
    scanFileKind,
  );
  assert.deepEqual(result.coverage.uncoveredFiles, [".gitattributes", "doc.md"]);
  assert.deepEqual(await snapshot(root), before);
});

test("scan supports unborn Git and nested workspaces with tracked filenames", async (t) => {
  const { root, write } = await fixture(t);
  await write("new.md");
  const unborn = await readWorkspaceScanRepository(root);
  assert.equal(unborn.head, null);
  assert.deepEqual(unborn.trackedFiles, []);
  assert.ok(!Object.prototype.hasOwnProperty.call(unborn, "commits"));
  await write("nested/source file.md");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "source");
  await git(root, "config", "log.showRoot", "false");
  await git(root, "config", "log.showSignature", "true");
  const nested = await readWorkspaceScanRepository(path.join(root, "nested"));
  assert.deepEqual(nested.trackedFiles, ["source file.md"]);
  assert.deepEqual(
    nested.sources.files.map((source) => source.path),
    ["source file.md"],
  );
  if (process.platform === "win32")
    assert.deepEqual(await readWorkspaceScanRepository(path.join(root, "NESTED")), nested);
});

test("scan JSON preserves repository facts and a diagnostic for invalid TypeScript paths", async (t) => {
  const { root, write } = await fixture(t);
  await write("tsconfig.json", '{"compilerOptions":{"paths":{"@app/*":42}}}');
  await write("src/main.ts", 'import "@app/helper"; import "./helper";\n');
  await write("src/helper.ts", "export {};\n");
  await git(root, "add", "tsconfig.json", "src");
  await git(root, "commit", "-m", "invalid path configuration");
  const before = await snapshot(root);
  const result = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.coverage.trackedFiles, 3);
  assert.equal(report.imports.scannedFiles, 2);
  assert.deepEqual(report.imports.edges, [
    { from: "src/main.ts", to: "src/helper.ts", kind: "file", specifier: "./helper" },
  ]);
  assert.deepEqual(report.imports.issues, [
    { file: "tsconfig.json", reason: "Invalid TypeScript path configuration" },
  ]);
  assert.deepEqual(await snapshot(root), before);
});

test("scan rejects removed history flags and incompatible options before reading workspaces", async () => {
  for (const value of ["1", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", ""]) {
    const result = await runWorkspaceCommand("scan", [`--commits=${value}`], {
      workspace: path.resolve(".scratch/no-workspace"),
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unknown option '--commits'/);
  }
  assert.match(
    (await runWorkspaceCommand("brief", ["--commits", "2"])).stderr,
    /Unknown option '--commits'/,
  );
  assert.equal((await runWorkspaceCommand("scan", ["--limit", "2"])).exitCode, 1);
  const help = await runWorkspaceCommand("scan", ["--help"], {
    workspace: path.resolve(".scratch/no-workspace"),
  });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /workspace scan \[--json\]/);
  assert.ok(!help.stdout.includes("--commits"));
});

test("scan fails explicitly without Workspace Git and reports invalid Node inspection", async (t) => {
  const { root, write, node } = await fixture(t, false);
  await write(".git", "gitdir: ./missing-repository\n");
  assert.equal((await runWorkspaceCommand("scan", [], { workspace: root })).exitCode, 1);
  await fs.unlink(path.join(root, ".git"));
  await git(root, "init", "-b", "main");
  await write("doc.md");
  await node("invalid", { resource: "../../../../doc.md" });
  const result = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).inspectionErrors.length, 1);
  await node("directoryfile", { resource: "../../doc.md/" });
  const mismatch = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(mismatch.exitCode, 1);
  assert.equal(JSON.parse(mismatch.stdout).inspectionErrors.length, 2);
  await new NodeFs(path.join(root, ".tent")).writeFile("order.json", "{");
  const before = await snapshot(root);
  const brokenOrder = await runWorkspaceCommand("scan", [], { workspace: root });
  assert.equal(brokenOrder.exitCode, 1);
  assert.match(brokenOrder.stderr, /explicit repair/);
  assert.deepEqual(await snapshot(root), before);
});
