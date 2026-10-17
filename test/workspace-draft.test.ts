import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import type { RepositoryImport } from "../src/core/base/repository-imports.js";
import {
  draftWorkspaceModules,
  prepareWorkspaceDraft,
  formatWorkspaceDraft,
} from "../src/core/check/workspace-draft.js";
import { checkModuleMap } from "../src/core/check/module-map.js";
import { checkWorkspaceModules } from "../src/core/check/workspace-module-map.js";
import type { WorkspaceScanResult } from "../src/core/check/workspace-scan.js";
import { nodeWriteBatchInputSchema } from "../src/core/write/node-write-batch.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { readModuleMapRepository } from "../src/fs/workspace-scan.js";
import { testScratchRoot } from "./scratch.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { git } from "./helpers.js";

function scan(files: string[], edges: RepositoryImport[] = []): WorkspaceScanResult {
  const facts = repositoryFacts(files.map((file) => ({ path: file })));
  return {
    head: null,
    coverage: {
      trackedFiles: files.length,
      coveredFiles: 0,
      uncoveredFiles: files,
      directories: [],
    },
    inspectionErrors: [],
    ...facts,
    imports: { ...facts.imports, edges },
  };
}
const edge = (from: string, to: string, kind: "file" | "directory" = "file"): RepositoryImport => ({
  from,
  to,
  kind,
  specifier: to,
});
function check(input: WorkspaceScanResult) {
  const draft = draftWorkspaceModules(input);
  nodeWriteBatchInputSchema.parse(draft.batch);
  return {
    draft,
    check: checkModuleMap({
      trackedFiles: input.coverage.uncoveredFiles,
      imports: input.imports.edges,
      commits: [],
      nodes: draft.nodes,
    }),
  };
}

test("draft separates tests and generated code, preserves root evidence and stable batch bytes", () => {
  const files = [
    "README.md",
    "src/domain/item.ts",
    "src/adapter/client.ts",
    "index.ts",
    "lonely.ts",
    "tests/item.test.ts",
    "generated/api.pb.ts",
  ];
  const edges = [edge("index.ts", "src/domain/item.ts")];
  const input = scan(files, edges),
    { draft, check: report } = check(input);
  assert.equal(report.issues.length, 0);
  assert.equal(
    report.modules.some((module) => module.name === "Tests"),
    false,
  );
  assert.ok(
    report.modules.some((module) => module.generatedFiles === 1 && module.productionFiles === 0),
  );
  assert.ok(
    report.modules
      .find((module) => module.files.includes("index.ts"))!
      .files.includes("src/domain/item.ts"),
  );
  assert.deepEqual(report.modules.find((module) => module.files.includes("lonely.ts"))!.files, [
    "lonely.ts",
  ]);
  assert.match(draft.warnings.join("\n"), /no unique import owner.*lonely.ts/);
  assert.deepEqual(
    draftWorkspaceModules(scan([...files].reverse(), [...edges].reverse())).batch,
    draft.batch,
  );
  assert.ok(draft.batch.items.every((item) => item.op === "create" && item.body === ""));
});

test("draft splits large flat prefixes and condenses a three-module cycle after splitting", () => {
  const files = ["a", "b", "c", "d"].flatMap((group) =>
    Array.from({ length: 8 }, (_, i) => `lib/${group}-${i}.ts`),
  );
  const edges = [
    edge("lib/a-0.ts", "lib/b-0.ts"),
    edge("lib/b-0.ts", "lib/c-0.ts"),
    edge("lib/c-0.ts", "lib/a-0.ts"),
  ];
  const { check: report } = check(scan(files, edges));
  assert.equal(report.modules.length, 2);
  assert.ok(report.modules.some((module) => module.productionFiles === 24));
  assert.equal(
    report.issues.some((issue) =>
      ["map.uncovered", "map.unowned", "deps.cycle"].includes(issue.code),
    ),
    false,
  );
});

test("draft keeps an imported Go package and the root Go package whole", () => {
  const files = [
    "main.go",
    "options.go",
    "root_test.go",
    "cmd/tool/main.go",
    ...["read", "write"].flatMap((group) =>
      Array.from({ length: 12 }, (_, i) => `store/${group}_${i}.go`),
    ),
  ];
  const input = scan(files, [
    edge("cmd/tool/main.go", "store", "directory"),
    edge("cmd/tool/main.go", ".", "directory"),
  ]);
  const { check: report } = check(input);
  assert.equal(report.unassignedImports.length, 0);
  assert.ok(
    report.modules.some(
      (module) => module.files.includes("main.go") && module.files.includes("options.go"),
    ),
  );
  assert.ok(report.modules.some((module) => module.productionFiles === 24));
});

test("draft uses valid names for reserved device names and percent-encodes literal material paths", () => {
  const { draft, check: report } = check(scan(["con.ts", "data space/a#b.ts", "docs/100%.md"]));
  assert.equal(report.issues.length, 0);
  const text = JSON.stringify(draft.batch);
  assert.match(text, /Module con.ts/);
  assert.match(text, /data%20space/);
  assert.ok(!text.includes('"resource":"src/'));
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "workspace-draft-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await git(root, "init", "-b", "main");
  await fs.appendFile(path.join(root, ".git/info/exclude"), "\n/.tent/\n");
  await scaffoldInWorkspace(new NodeFs(root), { name: "Draft" });
  const adapter = new NodeFs(path.join(root, ".tent"));
  await fs.mkdir(path.join(root, ".scratch"));
  const write = async (file: string, text = "export const value = 1;") => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  return { root, adapter, write };
}
async function snapshot(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = path.join(root, entry.name),
      name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(file, name + "/"));
    else
      result[name] = createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
  }
  return result;
}

test("scan --draft writes only the editable batch; existing write-many produces the same checked map", async (t) => {
  const { root, adapter, write } = await fixture(t);
  await write("src/domain/item.ts");
  await write("src/adapter/client.ts", "import { value } from '../domain/item';");
  await write("README.md", "# Project");
  await write("test/item.test.ts");
  await write("root#note.md", "# Literal filename");
  await write("data space/a%file.ts");
  await git(root, "add", ".");
  const before = await snapshot(root);
  const result = await runWorkspaceCommand("scan", ["--draft", ".scratch/batch.json", "--json"], {
    workspace: root,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.trackedFiles, 6);
  assert.equal(summary.imports, undefined);
  const after = await snapshot(root);
  delete after[".scratch/batch.json"];
  assert.deepEqual(after, before);
  const batch = nodeWriteBatchInputSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, ".scratch/batch.json"), "utf8")),
  );
  // Exercise the CLI material-input boundary, not only the lower-level Core writer.
  const map = batch.items.find((item) => item.op === "create" && item.ref === "map")!;
  if (map.op === "create") map.name = "Renamed modules";
  const written = await runNodeCommand("write-many", ["--input-json", "-", "--json"], {
    workspace: root,
    stdin: JSON.stringify(batch),
  });
  assert.equal(written.exitCode, 0, written.stderr);
  const actual = await checkWorkspaceModules(adapter, root, await readModuleMapRepository(root));
  assert.deepEqual(actual.inspectionErrors, []);
  assert.deepEqual(actual.issues, summary.issues);
  assert.equal(actual.modules.length, summary.modules.length);
  const again = await runWorkspaceCommand("scan", ["--draft", ".scratch/again.json"], {
    workspace: root,
  });
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /Existing Nodes/);
  await assert.rejects(fs.stat(path.join(root, ".scratch/again.json")), { code: "ENOENT" });
});

test("history changes preflight findings, never the draft or native Node state", async (t) => {
  const { adapter } = await fixture(t);
  const input = scan(["a/one.ts", "b/two.ts", "c/three.ts"]);
  const commits = Array.from({ length: 15 }, (_, i) => ({
    commit: String(i),
    files: i < 5 ? ["a/one.ts", "b/two.ts"] : ["c/three.ts"],
    changedFiles: i < 5 ? 2 : 1,
  }));
  const empty = await prepareWorkspaceDraft(adapter, input, []);
  const history = await prepareWorkspaceDraft(adapter, input, commits);
  assert.deepEqual(history.batch, empty.batch);
  assert.ok(history.summary.issues.some((issue) => issue.code === "history.always-together"));
  assert.match(
    formatWorkspaceDraft(history.summary),
    /history.always-together.*fix: Merge these modules/,
  );
  assert.equal(empty.summary.issues.length, 0);
});

test("unresolved imports are one advisory count in draft and module checks, with full JSON diagnostics", async (t) => {
  const { root, write } = await fixture(t);
  await write("tsconfig.json", '{"compilerOptions":{"paths":{"@app/*":42}}}');
  await write("src/main.ts", 'import "@app/helper"; import "./helper";');
  await write("src/helper.ts");
  await git(root, "add", ".");
  const result = await runWorkspaceCommand("scan", ["--draft", ".scratch/batch.json"], {
    workspace: root,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("imports ")).length, 1);
  assert.match(
    result.stdout,
    /imports 1 references Tent could not resolve; they describe the code, not the map/,
  );
  const batch = await fs.readFile(path.join(root, ".scratch/batch.json"), "utf8");
  const written = await runNodeCommand("write-many", ["--input-json", "-"], {
    workspace: root,
    stdin: batch,
  });
  assert.equal(written.exitCode, 0, written.stderr);
  const json = await runWorkspaceCommand("check-modules", ["--json"], { workspace: root });
  assert.equal(json.exitCode, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).importIssues.length, 1);
  assert.deepEqual(JSON.parse(json.stdout).issues, []);
  const text = await runWorkspaceCommand("check-modules", [], { workspace: root });
  assert.equal(text.exitCode, 0);
  assert.equal(text.stdout, "");
  assert.equal(text.stderr.trim().split("\n").length, 1);
  assert.match(text.stderr, /^imports 1 references/);
});

test("draft refuses replacement and .tent destinations, and normal scan remains unchanged", async (t) => {
  const { root, write } = await fixture(t);
  await write("src/a.ts");
  await git(root, "add", ".");
  const ordinary = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  await write(".scratch/batch.json", "keep my edits");
  for (const destination of [".scratch/batch.json", ".tent/draft.json"]) {
    const result = await runWorkspaceCommand("scan", ["--draft", destination], { workspace: root });
    assert.equal(result.exitCode, 1);
  }
  assert.equal(await fs.readFile(path.join(root, ".scratch/batch.json"), "utf8"), "keep my edits");
  assert.deepEqual(await runWorkspaceCommand("scan", ["--json"], { workspace: root }), ordinary);
  const invalid = await runWorkspaceCommand("check", ["--draft", ".scratch/unused.json"], {
    workspace: root,
  });
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr, /only valid/);
});
