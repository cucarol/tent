import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory, initializeFixtureRepository } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { validateNodeName } from "../src/core/store/scaffold.js";
import { createNode, renameNode } from "../src/core/graph/ops.js";
import { checkGraph } from "../src/core/check/graph-check.js";
import { readOnlyFs } from "../src/core/store/adapter.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { SystemClock } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";

const RAW_FAILURE = /ENOENT|update-index|Path escapes|Invalid input|"code"|\[\s*\{/;

async function fixture(t: TestContext, withHistory = true) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-name-rules-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(root, { name: "Name rules" });
  initializeFixtureRepository(root);
  const systemRoot = path.join(root, ".tent");
  if (withHistory) await initializeFixtureHistory(systemRoot);
  const adapter = openTestFs(systemRoot);
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
    if (file.startsWith(".git/") || file.startsWith("temp/")) continue;
    files[file] = await fs.readFile(path.join(systemRoot, file), "utf8");
  }
  return files;
}

async function invalidNameDraft(root: string, name: string) {
  const filename = path.join(root, "invalid-name.draft.json");
  const raw = JSON.stringify({
    items: [
      {
        op: "create",
        ref: "x",
        id: "node-preflight",
        name,
        type: "prompt",
        body: "Validate this name before writing",
      },
    ],
  });
  await fs.writeFile(filename, raw);
  const result = await runNodeCommand("create", ["--draft", filename], { workspace: root });
  assert.equal(
    await fs.readFile(filename, "utf8"),
    raw,
    "name preflight leaves the draft unchanged",
  );
  return result;
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

test("create, rename and create draft reject invalid names with one diagnostic and a Next command before writing", async (t) => {
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
      await invalidNameDraft(root, name),
    ];
    assert.match(results[2]!.stderr, /^Batch item @x: /, name);
    for (const result of results) {
      assert.equal(result.exitCode, 1, name);
      assert.match(result.stderr, /^(?:Batch item @x: )?Node name /, name);
      assert.equal(result.stderr.trim().split("\n").length, 2, name);
      assert.match(result.stderr.trim().split("\n")[1]!, /^Next: tent node /);
      assert.doesNotMatch(result.stderr, RAW_FAILURE, name);
    }
  }
  assert.deepEqual(await snapshot(systemRoot), before);
});

test("create, rename and create draft reject superscript COM and LPT device names without writing or committing", async (t) => {
  const { root, systemRoot } = await fixture(t);
  const globals = { workspace: root };
  const created = await runNodeCommand("create", ["Goal", "--type", "goal", "--json"], globals);
  assert.equal(created.exitCode, 0, created.stderr);
  const nodeId = JSON.parse(created.stdout).node.nodeId;
  const head = async () => (await historyHead(systemRoot)).trim();
  const before = await snapshot(systemRoot);
  const headBefore = await head();
  for (const name of ["COM¹", "LPT³", "COM².txt"]) {
    const results = [
      await runNodeCommand("create", [name, "--type", "prompt"], globals),
      await runNodeCommand("rename", [nodeId, name], globals),
      await invalidNameDraft(root, name),
    ];
    assert.match(results[2]!.stderr, /^Batch item @x: /, name);
    for (const result of results) {
      assert.equal(result.exitCode, 1, name);
      assert.match(
        result.stderr,
        /^(?:Batch item @x: )?Node name .* is a reserved Windows device name /,
        name,
      );
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

/** Rename Parent to Renamed while the rename's capture fails; `publish` lets it publish first. */
async function renameWithCaptureFailure(
  t: TestContext,
  inject: { publish: boolean; external?: boolean },
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
  history.captureUnlocked = async (changes, metadata) => {
    if (metadata?.operation !== "node.rename") return capture(changes, metadata);
    if (inject.publish) await capture(changes, metadata);
    if (inject.external)
      await fs.writeFile(path.join(systemRoot, "Renamed/Renamed.md"), "EXTERNAL RENAME\n");
    throw new Error("simulated Git failure");
  };
  let error: Error | undefined;
  try {
    await renameNode(env, parent, "Renamed");
  } catch (caught) {
    error = caught as Error;
  } finally {
    history.captureUnlocked = capture;
  }
  assert.ok(error, "the rename must report the capture failure");
  const mismatches = async () =>
    (await checkGraph(adapter, root, fileExists)).issues
      .filter((issue) => issue.kind === "node-git-mismatch")
      .map((issue) => `${issue.path} ${"state" in issue ? issue.state : ""}`);
  const headTree = async () => await adapter.history.retainedPaths();
  return { ...context, parent, before, head, error, mismatches, headTree };
}

test("a rename whose Git capture fails before HEAD changes is rolled back so disk and Tent Git keep the old name", async (t) => {
  const { systemRoot, adapter, env, parent, before, head, error, mismatches } =
    await renameWithCaptureFailure(t, { publish: false });
  assert.match(error.message, /simulated Git failure/);
  assert.deepEqual(await snapshot(systemRoot), before);
  assert.equal(await adapter.exists("Renamed"), false);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await mismatches(), []);
  const renamed = await renameNode(env, parent, "Renamed");
  assert.equal(renamed.path, "Renamed");
  assert.deepEqual(await mismatches(), []);
});

test("a rename whose capture fails after history records it keeps the new name", async (t) => {
  const { adapter, head, error, mismatches, headTree } = await renameWithCaptureFailure(t, {
    publish: true,
  });
  assert.notEqual(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.exists("Parent"), false);
  assert.equal(await adapter.exists("Renamed/Renamed.md"), true);
  assert.equal(await adapter.exists("Renamed/Child/Child.md"), true);
  assert.deepEqual(await headTree(), [
    "Hub/Hub.md",
    "Renamed/Child/Child.md",
    "Renamed/Renamed.md",
  ]);
  assert.deepEqual(await mismatches(), []);
  assert.match(error.message, /simulated Git failure/);
});

test("rename failure preserves external bytes and reports conflicts while restoring the owned group", async (t) => {
  const { adapter, before, head, error } = await renameWithCaptureFailure(t, {
    publish: false,
    external: true,
  });
  assert.match(error.message, /simulated Git failure/);
  assert.equal(await adapter.readFile("Renamed/Renamed.md"), "EXTERNAL RENAME\n");
  for (const [file, raw] of Object.entries(before)) assert.equal(await adapter.readFile(file), raw);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.ok(adapter.recoveryConflicts.includes("Renamed/Renamed.md"));
});

test("a rename cannot overwrite a file in its own folder that already has the new name", async (t) => {
  const { adapter, env } = await fixture(t);
  const id = await createNode(env, { parentPath: "", name: "Old", type: "goal" });
  await adapter.writeFile("Old/New.md", "ordinary bytes");
  await assert.rejects(renameNode(env, id, "New"), /Rename target already exists: Old\/New\.md/);
  assert.equal(await adapter.readFile("Old/New.md"), "ordinary bytes");
  assert.equal(await adapter.exists("New"), false);
});

test("Core read-only check reports native path mismatches and workspace check captures the valid move", async (t) => {
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
  const before = await adapter.history.currentCommit();
  const mismatches = (await checkGraph(readOnlyFs(adapter), root, fileExists)).issues
    .filter((issue) => issue.kind === "node-git-mismatch")
    .map((issue) => ({ path: issue.path, state: "state" in issue ? issue.state : undefined }));
  assert.deepEqual(mismatches, [
    { path: "Area/Area.md", state: "git-only" },
    { path: "Area/Topic/Topic.md", state: "git-only" },
    { path: "Moved/Moved.md", state: "disk-only" },
    { path: "Moved/Topic/Topic.md", state: "disk-only" },
  ]);
  assert.equal(
    await adapter.history.currentCommit(),
    before,
    "read-only Core checks never capture the move",
  );
  const checked = await runWorkspaceCommand("check", [], { workspace: root, json: true });
  assert.equal(checked.exitCode, 0, checked.stderr || checked.stdout);
  assert.deepEqual(JSON.parse(checked.stdout).issues, []);
  assert.notEqual(await adapter.history.currentCommit(), before);
  assert.deepEqual((await checkGraph(readOnlyFs(adapter), root, fileExists)).issues, []);
});

test("Core graph check skips retained-presence comparison without SQLite history", async (t) => {
  const { root, adapter, env, fileExists } = await fixture(t, false);
  await createNode(env, { parentPath: "", name: "Plain", type: "prompt" });
  assert.deepEqual((await checkGraph(adapter, root, fileExists)).issues, []);
});
