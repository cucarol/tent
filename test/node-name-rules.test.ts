import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace, validateNodeName } from "../src/core/scaffold.js";
import { createNode, renameNode } from "../src/core/ops.js";
import { checkGraph } from "../src/core/graph-check.js";
import { NODE_MOVE_PENDING_PATH } from "../src/core/node-move-recovery.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

const RAW_FAILURE = /ENOENT|update-index|Path escapes|Invalid input|"code"|\[\s*\{/;

async function fixture(t: TestContext, withGit = true) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-name-rules-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "Name rules" });
  const systemRoot = path.join(root, ".tent");
  if (withGit) await git(systemRoot, "init");
  const adapter = new NodeFs(systemRoot);
  const env = { fs: adapter, clock: new SystemClock(), tentName: "test", tentRoot: systemRoot };
  const fileExists = async (filename: string) => {
    try {
      return (await fs.stat(filename)).isFile();
    } catch {
      return false;
    }
  };
  return { root, systemRoot, adapter, env, fileExists };
}

/** Product files outside the independent Git directory and lock bookkeeping. */
async function snapshot(systemRoot: string) {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(systemRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path
      .relative(systemRoot, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    if (file.startsWith(".git/") || file.startsWith("temp/") || file.startsWith("mutation.lock"))
      continue;
    files[file] = await fs.readFile(path.join(systemRoot, file), "utf8");
  }
  return files;
}

test("Node names follow Windows file-name rules on every platform", () => {
  for (const character of ["<", ">", ":", '"', "|", "?", "*"])
    assert.throws(
      () => validateNodeName(`a${character}b`),
      (error: Error) =>
        error.message.includes(`the character ${character} `) && !RAW_FAILURE.test(error.message),
      character,
    );
  for (const name of ["a/b", "a\\b"])
    assert.throws(() => validateNodeName(name), /cannot contain path separators/);
  assert.throws(() => validateNodeName("a\tb"), /cannot contain a tab/);
  // The raw input is checked, so trimming cannot hide these characters at either end.
  for (const name of ["Name\t", "\tName", " \tName "])
    assert.throws(() => validateNodeName(name), /cannot contain a tab/, JSON.stringify(name));
  for (const name of ["Name\r\n", "Name\n", "\rName", `Name${String.fromCharCode(0x2028)}`])
    assert.throws(() => validateNodeName(name), /cannot contain newlines/, JSON.stringify(name));
  for (const name of ["Name\x01", "\x1fName", "Name\x7f"])
    assert.throws(
      () => validateNodeName(name),
      /cannot contain control characters/,
      JSON.stringify(name),
    );
  assert.throws(() => validateNodeName("a\u0001b"), /cannot contain control characters/);
  for (const name of [
    "CON",
    "con",
    "Prn",
    "AUX",
    "NUL",
    "NUL.txt",
    "aux.md",
    "COM1",
    "com9.md",
    "LPT1",
    "lpt9.tar.gz",
    "CON .txt",
    // Windows also reserves COM and LPT followed by superscript 1, 2 and 3.
    "COM¹",
    "com²",
    "COM³",
    "LPT¹",
    "lpt²",
    "LPT³",
    "COM².txt",
    "lpt¹.tar.gz",
    " COM³ .md ",
  ])
    assert.throws(
      () => validateNodeName(name),
      (error: Error) =>
        /reserved Windows device name/.test(error.message) && error.message.includes("COM¹-COM³"),
      name,
    );
  for (const name of ["trail.", "a..", "dots. ."])
    assert.throws(() => validateNodeName(name), /cannot end with a dot/, name);
  for (const name of [
    "CONSOLE",
    "COM10",
    "LPT0",
    "COM",
    "NULL",
    "con-notes",
    "auxiliary.md",
    "COM⁴",
    "LPT⁰",
    "COM¹²",
    "COM¹x",
  ])
    assert.equal(validateNodeName(name), name);
  assert.equal(validateNodeName("  spaced  "), "spaced");
  assert.throws(() => validateNodeName(".."), /reserved or excluded/);
});

test("create, rename and write-many reject invalid names with one diagnostic and a Next command before writing", async (t) => {
  const { root, systemRoot } = await fixture(t);
  const globals = { workspace: root };
  const created = await runNodeCommand("create", ["Goal", "--type", "goal", "--json"], globals);
  assert.equal(created.exitCode, 0, created.stderr);
  const nodeId = JSON.parse(created.stdout).node.nodeId;
  const before = await snapshot(systemRoot);
  const invalid = [
    "a:b",
    "a?b",
    "a|b",
    "a\tb",
    "TrailingTab\t",
    "\tLeadingTab",
    "TrailingNewline\r\n",
    "CON",
    "nul.txt",
    "trail.",
  ];
  for (const name of invalid) {
    const results = [
      await runNodeCommand("create", [name, "--type", "prompt"], globals),
      await runNodeCommand("rename", [nodeId, name], globals),
      await runNodeCommand(
        "write-many",
        [
          "--input-json",
          JSON.stringify({ items: [{ op: "create", ref: "x", name, type: "prompt" }] }),
        ],
        globals,
      ),
    ];
    for (const result of results) {
      assert.equal(result.exitCode, 1, name);
      assert.match(result.stderr, /^Node name /, name);
      assert.equal(result.stderr.trim().split("\n").length, 2, name);
      assert.match(result.stderr.trim().split("\n")[1]!, /^Next: tent node /);
      assert.doesNotMatch(result.stderr, RAW_FAILURE, name);
    }
  }
  assert.deepEqual(await snapshot(systemRoot), before);
});

test("create, rename and write-many reject superscript COM and LPT device names without writing or committing", async (t) => {
  const { root, systemRoot } = await fixture(t);
  const globals = { workspace: root };
  const created = await runNodeCommand("create", ["Goal", "--type", "goal", "--json"], globals);
  assert.equal(created.exitCode, 0, created.stderr);
  const nodeId = JSON.parse(created.stdout).node.nodeId;
  const head = async () => (await git(systemRoot, "rev-parse", "HEAD")).trim();
  const before = await snapshot(systemRoot);
  const headBefore = await head();
  for (const name of ["COM¹", "LPT³", "COM².txt"]) {
    const results = [
      await runNodeCommand("create", [name, "--type", "prompt"], globals),
      await runNodeCommand("rename", [nodeId, name], globals),
      await runNodeCommand(
        "write-many",
        [
          "--input-json",
          JSON.stringify({ items: [{ op: "create", ref: "x", name, type: "prompt" }] }),
        ],
        globals,
      ),
    ];
    for (const result of results) {
      assert.equal(result.exitCode, 1, name);
      assert.match(result.stderr, /^Node name .* is a reserved Windows device name /, name);
      assert.equal(result.stderr.trim().split("\n").length, 2, name);
      assert.match(result.stderr.trim().split("\n")[1]!, /^Next: tent node /);
      assert.doesNotMatch(result.stderr, RAW_FAILURE, name);
    }
    assert.deepEqual(await snapshot(systemRoot), before, name);
    assert.equal(await head(), headBefore, name);
  }
  // COM10 is not a device name and stays an ordinary Node.
  const control = await runNodeCommand("create", ["COM10", "--type", "prompt", "--json"], globals);
  assert.equal(control.exitCode, 0, control.stderr);
  assert.equal(JSON.parse(control.stdout).node.path, ".tent/COM10/COM10.md");
  assert.notEqual(await head(), headBefore);
});

/**
 * Rename Parent to Renamed while the rename's Git capture fails. `publish` lets the real capture
 * publish HEAD first; `failRead` / `failHead` then break the follow-up HEAD check.
 * `failRollback` stops the rollback from writing its recovery record, which then reads as missing
 * or cannot be read at all.
 */
async function renameWithCaptureFailure(
  t: TestContext,
  inject: {
    publish: boolean;
    failRead?: boolean;
    failHead?: boolean;
    failRollback?: "missing" | "unreadable";
  },
) {
  const context = await fixture(t);
  const { root, systemRoot, adapter, env, fileExists } = context;
  const parent = await createNode(env, { parentPath: "", name: "Parent", type: "goal" });
  await createNode(env, {
    parentPath: "Parent",
    name: "Child",
    type: "prompt",
    body: "[Up](../Parent.md)\n",
  });
  await createNode(env, {
    parentPath: "",
    name: "Hub",
    type: "prompt",
    body: "[Parent](../Parent/Parent.md)\n",
  });
  const before = await snapshot(systemRoot);
  const history = adapter.history;
  const head = await history.currentCommit();
  const capture = history.captureUnlocked.bind(history);
  const read = history.read.bind(history);
  const currentCommit = history.currentCommit.bind(history);
  let failed = false;
  history.captureUnlocked = async (changes, metadata) => {
    if (metadata?.operation !== "node.rename") return capture(changes, metadata);
    if (inject.publish) await capture(changes, metadata);
    failed = true;
    throw new Error("simulated Git failure");
  };
  history.read = async (version) => {
    if (failed && inject.failRead) throw new Error("simulated history read failure");
    return read(version);
  };
  history.currentCommit = async () => {
    if (failed && inject.failHead) throw new Error("simulated HEAD read failure");
    return currentCommit();
  };
  const writeFile = adapter.writeFile;
  const exists = adapter.exists;
  const recordFault = (file: string) =>
    failed && inject.failRollback !== undefined && file === NODE_MOVE_PENDING_PATH;
  adapter.writeFile = async (file, content) => {
    if (recordFault(file)) throw new Error("simulated recovery record write failure");
    return writeFile.call(adapter, file, content);
  };
  adapter.exists = async (file) => {
    if (recordFault(file) && inject.failRollback === "unreadable")
      throw new Error("simulated recovery record read failure");
    return exists.call(adapter, file);
  };
  let error: Error | undefined;
  try {
    await renameNode(env, parent, "Renamed");
  } catch (caught) {
    error = caught as Error;
  } finally {
    history.captureUnlocked = capture;
    history.read = read;
    history.currentCommit = currentCommit;
    adapter.writeFile = writeFile;
    adapter.exists = exists;
  }
  assert.ok(error, "the rename must report the capture failure");
  const mismatches = async () =>
    (await checkGraph(adapter, root, fileExists)).issues
      .filter((issue) => issue.kind === "node-git-mismatch")
      .map((issue) => `${issue.path} ${"state" in issue ? issue.state : ""}`);
  const headTree = async () =>
    (await git(systemRoot, "ls-tree", "-r", "--name-only", "HEAD")).trim().split("\n");
  return { ...context, parent, before, head, error, mismatches, headTree };
}

test("a rename whose Git capture fails before HEAD changes is rolled back so disk and Tent Git keep the old name", async (t) => {
  const { systemRoot, adapter, env, parent, before, head, error, mismatches } =
    await renameWithCaptureFailure(t, { publish: false });
  assert.match(error.message, /rolled back[^]*Parent[^]*simulated Git failure/);
  assert.deepEqual(await snapshot(systemRoot), before);
  assert.equal(await adapter.exists(NODE_MOVE_PENDING_PATH), false);
  assert.equal(await adapter.exists("Renamed"), false);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await mismatches(), []);
  const renamed = await renameNode(env, parent, "Renamed");
  assert.equal(renamed.path, "Renamed");
  assert.deepEqual(await mismatches(), []);
});

test("a rename whose capture fails after HEAD records it keeps the new name, even when the HEAD check cannot read Git", async (t) => {
  for (const failRead of [true, false]) {
    const { adapter, head, error, mismatches, headTree } = await renameWithCaptureFailure(t, {
      publish: true,
      failRead,
    });
    assert.notEqual(await adapter.history.currentCommit(), head);
    assert.equal(await adapter.exists("Parent"), false);
    assert.equal(await adapter.exists("Renamed/Renamed.md"), true);
    assert.equal(await adapter.exists("Renamed/Child/Child.md"), true);
    assert.equal(await adapter.exists(NODE_MOVE_PENDING_PATH), false);
    assert.deepEqual(await headTree(), [
      "Hub/Hub.md",
      "Renamed/Child/Child.md",
      "Renamed/Renamed.md",
    ]);
    assert.deepEqual(await mismatches(), [], `failRead=${failRead}`);
    assert.match(
      error.message,
      failRead
        ? /^Node rename to Renamed is kept on disk because Tent Git could not show whether it was recorded; run workspace check[^]*simulated Git failure/
        : /^Node rename to Renamed is recorded in Tent Git HEAD and kept on disk[^]*simulated Git failure/,
    );
    assert.doesNotMatch(error.message, /rolled back/);
  }
});

test("a rename is not reversed when Tent Git HEAD cannot be read after its capture fails", async (t) => {
  const { adapter, head, error, mismatches, headTree } = await renameWithCaptureFailure(t, {
    publish: false,
    failHead: true,
  });
  assert.match(
    error.message,
    /^Node rename to Renamed is kept on disk because Tent Git could not show whether it was recorded/,
  );
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.exists("Parent"), false);
  assert.equal(await adapter.exists("Renamed/Renamed.md"), true);
  assert.deepEqual(await headTree(), ["Hub/Hub.md", "Parent/Child/Child.md", "Parent/Parent.md"]);
  // The undetermined state is left for workspace check to report, not rewritten in reverse.
  assert.deepEqual(await mismatches(), [
    "Parent/Child/Child.md git-only",
    "Parent/Parent.md git-only",
    "Renamed/Child/Child.md disk-only",
    "Renamed/Renamed.md disk-only",
  ]);
});

test("a failed rename rollback does not claim its recovery record was absent when Tent cannot tell", async (t) => {
  for (const failRollback of ["missing", "unreadable"] as const) {
    const { adapter, head, error, mismatches } = await renameWithCaptureFailure(t, {
      publish: false,
      failRollback,
    });
    assert.match(
      error.message,
      /^Node rename to Renamed failed and could not be rolled back: [^]*; Tent could not determine whether a recovery record was saved, so run workspace check before the next write\. Cause: [^]*simulated Git failure/,
      failRollback,
    );
    assert.doesNotMatch(error.message, /no recovery record was saved|record is kept/, failRollback);
    assert.equal(await adapter.history.currentCommit(), head);
    assert.equal(await adapter.exists(NODE_MOVE_PENDING_PATH), false);
    assert.equal(await adapter.exists("Renamed/Renamed.md"), true);
    // The unrecovered move stays visible to workspace check.
    assert.deepEqual(await mismatches(), [
      "Parent/Child/Child.md git-only",
      "Parent/Parent.md git-only",
      "Renamed/Child/Child.md disk-only",
      "Renamed/Renamed.md disk-only",
    ]);
  }
});

test("workspace check reports Nodes whose disk and Tent Git presence differ", async (t) => {
  const { root, systemRoot, adapter, env, fileExists } = await fixture(t);
  await createNode(env, { parentPath: "", name: "Area", type: "goal" });
  await createNode(env, { parentPath: "Area", name: "Topic", type: "prompt" });
  await createNode(env, { parentPath: "", name: "Kept", type: "prompt" });
  assert.deepEqual((await checkGraph(adapter, root, fileExists)).issues, []);
  // An interrupted external rename: disk has the new name, Git only the old one.
  await fs.rename(path.join(systemRoot, "Area"), path.join(systemRoot, "Moved"));
  await fs.rename(
    path.join(systemRoot, "Moved", "Area.md"),
    path.join(systemRoot, "Moved", "Moved.md"),
  );
  const mismatches = (await checkGraph(adapter, root, fileExists)).issues
    .filter((issue) => issue.kind === "node-git-mismatch")
    .map((issue) => ({ path: issue.path, state: "state" in issue ? issue.state : undefined }));
  assert.deepEqual(mismatches, [
    { path: "Area/Area.md", state: "git-only" },
    { path: "Area/Topic/Topic.md", state: "git-only" },
    { path: "Moved/Moved.md", state: "disk-only" },
    { path: "Moved/Topic/Topic.md", state: "disk-only" },
  ]);
  const text = await runWorkspaceCommand("check", [], { workspace: root });
  assert.equal(text.exitCode, 1);
  assert.match(text.stdout, /Moved\/Moved\.md: node-git-mismatch: disk-only — /);
  assert.match(text.stdout, /Area\/Area\.md: node-git-mismatch: git-only — /);
});

test("workspace check skips the disk and Git comparison without Tent Git", async (t) => {
  const { root, adapter, env, fileExists } = await fixture(t, false);
  await createNode(env, { parentPath: "", name: "Plain", type: "prompt" });
  assert.deepEqual((await checkGraph(adapter, root, fileExists)).issues, []);
});
