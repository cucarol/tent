import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import {
  scanCochange,
  scanWorkspace,
  formatWorkspaceScan,
  type ScanCommit,
} from "../src/core/workspace-scan.js";
import {
  readWorkspaceScanRepository,
  scanFileKind,
  parseScanGitLog,
} from "../src/fs/workspace-scan.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext, initializeGit = true) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "workspace-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  if (initializeGit) await git(root, "init", "-b", "main");
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

function commit(id: string, files: string[], changedFiles = files.length): ScanCommit {
  return { commit: id, files, changedFiles };
}

test("cochange closes shared groups, excludes hubs/bulk, retains stronger subsets and stable ties", () => {
  const commits = [
    commit("03", ["a", "b", "c", "hub"]),
    commit("02", ["c", "b", "a", "hub"]),
    commit("01", ["a", "b", "hub"]),
    commit("d2", ["d", "e", "hub"]),
    commit("d1", ["e", "d", "hub"]),
    ...Array.from({ length: 15 }, (_, i) => commit(`single-${i}`, [`single-${i}`])),
    commit("bulk", ["a", "b", "c", "d", "e", "hub"], 26),
  ];
  const result = scanCochange(commits);
  assert.equal(result.hubCommitThreshold, 4);
  assert.deepEqual(result.hubs, [{ file: "hub", count: 5 }]);
  assert.deepEqual(result.excludedCommits, [{ commit: "bulk", changedFiles: 26 }]);
  assert.deepEqual(result.groups, [
    { files: ["a", "b"], count: 3, commits: ["01", "02", "03"] },
    { files: ["a", "b", "c"], count: 2, commits: ["02", "03"] },
    { files: ["d", "e"], count: 2, commits: ["d1", "d2"] },
  ]);
  assert.deepEqual(
    scanCochange(commits.map((c) => ({ ...c, files: [...c.files].reverse() }))),
    result,
  );
  assert.equal(scanCochange([commit("once", ["x", "y"])]).groups.length, 0);
  assert.equal(scanCochange([commit("exact-limit", ["x"], 25)]).excludedCommits.length, 0);
  const many = scanCochange(
    Array.from({ length: 24 }, (_, index) =>
      commit(String(index), [
        `pair${Math.floor(index / 2)}/a.ts`,
        `pair${Math.floor(index / 2)}/b.ts`,
      ]),
    ),
  );
  assert.equal(many.groups.length, 12);
  const resultText = formatWorkspaceScan({
    head: null,
    commitLimit: 300,
    commitsScanned: 24,
    coverage: { trackedFiles: 0, coveredFiles: 0, uncoveredFiles: [], directories: [] },
    cochange: many,
    hotspots: [],
    unpointedDocuments: ["docs/line\nbreak.md", "docs/paragraph\u2029.md"],
    unpointedDirectories: [{ directory: "docs", count: 2 }],
    inspectionErrors: [],
  });
  assert.equal(resultText.split("\n").filter((line) => line.startsWith("cochange ")).length, 10);
  assert.equal(resultText.split("\n").filter((line) => line.startsWith("unpointed ")).length, 2);
  assert.match(resultText, /line\\nbreak\.md/);
  assert.match(resultText, /paragraph\\u2029\.md/);
});

test("scan separates material coverage from document pointers and respects directory boundaries", async (t) => {
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
  repository.commits.push(
    commit("bulk", ["src/core/a.ts", "src/core/nested/b.ts", "docs/no.md"], 26),
  );
  const before = await snapshot(root);
  const result = await scanWorkspace(adapter, root, repository, scanFileKind);
  assert.deepEqual(result.inspectionErrors, []);
  assert.equal(result.coverage.coveredFiles, 6);
  assert.ok(result.coverage.uncoveredFiles.includes("src/core-other/c.ts"));
  assert.ok(result.coverage.uncoveredFiles.includes("docs/body.md"));
  assert.ok(!result.coverage.uncoveredFiles.includes("gone/x.ts"));
  assert.deepEqual(result.unpointedDocuments, [
    "draft.md",
    "docs/gone.md",
    "docs/no.md",
    "docs/quoted.md",
  ]);
  assert.ok(!repository.markdownFiles.some((file) => file.startsWith(".tent/")));
  assert.ok(result.hotspots.some((item) => item.directory === "docs" && item.count === 2));
  assert.ok(result.cochange.excludedCommits.some((item) => item.commit === "bulk"));
  assert.deepEqual(await snapshot(root), before);
  assert.equal(
    JSON.stringify(await scanWorkspace(adapter, root, repository, scanFileKind)),
    JSON.stringify(result),
  );
});

test("CLI scan reads all four segments without changing Git/Tent bytes and limits text only", async (t) => {
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
  const sections = first.stdout.trimEnd().split("\n\n");
  assert.equal(sections.length, 4);
  assert.equal(sections[0]!.split("\n").length, 15);
  assert.ok(sections[2]!.split("\n").every((line) => line.startsWith("hotspot ")));
  assert.equal(sections[2]!.split("\n").length, 10);
  assert.match(sections[3]!, /unpointed new.markdown/);
  assert.match(sections[3]!, /^unpointed-total 28\n/);
  assert.match(sections[3]!, /unpointed-directory 1 dir01/);
  assert.match(sections[3]!, /unpointed-all tent workspace scan --json$/);
  assert.equal(sections[3]!.split("\n").filter((line) => line.startsWith("unpointed ")).length, 20);
  const json = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  assert.equal(json.exitCode, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.coverage.directories.length, 28);
  assert.equal(report.hotspots.length, 29);
  assert.equal(report.unpointedDocuments.length, 28);
  assert.deepEqual(report.unpointedDocuments.slice(0, 3), [
    "new.markdown",
    "dir01/doc.md",
    "dir02/doc.md",
  ]);
  assert.equal(first.stdout, formatWorkspaceScan(report) + "\n");
  const limited = JSON.parse(
    (await runWorkspaceCommand("scan", ["--commits", "1", "--json"], { workspace: root })).stdout,
  );
  assert.equal(limited.commitsScanned, 1);
  assert.deepEqual(limited.hotspots, [{ directory: "dir01", count: 1 }]);
  assert.deepEqual(await snapshot(root), before);
});

test("document pointers are direct, existing section links and include deprecated Nodes", async (t) => {
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
  assert.deepEqual(result.unpointedDocuments, [
    "docs/ambiguous.md",
    "docs/broken.md",
    "docs/material.md",
    "docs/transitive.md",
  ]);
  assert.deepEqual(result.unpointedDirectories, [{ directory: "docs", count: 4 }]);
  assert.deepEqual(await snapshot(root), before);
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
  assert.deepEqual(result.unpointedDocuments, ["doc.md"]);
  assert.deepEqual(await snapshot(root), before);
});

test("scan supports unborn Git, nested workspaces, spaces and newline-safe log parsing", async (t) => {
  const { root, write } = await fixture(t);
  await write("new.md");
  const unborn = await readWorkspaceScanRepository(root);
  assert.equal(unborn.head, null);
  assert.deepEqual(unborn.commits, []);
  assert.ok(unborn.markdownFiles.includes("new.md"));
  await write("nested/source file.md");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "source");
  await git(root, "config", "log.showRoot", "false");
  await git(root, "config", "log.showSignature", "true");
  const nested = await readWorkspaceScanRepository(path.join(root, "nested"));
  assert.deepEqual(nested.trackedFiles, ["source file.md"]);
  assert.deepEqual(nested.commits[0]!.files, ["source file.md"]);
  assert.equal(nested.commits[0]!.changedFiles, 3);
  if (process.platform === "win32")
    assert.deepEqual(await readWorkspaceScanRepository(path.join(root, "NESTED")), nested);
  const sha = "a".repeat(40),
    next = "b".repeat(40);
  assert.deepEqual(parseScanGitLog(`\0${sha}\0\n\nleading.md\0${next}\0\0${next}\0`), [
    commit(sha, ["\nleading.md", next]),
    commit(next, []),
  ]);
});

test("scan rejects invalid commit counts and incompatible options before reading workspaces", async () => {
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", ""]) {
    const result = await runWorkspaceCommand("scan", [`--commits=${value}`], {
      workspace: path.resolve(".scratch/no-workspace"),
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--commits must be a positive safe integer/);
  }
  assert.match(
    (await runWorkspaceCommand("brief", ["--commits", "2"])).stderr,
    /only valid for workspace scan/,
  );
  assert.equal((await runWorkspaceCommand("scan", ["--limit", "2"])).exitCode, 1);
  const help = await runWorkspaceCommand("scan", ["--help"], {
    workspace: path.resolve(".scratch/no-workspace"),
  });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /workspace scan \[--commits <n>\]/);
});

test("scan counts gitlink changes even when Git is configured to ignore submodules", async (t) => {
  const { root, write } = await fixture(t);
  await write("doc.md");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "source");
  const first = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "update-index", "--add", "--cacheinfo", `160000,${first},vendor/mod`);
  await git(root, "commit", "-m", "add gitlink");
  const before = await readWorkspaceScanRepository(root);
  assert.deepEqual(before.commits[0]!.files, ["vendor/mod"]);
  await git(root, "config", "diff.ignoreSubmodules", "all");
  assert.deepEqual(await readWorkspaceScanRepository(root), before);
});

test("scan refuses missing partial-clone trees without fetching or writing Git state", async (t) => {
  const { root, write } = await fixture(t);
  await write("doc.md");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "source");
  await git(root, "config", "uploadpack.allowFilter", "true");
  const partial = await fs.mkdtemp(path.join(testScratchRoot(), "scan-partial-"));
  t.after(() => fs.rm(partial, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await git(
    root,
    "clone",
    "--filter=tree:0",
    "--no-checkout",
    "--no-local",
    pathToFileURL(root).href,
    partial,
  );
  const before = await snapshot(partial);
  await assert.rejects(
    readWorkspaceScanRepository(partial),
    /bad tree object|unable to read tree|could not read/i,
  );
  assert.deepEqual(await snapshot(partial), before);
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
