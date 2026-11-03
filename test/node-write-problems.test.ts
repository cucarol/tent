import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { checkGraph, checkSelectedNodes } from "../src/core/check/graph-check.js";
import { formatNodeWriteProblems } from "../src/core/check/node-write-problems.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { checkNodeWriteProblems } from "../src/fs/node-write-problems.js";
import { writeNodeDocument, NodeWriteError } from "../src/core/graph/node-document-write.js";
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
  const { root, systemRoot, adapter, cli } = await fixture(t);
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  const original = NodeFs.prototype.retainedDocumentPaths;
  let inspections = 0;
  NodeFs.prototype.retainedDocumentPaths = async () => {
    inspections++;
    throw new Error("Retained storage is unavailable");
  };
  try {
    const saved = await cli("create", ["Saved", "--type", "prompt", "--body", "Saved content."]);
    assert.deepEqual(saved.problems, [
      {
        category: "error",
        path: ".tent/Saved/Saved.md",
        reason: "Retained storage is unavailable",
      },
    ]);
    assert.match(
      await fs.readFile(path.join(systemRoot, "Saved/Saved.md"), "utf8"),
      /Saved content\./,
    );
    const noop = await cli("rename", ["node-other", "Other"]);
    assert.deepEqual(noop.problems, []);
    assert.equal(inspections, 1);
    await assert.rejects(
      writeNodeDocument(adapter, "node-selected", { baseEtag: "bad-etag", body: "Not saved." }),
      (error) => error instanceof NodeWriteError && error.code === "ETAG_CONFLICT",
    );
    assert.equal(
      parseFrontmatter(await fs.readFile(path.join(systemRoot, "Selected/Selected.md"), "utf8"))
        .body,
      "Clean.",
    );
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

test("missing selected Nodes retain their presence diagnostic without capturing history", async (t) => {
  const { root, systemRoot, adapter } = await fixture(t);
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  const head = await historyHead(systemRoot);
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
  assert.equal(await historyHead(systemRoot), head);
});

test("CLI create, draft and structure receipts report only written Nodes without failing saves", async (t) => {
  const { root, systemRoot, adapter, cli } = await fixture(t);
  await initializeFixtureHistory(systemRoot);
  await captureFixtureDocuments(systemRoot);
  await fs.writeFile(
    path.join(systemRoot, "Other/Other.md"),
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
    created.problems.map((problem: { path: string }) => problem.path),
    [".tent/New/New.md"],
  );
  assert.equal(created.problems[0].kind, "unresolved-link");
  await fs.writeFile(
    path.join(systemRoot, "New/New.md"),
    serializeFrontmatter({ id: "node-new", type: "prompt" }, "[broken](node-native-missing)"),
  );
  const renamed = await cli("rename", ["node-new", "Renamed"]);
  assert.deepEqual(
    renamed.problems.map((problem: { path: string }) => problem.path),
    [".tent/Renamed/Renamed.md"],
  );
  assert.equal(renamed.problems[0].target, "node-native-missing");
  const filename = path.join(root, "draft.json");
  await fs.writeFile(
    filename,
    JSON.stringify({
      items: [
        {
          op: "create",
          ref: "batch",
          name: "Batch",
          type: "prompt",
          body: "[broken](node-batch-missing)",
        },
        { op: "create", ref: "clean", name: "Clean", type: "prompt", body: "Settled fact." },
      ],
    }),
  );
  const draft = await cli("create", ["--draft", "draft.json"]);
  assert.deepEqual(
    draft.problems.map((problem: { path: string }) => problem.path),
    [".tent/Batch/Batch.md"],
  );
  assert.equal(
    parseFrontmatter(await fs.readFile(path.join(systemRoot, "Clean/Clean.md"), "utf8")).body,
    "Settled fact.",
  );
  const human = await cli(
    "create",
    ["Human", "--type", "prompt", "--body", "[broken](node-human-missing)"],
    false,
  );
  assert.match(
    human,
    /Tent: \.tent\/Human\/Human.md has problems:\n- unresolved-link: node-human-missing — Local link target does not exist as a file\nFix them before you end this turn\./,
  );
  const clean = await cli("rename", ["node-other", "Other"]);
  assert.deepEqual(clean.problems, []);
  const moved = await cli("move", ["node-new", "--parent", "node-selected"]);
  assert.deepEqual(
    moved.problems.map((problem: { path: string }) => problem.path),
    [".tent/Selected/Renamed/Renamed.md"],
  );
  const before = await fs.readFile(path.join(systemRoot, "Selected/Renamed/Renamed.md"), "utf8");
  const failed = await runNodeCommand("rename", ["node-new", "../Invalid"], {
    workspace: root,
    json: true,
  });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, "");
  assert.equal(
    await fs.readFile(path.join(systemRoot, "Selected/Renamed/Renamed.md"), "utf8"),
    before,
  );
});
