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
import { readModuleDependencies } from "../src/core/graph/module-dependencies.js";
import type { WorkspaceScanResult } from "../src/core/check/workspace-scan.js";
import { nodeWriteBatchInputSchema } from "../src/core/write/node-write-batch.js";
import { loadTent } from "../src/core/store/tree.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runRoleCommand } from "../src/cli/role-commands.js";
import { runCardCommand } from "../src/cli/card-commands.js";
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
  execution: "module-load" as const,
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

test("non-load imports cannot merge directories, attract flat members or attach root code", () => {
  for (const execution of ["deferred", "type-only", "compile-time"] as const) {
    const cross = [edge("a/one.ts", "b/two.ts"), edge("b/two.ts", "a/one.ts")];
    const directories = ["a/one.ts", "b/two.ts"];
    assert.equal(check(scan(directories, cross)).check.modules.length, 1);
    const classified = cross.map((edge) => ({ ...edge, execution }));
    assert.deepEqual(
      draftWorkspaceModules(scan(directories, classified)).batch,
      draftWorkspaceModules(scan(directories)).batch,
    );
    const flat = Array.from({ length: 22 }, (_, i) => `lib/part${String(i).padStart(2, "0")}.ts`);
    const affinity = [edge(flat[0]!, flat[21]!), edge(flat[21]!, flat[0]!)];
    assert.notDeepEqual(
      draftWorkspaceModules(scan(flat, affinity)).batch,
      draftWorkspaceModules(scan(flat)).batch,
    );
    assert.deepEqual(
      draftWorkspaceModules(
        scan(
          flat,
          affinity.map((edge) => ({ ...edge, execution })),
        ),
      ).batch,
      draftWorkspaceModules(scan(flat)).batch,
    );
    const roots = ["entry.ts", "lib/main.ts"];
    assert.deepEqual(
      draftWorkspaceModules(scan(roots, [{ ...edge(roots[0]!, roots[1]!), execution }])).batch,
      draftWorkspaceModules(scan(roots)).batch,
    );
  }
});

test("parsed Python guards and function imports do not form a draft or checked loading cycle", () => {
  const files = ["a", "b"].flatMap((dir) =>
    Array.from({ length: 3 }, (_, i) => `${dir}/part${i}.py`),
  );
  for (const context of ["type-only", "deferred", "module-load"] as const) {
    const sources = files.map((file) => {
      const number = /part(\d)/.exec(file)![1]!;
      const statement = `from a.part${number} import value`;
      return {
        path: file,
        content: file.startsWith("a/")
          ? `from b.part${number} import value`
          : context === "type-only"
            ? `from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    ${statement}\n`
            : context === "deferred"
              ? `def load():\n    ${statement}\n`
              : statement,
      };
    });
    const facts = repositoryFacts(sources);
    assert.equal(facts.imports.edges.length, 6);
    assert.ok(
      facts.imports.edges
        .filter((edge) => edge.from.startsWith("b/"))
        .every((edge) => edge.execution === context),
    );
    const { check: drafted } = check(scan(files, facts.imports.edges));
    assert.equal(drafted.modules.length, context === "module-load" ? 1 : 2);
    const report = checkModuleMap({
      trackedFiles: files,
      imports: facts.imports.edges,
      commits: [],
      nodes: ["a", "b"].map((dir) => ({
        id: dir,
        name: dir,
        path: dir,
        body: "",
        materials: [{ path: dir, kind: "directory", track: "structure" }],
      })),
    });
    assert.equal(
      report.issues.filter((issue) => issue.code === "deps.cycle").length,
      context === "module-load" ? 1 : 0,
    );
  }
});

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
  assert.ok(
    draft.batch.items.every(
      (item) => item.op === "create" && item.type === "goal" && item.tags === undefined,
    ),
  );
});

test("draft groups a flat directory by imports, keeps the actual cycle and creates small child goals", () => {
  const files = ["a", "b", "c", "d"].flatMap((group) =>
    Array.from({ length: 8 }, (_, i) => `lib/${group}-${i}.ts`),
  );
  const edges = [
    edge("lib/a-0.ts", "lib/b-0.ts"),
    edge("lib/b-0.ts", "lib/c-0.ts"),
    edge("lib/c-0.ts", "lib/a-0.ts"),
  ];
  const { draft, check: report } = check(scan(files, edges));
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  const cycle = report.modules.find((module) => module.files.includes("lib/a-0.ts"))!;
  assert.ok(cycle.files.includes("lib/b-0.ts"));
  assert.ok(cycle.files.includes("lib/c-0.ts"));
  assert.ok(draft.batch.items.some((item) => item.op === "create" && item.parent));
  assert.deepEqual(
    draftWorkspaceModules(scan([...files].reverse(), [...edges].reverse())).batch,
    draft.batch,
  );
  assert.equal(
    report.issues.some((issue) =>
      ["map.uncovered", "map.unowned", "deps.cycle"].includes(issue.code),
    ),
    false,
  );
});

test("draft splits a large dense import cycle without losing files or suppressing cross-part facts", () => {
  const files = Array.from({ length: 53 }, (_, i) => `lib/part-${String(i).padStart(2, "0")}.py`);
  files.push("lib/test_part-00.py");
  const sources = files.slice(0, -1);
  const edges = sources.flatMap((from) =>
    sources.filter((to) => from !== to).map((to) => edge(from, to)),
  );
  const input = scan(files, edges);
  const { draft, check: report } = check(input);
  assert.equal(
    report.modules.reduce((sum, module) => sum + module.productionFiles, 0),
    53,
  );
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  assert.equal(report.modules.filter((module) => module.productionFiles > 0).length, 6);
  assert.deepEqual(report.modules.flatMap((module) => module.files).sort(), [...files].sort());
  assert.ok(
    report.modules.find((module) => module.files.includes(files[0]!))!.files.includes(files[53]!),
  );
  assert.ok(report.issues.some((issue) => issue.code === "deps.cycle"));
  assert.ok(
    !report.issues.some((issue) => issue.code === "map.unowned" || issue.code === "map.uncovered"),
  );
  assert.ok(draft.batch.items.every((item) => item.op === "create" && item.body === ""));
  assert.deepEqual(
    draftWorkspaceModules(scan([...files].reverse(), [...edges].reverse())).batch,
    draft.batch,
  );
});

test("cross-directory cycles cannot reassemble small leaves beyond the draft target", () => {
  const files = ["render", "layout", "style"].flatMap((group) =>
    Array.from({ length: 8 }, (_, i) => `src/${group}/part${i}.ts`),
  );
  const edges = files.flatMap((from) =>
    files.filter((to) => from !== to).map((to) => edge(from, to)),
  );
  const { draft, check: report } = check(scan(files, edges));
  assert.equal(
    report.modules.reduce((sum, module) => sum + module.productionFiles, 0),
    24,
  );
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  assert.equal(draft.nodes.filter((node) => node.parentId).length, 3);
  assert.ok(report.issues.some((issue) => issue.code === "deps.cycle"));
});

test("draft keeps directory layers and nearby tests while bounding a flat Python leaf", () => {
  const names = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
    "mike",
    "november",
    "oscar",
    "papa",
    "quebec",
    "romeo",
    "sierra",
    "tango",
    "uniform",
  ];
  const files = names.map((name) => `src/package/${name}.py`);
  files.push(
    "src/other/app.py",
    "src/package/test_alpha.py",
    "src/package/alpha.test.ts",
    "src/README.md",
  );
  const { draft, check: report } = check(
    scan(files, [edge("src/package/alpha.py", "src/package/uniform.py")]),
  );
  assert.deepEqual(report.issues, []);
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  const alpha = report.modules.find((module) => module.files.includes("src/package/alpha.py"))!;
  assert.ok(
    alpha.files.includes("src/package/uniform.py"),
    "import affinity outranks alphabetical order",
  );
  assert.ok(alpha.files.includes("src/package/test_alpha.py"));
  assert.ok(alpha.files.includes("src/package/alpha.test.ts"));
  const leaf = draft.nodes.find((node) => node.id === alpha.id)!;
  const parent = draft.nodes.find((node) => node.id === leaf.parentId)!;
  assert.ok(parent.parentId, "src -> package -> flat group retains two levels");
  assert.ok(
    draft.batch.items.every(
      (item) => item.op === "create" && item.type === "goal" && item.body === "",
    ),
  );
});

test("draft splits a genuine large cycle to meet its size target", () => {
  const files = Array.from({ length: 15 }, (_, i) => `lib/file${i}.ts`);
  const edges = files.map((file, i) => edge(file, files[(i + 1) % files.length]!));
  const { draft, check: report } = check(scan(files, edges));
  assert.equal(report.modules.length, 3);
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  assert.equal(
    report.modules.reduce((sum, module) => sum + module.productionFiles, 0),
    15,
  );
  assert.deepEqual(draft.warnings, []);
});

test("many root entries cannot grow a unique imported leaf beyond the draft size target", () => {
  const roots = Array.from({ length: 24 }, (_, i) => `entry${i}.ts`);
  const { draft, check: report } = check(
    scan(
      ["lib/shared.ts", ...roots],
      roots.map((file) => edge(file, "lib/shared.ts")),
    ),
  );
  assert.deepEqual(report.issues, []);
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  assert.match(draft.warnings.join("\n"), /import owner at draft size target/);
});

test("draft groups cross-directory cycles at their common parent and keeps all ownership", () => {
  const files = [
    "src/a/one.ts",
    "src/b/two.ts",
    ...Array.from({ length: 11 }, (_, i) => `src/c/file${i}.ts`),
  ];
  const { draft, check: report } = check(
    scan(files, [edge(files[0]!, files[1]!), edge(files[1]!, files[0]!)]),
  );
  assert.deepEqual(report.issues, []);
  const cycle = report.modules.find((module) => module.files.includes(files[0]!))!;
  assert.ok(cycle.files.includes(files[1]!));
  assert.ok(draft.nodes.find((node) => node.id === cycle.id)!.parentId);
});

test("draft preserves generated siblings without attaching them to a different flat group", () => {
  const files = [
    "lib/api.ts",
    "lib/api.pb.ts",
    "lib/api_pb.ts",
    ...Array.from({ length: 20 }, (_, i) => `lib/file${i}.ts`),
  ];
  const { check: report } = check(scan(files));
  const api = report.modules.find((module) => module.files.includes("lib/api.ts"))!;
  assert.ok(api.files.includes("lib/api.pb.ts"));
  assert.ok(api.files.includes("lib/api_pb.ts"));
  assert.deepEqual(report.issues, []);
});

test("draft splits large Go packages by filename while imports keep the package directory owner", () => {
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
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  assert.equal(report.modules.find((module) => module.name === "store")!.productionFiles, 0);
});

test("draft splits a large root Go package and Java package without manufacturing a package cycle", () => {
  const files = ["read", "write"].flatMap((group) =>
    Array.from({ length: 12 }, (_, i) => `${group}_${i}.go`),
  );
  files.push(
    "cmd/main.go",
    ...["Read", "Write"].flatMap((group) =>
      Array.from({ length: 12 }, (_, i) => `java/pkg/${group}Handler${i}.java`),
    ),
  );
  const { draft, check: report } = check(scan(files, [edge("cmd/main.go", ".", "directory")]));
  assert.deepEqual(report.unassignedImports, []);
  assert.deepEqual(report.issues, []);
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
  assert.ok(draft.nodes.some((node) => node.name === "Root Go package" && !node.parentId));
});

test("draft uses valid top-level names and percent-encodes literal material paths", () => {
  const { draft, check: report } = check(
    scan(["con.ts", "cards/a.ts", "roles/a.ts", "data space/a#b.ts", "docs/100%.md"]),
  );
  assert.equal(report.issues.length, 0);
  const text = JSON.stringify(draft.batch);
  assert.match(text, /Module con.ts/);
  assert.match(text, /Module cards/);
  assert.match(text, /Module roles/);
  assert.match(text, /data%20space/);
  assert.ok(!text.includes('"resource":"src/'));
});

test("an empty repository rejects draft creation without writing a batch", async (t) => {
  const { root } = await fixture(t);
  const before = await snapshot(root);
  const result = await runWorkspaceCommand("scan", ["--draft", ".scratch/empty.json", "--json"], {
    workspace: root,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /No tracked Workspace materials/);
  assert.deepEqual(await snapshot(root), before);
});

test("mixed-case operational names yield a directly writable top-level draft", async (t) => {
  const { root, adapter, write } = await fixture(t);
  await git(path.join(root, ".tent"), "init", "-b", "main");
  const options = { workspace: root, json: true };
  const role = await runRoleCommand("create", ["--title", "Owner"], options);
  assert.equal(role.exitCode, 0, role.stderr);
  const roleId = JSON.parse(role.stdout).roleId;
  const card = await runCardCommand("create", ["--prompt", "Keep", "--target", roleId], options);
  assert.equal(card.exitCode, 0, card.stderr);
  const originalRole = await adapter.readFile(`roles/${roleId}.md`);
  for (const name of ["Cards", "Roles", "TEMP", "Attachments"]) await write(`${name}/part.ts`);
  await git(root, "add", "Cards", "Roles", "TEMP", "Attachments");
  const scanned = await runWorkspaceCommand(
    "scan",
    ["--draft", ".scratch/batch.json", "--json"],
    options,
  );
  assert.equal(scanned.exitCode, 0, scanned.stderr);
  const batch = await fs.readFile(path.join(root, ".scratch/batch.json"), "utf8");
  const written = await runNodeCommand("write-many", ["--input-json", "-", "--json"], {
    ...options,
    stdin: batch,
  });
  assert.equal(written.exitCode, 0, written.stderr);
  assert.equal(await adapter.readFile(`roles/${roleId}.md`), originalRole);
  assert.equal((await loadTent(adapter)).byPath.size, 4);
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
  assert.ok(batch.items.every((item) => item.op === "create" && !item.parent));
  assert.ok(!batch.items.some((item) => item.op === "create" && item.ref === "map"));
  const first = batch.items[0];
  if (first.op === "create") first.name = "Renamed code";
  const written = await runNodeCommand("write-many", ["--input-json", "-", "--json"], {
    workspace: root,
    stdin: JSON.stringify(batch),
  });
  assert.equal(written.exitCode, 0, written.stderr);
  const tree = await loadTent(adapter);
  assert.equal(tree.byPath.size, batch.items.length);
  assert.ok([...tree.byPath.keys()].every((nodePath) => !nodePath.includes("/")));
  assert.ok(tree.byPath.has("Renamed code"));
  assert.ok(tree.byPath.has("Setup"));
  assert.ok(tree.byPath.has("Tests"));
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
  const input = scan(
    ["a/one.ts", "b/two.ts", "c/three.ts", "tests/one.test.ts"],
    [edge("tests/one.test.ts", "a/one.ts")],
  );
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
    /history\.always-together.*fix: Keep both modules when their responsibilities differ: declare allow:history\.always-together.*Merge them only when they are one responsibility\./,
  );
  assert.equal(empty.summary.issues.length, 0);
  const a = history.summary.modules.find((module) => module.name === "a")!;
  const b = history.summary.modules.find((module) => module.name === "b")!;
  assert.deepEqual(a.testedBy, ["tests/one.test.ts"]);
  assert.deepEqual(a.coChanges, [
    { moduleId: b.ref, sharedCommits: 5, moduleCommits: 5, ratio: 1 },
  ]);
  assert.match(formatWorkspaceDraft(history.summary), /tested-by.*tests\/one.test.ts/);
  assert.match(formatWorkspaceDraft(history.summary), /co-changes.*sharedCommits/);
  assert.ok(history.batch.items.every((item) => item.op === "create" && item.body === ""));
});

test("hierarchical draft writes once after renaming a parent and preserves child ownership", async (t) => {
  const { root, adapter, write } = await fixture(t);
  for (let i = 0; i < 23; i++) await write(`src/library/file${i}.ts`);
  await write("src/entry/main.ts", 'import "../library/file0";');
  await write("README.md", "# Layered project");
  await write("go.mod", "module example.com/app\n");
  for (const group of ["read", "write"])
    for (let i = 0; i < 12; i++) await write(`${group}_${i}.go`, "package app\n");
  await write("cmd/tool/main.go", 'package main\nimport "example.com/app"\n');
  await git(root, "add", ".");
  const prepared = await runWorkspaceCommand(
    "scan",
    ["--draft", ".scratch/layers.json", "--json"],
    { workspace: root },
  );
  assert.equal(prepared.exitCode, 0, prepared.stderr || prepared.stdout);
  const summary = JSON.parse(prepared.stdout);
  assert.ok(summary.modules.some((module: { parent?: string }) => module.parent));
  const batch = nodeWriteBatchInputSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, ".scratch/layers.json"), "utf8")),
  );
  const parent = batch.items.find((item) => item.op === "create" && item.name === "src")!;
  assert.equal(parent.op, "create");
  if (parent.op === "create") parent.name = "Library product";
  const result = await runNodeCommand("write-many", ["--input-json", "-", "--json"], {
    workspace: root,
    stdin: JSON.stringify(batch),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const repository = await readModuleMapRepository(root);
  const actual = await checkWorkspaceModules(adapter, root, repository);
  assert.deepEqual(actual.issues, []);
  assert.deepEqual(actual.inspectionErrors, []);
  assert.equal(
    actual.modules.reduce((sum, module) => sum + module.productionFiles, 0),
    49,
  );
  assert.ok(actual.modules.every((module) => module.productionFiles <= 10));
  assert.ok(actual.modules.some((module) => module.path.startsWith("Library product/library/")));
  const deps = await readModuleDependencies(adapter, root, {
    basis: { head: repository.head },
    sources: repository.sources.files,
  });
  assert.equal(deps.unresolved, 0);
  const rootPackage = actual.modules.find((module) => module.name === "Root Go package")!;
  const command = actual.modules.find((module) => module.files.includes("cmd/tool/main.go"))!;
  assert.ok(deps.edges.some((edge) => edge.from === command.id && edge.to === rootPackage.id));
});

test("a size-split cycle stays small when the Agent records its linked exception in a child prompt", async (t) => {
  const { root, adapter, write } = await fixture(t);
  const files = Array.from({ length: 12 }, (_, i) => `lib/part${i}.ts`);
  for (const file of files)
    await write(
      file,
      files
        .filter((other) => other !== file)
        .map((other) => `import './${path.basename(other)}';`)
        .join("\n"),
    );
  await git(root, "add", ".");
  const prepared = await runWorkspaceCommand("scan", ["--draft", ".scratch/cycle.json", "--json"], {
    workspace: root,
  });
  assert.equal(
    prepared.exitCode,
    1,
    "the draft exposes a decision for the Agent, not an automatic exception",
  );
  const summary = JSON.parse(prepared.stdout);
  const cycle = summary.issues.find((issue: { code: string }) => issue.code === "deps.cycle");
  assert.ok(cycle);
  assert.ok(
    summary.modules.every((module: { productionFiles: number }) => module.productionFiles <= 10),
  );
  const batch = nodeWriteBatchInputSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, ".scratch/cycle.json"), "utf8")),
  );
  assert.ok(batch.items.every((item) => item.op === "create" && item.body === ""));
  const [first, second] = cycle.facts.nodeIds as string[];
  batch.items.push({
    op: "create",
    ref: "rule",
    parent: `@${first}`,
    name: "Rendering contract",
    type: "prompt",
    body: `allow:deps.cycle [Partner](@${second}) Keep both parts small; coordinate the rendering contract.`,
  });
  const written = await runNodeCommand("write-many", ["--input-json", "-"], {
    workspace: root,
    stdin: JSON.stringify(batch),
  });
  assert.equal(written.exitCode, 0, written.stderr);
  const report = await checkWorkspaceModules(adapter, root, await readModuleMapRepository(root));
  assert.deepEqual(report.issues, []);
  assert.equal(
    report.modules.reduce((sum, module) => sum + module.productionFiles, 0),
    12,
  );
  assert.ok(report.modules.every((module) => module.productionFiles <= 10));
});

test("draft and live module queries derive current Python and script test imports without changing ordinary scan", async (t) => {
  const { root, write } = await fixture(t);
  await write("pkg/alpha.py", "def alpha(): pass\n");
  await write("other/beta.py", "def beta(): pass\n");
  await write("lib/helper.ts");
  await write("tests/test_alpha.py", "from pkg.alpha import alpha\n");
  await write("tests/helper.test.ts", 'import "../lib/helper";');
  await git(root, "add", ".");
  const ordinary = await runWorkspaceCommand("scan", ["--json"], { workspace: root });
  const prepared = await runWorkspaceCommand("scan", ["--draft", ".scratch/tests.json", "--json"], {
    workspace: root,
  });
  assert.equal(prepared.exitCode, 0, prepared.stderr || prepared.stdout);
  const summary = JSON.parse(prepared.stdout);
  assert.deepEqual(
    summary.modules.find((module: { name: string }) => module.name === "pkg").testedBy,
    ["tests/test_alpha.py"],
  );
  assert.deepEqual(
    summary.modules.find((module: { name: string }) => module.name === "lib").testedBy,
    ["tests/helper.test.ts"],
  );
  const batch = await fs.readFile(path.join(root, ".scratch/tests.json"), "utf8");
  const written = await runNodeCommand("write-many", ["--input-json", "-"], {
    workspace: root,
    stdin: batch,
  });
  assert.equal(written.exitCode, 0, written.stderr);
  const before = await snapshot(path.join(root, ".tent"));
  const query = async () => {
    const response = await runWorkspaceCommand("check-modules", ["--json"], { workspace: root });
    assert.equal(response.exitCode, 0, response.stderr || response.stdout);
    return JSON.parse(response.stdout);
  };
  const first = await query();
  assert.deepEqual(
    first.modules.find((module: { name: string }) => module.name === "pkg").testedBy,
    ["tests/test_alpha.py"],
  );
  await write("tests/test_alpha.py", "from other.beta import beta\n");
  const changed = await query();
  assert.deepEqual(
    changed.modules.find((module: { name: string }) => module.name === "pkg").testedBy,
    [],
  );
  assert.deepEqual(
    changed.modules.find((module: { name: string }) => module.name === "other").testedBy,
    ["tests/test_alpha.py"],
  );
  assert.deepEqual(await snapshot(path.join(root, ".tent")), before);
  // Ordinary import facts remain production-only, even while the test source changes.
  const after = JSON.parse(
    (await runWorkspaceCommand("scan", ["--json"], { workspace: root })).stdout,
  );
  assert.deepEqual(after.imports, JSON.parse(ordinary.stdout).imports);
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
