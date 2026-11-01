import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { checkGraph, checkSelectedNodes } from "../src/core/check/graph-check.js";
import { formatNodeWriteProblems } from "../src/core/check/node-write-problems.js";
import { serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { checkNativeNodeWrites, checkNodeWriteProblems } from "../src/fs/node-write-problems.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import {
  testScratchRoot,
  initializeFixtureHistory,
  captureFixtureDocuments,
  historyHead,
} from "./scratch.js";
import { scaffoldInWorkspace } from "./scaffold.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-write-problems-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), {
    name: "Problems",
    nodes: [
      { id: "node-selected", name: "Selected", type: "prompt", body: "Clean." },
      { id: "node-other", name: "Other", type: "prompt", body: "Other." },
    ],
  });
  const systemRoot = path.join(root, ".tent");
  const adapter = openTestFs(systemRoot);
  const write = (file: string, data: Record<string, unknown>, body = "") =>
    adapter.writeFile(file, serializeFrontmatter({ type: "prompt", ...data }, body));
  const fileExists = async (filename: string, directory = false) => {
    try {
      const info = await fs.stat(filename);
      return directory ? info.isDirectory() : info.isFile();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  };
  const cli = async (sub: string, args: string[], json = true) => {
    const result = await runNodeCommand(sub, args, { workspace: root, json });
    assert.equal(result.exitCode, 0, result.stderr);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  return { root, systemRoot, adapter, write, fileExists, cli };
}

test("advisory inspection failures preserve successful writes and skip zero-write receipts", async (t) => {
  const { root, systemRoot, cli } = await fixture(t);
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  const original = NodeFs.prototype.retainedDocumentPaths;
  let inspections = 0;
  NodeFs.prototype.retainedDocumentPaths = async () => {
    inspections++;
    throw new Error("Retained storage is unavailable");
  };
  try {
    const saved = await cli("append", ["node-selected", "--body", "Saved content."]);
    assert.deepEqual(saved.problems, [
      {
        category: "error",
        path: ".tent/Selected/Selected.md",
        reason: "Retained storage is unavailable",
      },
    ]);
    assert.match(
      await fs.readFile(path.join(systemRoot, "Selected/Selected.md"), "utf8"),
      /Saved content\./,
    );
    const noop = await cli("rename", ["node-other", "Other"]);
    assert.deepEqual(noop.problems, []);
    assert.equal(inspections, 1);
    const failure = await runNodeCommand(
      "write",
      ["node-selected", "--base-etag", "bad-etag", "--body", "Not saved."],
      { workspace: root, json: true },
    );
    assert.equal(failure.exitCode, 1);
    assert.match(failure.stderr, /ETAG_MISMATCH|changed|ETag/i);
    assert.doesNotMatch(failure.stderr, /Retained storage/);
    assert.equal(inspections, 1);
  } finally {
    NodeFs.prototype.retainedDocumentPaths = original;
  }
});

test("selected Node inspection shares full workspace diagnostics and reads only its body", async (t) => {
  const { root, adapter, write, fileExists } = await fixture(t);
  await fs.writeFile(path.join(root, "material.md"), "# Duplicate\nOne\n# Duplicate\nTwo\n");
  await write(
    "Selected/Selected.md",
    {
      id: "node-selected",
      resource: "../../missing.txt",
      sources: [
        { resource: "../../material.md#Duplicate" },
        { resource: "../../material.md#Absent" },
      ],
    },
    "[broken](node-missing)\n[other](node-other)\n[role](role-good)\n[card](card-good)",
  );
  await write("Other/Other.md", { id: "node-other" }, "[unrelated](node-unrelated)");
  await write("Invalid/Invalid.md", { id: "node-invalid", type: "wrong" }, "[bad](node-bad)");
  await adapter.writeFile(
    "roles/role-good.md",
    serializeFrontmatter({ id: "role-good", type: "role" }, "[bad](node-rolebad)"),
  );
  await adapter.writeFile(
    "cards/card-good.md",
    serializeFrontmatter(
      { id: "card-good", type: "card", schemaVersion: 3, state: "pending", sources: [] },
      "[bad](node-cardbad)",
    ),
  );
  const all = await checkGraph(adapter, root, fileExists);
  const binaryReads: string[] = [];
  const readBinary = adapter.readBinary.bind(adapter);
  adapter.readBinary = async (file) => {
    binaryReads.push(file);
    return readBinary(file);
  };
  const readFile = adapter.readFile.bind(adapter);
  adapter.readFile = async (file) => {
    assert.ok(!file.endsWith(".md"), `Unexpected whole document read: ${file}`);
    return readFile(file);
  };
  const selected = await checkSelectedNodes(adapter, root, fileExists, ["Selected/Selected.md"]);
  assert.equal(selected.documents, 1);
  for (const field of ["issues", "notices", "errors"] as const)
    assert.deepEqual(
      selected[field],
      all[field].filter((item) => item.path === "Selected/Selected.md"),
    );
  assert.deepEqual(binaryReads, ["Selected/Selected.md"]);
  assert.equal(
    selected.issues.filter((issue) => issue.kind === "missing-material-section").length,
    2,
  );
  assert.equal(selected.issues.filter((issue) => issue.kind === "missing-material-file").length, 1);
  assert.equal(selected.issues.filter((issue) => issue.kind === "unresolved-link").length, 1);
});

test("invalid selected YAML and type report the workspace check errors; clean writes stay quiet", async (t) => {
  const { root, adapter, write, fileExists } = await fixture(t);
  await adapter.writeFile("Unrelated/Unrelated.md", "---\nid: [\n---\n");
  assert.deepEqual(await checkNodeWriteProblems(adapter, root, ["Selected/Selected.md"]), []);
  assert.equal(formatNodeWriteProblems([]), "");
  for (const raw of [
    "---\nid: [\n---\n",
    serializeFrontmatter({ id: "node-selected", type: "wrong" }, ""),
  ]) {
    await adapter.writeFile("Selected/Selected.md", raw);
    const selected = await checkSelectedNodes(adapter, root, fileExists, ["Selected/Selected.md"]);
    const all = await checkGraph(adapter, root, fileExists);
    assert.deepEqual(
      selected.errors,
      all.errors.filter((item) => item.path === "Selected/Selected.md"),
    );
    assert.ok(selected.errors.length);
    assert.ok(selected.errors.every((item) => item.path === "Selected/Selected.md"));
  }
  await write("Selected/Selected.md", { id: "node-selected" });
  assert.deepEqual(await checkNodeWriteProblems(adapter, root, ["Selected/Selected.md"]), []);
});

test("native inspection checks canonical written files, retained presence and never captures or recovers", async (t) => {
  const { root, systemRoot, adapter, write } = await fixture(t);
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  const head = await historyHead(systemRoot);
  await write("Fresh/Fresh.md", { id: "node-fresh" }, "[bad](node-missing)");
  await write("Other/Other.md", { id: "node-other" }, "[bad](node-othermissing)");
  const pending = "invalid pending transaction must remain untouched\n";
  await adapter.writeFile("node-move.pending.json", pending);
  const problems = await checkNativeNodeWrites("claude-code", root, [
    ".tent/Fresh/Fresh.md",
    ".tent/index.md",
    ".tent/roles/role-nope.md",
    ".tent/Fresh/attachment.md",
  ]);
  assert.equal(problems.length, 2);
  assert.ok(problems.every((problem) => problem.path === ".tent/Fresh/Fresh.md"));
  assert.ok(
    problems.some(
      (problem) => problem.category === "issue" && problem.kind === "node-git-mismatch",
    ),
  );
  assert.equal(await historyHead(systemRoot), head);
  assert.equal(await adapter.readFile("node-move.pending.json"), pending);
  const rendered = formatNodeWriteProblems(problems);
  assert.match(rendered, /^Tent: \.tent\/Fresh\/Fresh.md has problems:\n- /);
  assert.ok(rendered.endsWith("\nFix them before you end this turn."));
  assert.deepEqual(await checkNativeNodeWrites("codex", root, [".tent/Selected/Selected.md"]), []);
  assert.deepEqual(
    await checkNativeNodeWrites("claude-code", root, [".tent/index.md", "../outside/Outside.md"]),
    [],
  );
  await fs.mkdir(path.join(root, "Outside"));
  await fs.writeFile(path.join(root, "Outside/Outside.md"), "---\nid: [\n---\n");
  await fs.symlink(path.join(root, "Outside"), path.join(systemRoot, "Outside"), "junction");
  assert.deepEqual(
    await checkNativeNodeWrites("claude-code", root, [".tent/Outside/Outside.md"]),
    [],
  );
  await fs.unlink(path.join(systemRoot, "Selected/Selected.md"));
  const missing = await checkNodeWriteProblems(adapter, root, ["Selected/Selected.md"]);
  assert.ok(
    missing.some(
      (problem) =>
        problem.category === "issue" &&
        problem.kind === "node-git-mismatch" &&
        problem.state === "git-only",
    ),
  );
});

test("CLI create, write, append and batch receipts report only their written Nodes without failing saves", async (t) => {
  const { root, systemRoot, adapter, cli } = await fixture(t);
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  // This native edit is collected before the command, but is outside its receipt.
  await adapter.writeFile(
    "Other/Other.md",
    serializeFrontmatter({ id: "node-other", type: "prompt" }, "[unrelated](node-unrelated)"),
  );
  const created = await cli("create", [
    "New",
    "--id",
    "node-new",
    "--type",
    "prompt",
    "--body",
    "[broken](node-create-missing)",
  ]);
  assert.deepEqual(
    created.problems.map((p: { path: string }) => p.path),
    [".tent/New/New.md"],
  );
  assert.equal(created.problems[0].kind, "unresolved-link");
  const read = await cli("get", ["node-new", "--full"]);
  const written = await cli("write", [
    "node-new",
    "--base-etag",
    read.etag,
    "--body",
    "[broken](node-write-missing)",
  ]);
  assert.equal(written.problems[0].target, "node-write-missing");
  const appended = await cli("append", [
    "node-selected",
    "--body",
    "[broken](node-append-missing)",
  ]);
  assert.deepEqual(
    appended.problems.map((p: { path: string }) => p.path),
    [".tent/Selected/Selected.md"],
  );
  const batch = await cli("write-many", [
    "--input-json",
    JSON.stringify({
      items: [
        {
          op: "create",
          ref: "batch",
          name: "Batch",
          type: "prompt",
          body: "[broken](node-batch-missing)",
        },
        { op: "update", nodeId: "node-new", baseEtag: written.etag, body: "Fixed." },
      ],
    }),
  ]);
  assert.deepEqual(
    batch.problems.map((p: { path: string }) => p.path),
    [".tent/Batch/Batch.md"],
  );
  const human = await cli("append", ["node-new", "--body", "[broken](node-human-missing)"], false);
  assert.match(
    human,
    /Tent: \.tent\/New\/New.md has problems:\n- unresolved-link: node-human-missing — Local link target does not exist as a file\nFix them before you end this turn\./,
  );
  const clean = await cli("rename", ["node-other", "Other"]);
  assert.deepEqual(clean.problems, []);
  const renamed = await cli("rename", ["node-new", "Renamed"]);
  assert.deepEqual(
    renamed.problems.map((p: { path: string }) => p.path),
    [".tent/Renamed/Renamed.md"],
  );
  const moved = await cli("move", ["node-new", "--parent", "node-selected"]);
  assert.deepEqual(
    moved.problems.map((p: { path: string }) => p.path),
    [".tent/Selected/Renamed/Renamed.md"],
  );
  const failed = await runNodeCommand(
    "write",
    ["node-new", "--base-etag", "bad-etag", "--body", "must fail"],
    { workspace: root, json: true },
  );
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /ETAG_MISMATCH|changed|ETag/i);
});
