import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { runTurnHook } from "../src/cli/turn-hook.js";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";

const execute = promisify(execFile);
const scratch = fileURLToPath(
  new URL("../.scratch/converge-stop1103/stop-integration/", import.meta.url),
);
const serialize = (reason: string) => JSON.stringify({ decision: "block", reason }) + "\n";
const introduction = "Files changed this turn are covered by these Tent Nodes:\n";
const instruction =
  "\n\nCorrect each against what it records: a goal against what the user wants now, a prompt against the decisions made, an output against the workspace. Record anything lasting the turn settled. Leave a Node that still matches as it is, and if nothing changed say nothing about Tent: a check that changed nothing is noise to the user.";
const uncovered =
  "No Tent Node covers the files changed this turn. If the turn settled something a later session should start from — what the work is for, what was given to get there, or what came out — record it. Otherwise say nothing about Tent: a check that changed nothing is noise to the user.";

async function git(root: string, ...args: string[]) {
  return (
    await execute("git", ["-C", root, ...args], {
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
    })
  ).stdout;
}

async function fixture(t: TestContext, repository = true) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "case-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
  );
  const checkout = path.join(root, "main checkout");
  await fs.mkdir(checkout);
  if (repository) {
    await git(checkout, "init", "--quiet", "-b", "main");
    await git(checkout, "config", "user.name", "Stop Integration");
    await git(checkout, "config", "user.email", "stop@example.invalid");
    await git(checkout, "config", "commit.gpgsign", "false");
    await git(checkout, "config", "core.autocrlf", "false");
    await git(checkout, "config", "core.longpaths", "true");
  }
  await initializeTentWorkspace(checkout);
  await fs.writeFile(path.join(checkout, ".gitignore"), ".tent/\n.worktrees/\n");
  const systemRoot = path.join(checkout, ".tent");
  const adapter = openTestFs(systemRoot);
  async function write(file: string, raw: string, target = checkout) {
    await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await fs.writeFile(path.join(target, file), raw);
  }
  async function node(
    name: string,
    metadata: string,
    body = "SECRET_NODE_BODY",
    target = systemRoot,
  ) {
    const file = `${name}/${name}.md`;
    const raw = `---\nid: node-${name.replace(/[^a-z0-9]/gi, "").toLowerCase()}\ntype: prompt\n${metadata}\n---\n${body}\n`;
    await write(file, raw, target);
    return { file, raw, absolute: path.join(target, file) };
  }
  async function seal() {
    assert.deepEqual((await captureNativeNodeEdits(adapter)).invalidNodes, []);
  }
  async function commit() {
    await git(checkout, "add", "-A");
    await git(checkout, "commit", "--quiet", "-m", "fixture");
  }
  async function stop(cwd = checkout, stopHookActive = false, host = "codex") {
    const output = await runTurnHook(host, { eventName: "Stop", cwd, stopHookActive }, serialize);
    if (output === "{}\n") return undefined;
    const result = JSON.parse(output);
    assert.equal(result.decision, "block");
    assert.equal(typeof result.reason, "string");
    return result.reason as string;
  }
  function pointers(names: string[], target = systemRoot) {
    return (
      introduction +
      [...names]
        .sort()
        .map((name) => `- ${name} (prompt): ${path.join(target, name, `${name}.md`)}`)
        .join("\n") +
      instruction
    );
  }
  return { root, checkout, systemRoot, adapter, write, node, seal, commit, stop, pointers };
}

test("Git Stop starts from current dirty content and stays quiet after repeats or committing those bytes", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base\n");
  await f.node("Exact", "resource: ../../src/a.ts");
  await f.seal();
  await f.commit();
  await f.write("src/a.ts", "first dirty save\n");
  assert.equal(await f.stop(), f.pointers(["Exact"]));
  assert.equal(await f.stop(), undefined);
  await f.commit();
  assert.equal(await f.stop(), undefined);
  await f.write("src/a.ts", "new committed save\n");
  await f.commit();
  assert.equal(await f.stop(), f.pointers(["Exact"]));
  assert.equal(await f.stop(), undefined);
});

for (const initial of ["Rules", "Other"] as const) {
  test(`first Git Stop compares sections to HEAD when ${initial} changes, then prefers only actual sections`, async (t) => {
    const f = await fixture(t);
    const original = "# Rules\nbase rules\n# Other\nbase other\n";
    await f.write("docs/spec.md", original);
    await f.write("docs/whole.md", "whole baseline\n");
    await f.node("Directory", "resource: ../../docs/");
    await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
    await f.node("Whole", "resource: ../../docs/whole.md");
    await f.seal();
    await f.commit();
    const first =
      initial === "Rules"
        ? original.replace("base rules", "new rules")
        : original.replace("base other", "new other");
    await f.write("docs/spec.md", first);
    await f.write("docs/whole.md", "whole changed\n");
    assert.equal(
      await f.stop(),
      f.pointers([initial === "Rules" ? "Section" : "Directory", "Whole"]),
    );
    const second = first.replace(/(?:base|new) rules/, "later rules");
    await f.write("docs/spec.md", second);
    assert.equal(await f.stop(), f.pointers(["Section"]));
    await f.write("docs/spec.md", second.replace(/(?:base|new) other/, "later other"));
    assert.equal(await f.stop(), f.pointers(["Directory"]));
    assert.equal(await f.stop(), undefined);
  });
}

test("clean Stops do not open linked section bodies; the first later edit compares the previous HEAD", async (t) => {
  const f = await fixture(t);
  const original = "# Rules\nOriginal rules\n# Other\nOriginal other\n";
  await f.write("docs/spec.md", original);
  await f.node("Directory", "resource: ../../docs/");
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  await f.seal();
  await f.commit();
  const linked = path.join(f.root, "clean linked checkout");
  await git(f.checkout, "worktree", "add", "--quiet", "-b", "clean-linked", linked);
  const sources = [f.checkout, linked].map((root) => path.join(root, "docs/spec.md"));
  const denied = Object.assign(new Error("Clean section body must not be opened"), {
    code: "EACCES",
  });
  const open = fs.open;
  let reads = 0;
  const mocked = t.mock.method(fs, "open", (...args: Parameters<typeof open>) => {
    if (sources.some((file) => path.relative(file, String(args[0])) === "")) {
      reads++;
      throw denied;
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await f.stop(), undefined);
    assert.equal(await f.stop(linked), undefined);
    assert.equal(reads, 0, "clean source bodies are outside the Stop observation");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  const edited = original.replace("Original rules", "New committed rules");
  await f.write("docs/spec.md", edited);
  await f.commit();
  assert.equal(await f.stop(), f.pointers(["Section"]));
  await f.write("docs/spec.md", edited, linked);
  assert.equal(await f.stop(linked), f.pointers(["Section"]));
  assert.equal(await f.stop(), undefined);
});

test("a newly linked section stays unknown when its preceding Stop observed dirty file bytes", async (t) => {
  const f = await fixture(t);
  await f.write("docs/spec.md", "# Rules\nOriginal rules\n# Other\nOriginal other\n");
  await f.node("Directory", "resource: ../../docs/");
  await f.seal();
  await f.commit();
  await f.write(
    "docs/spec.md",
    "# Rules\nPreviously observed dirty rules\n# Other\nOriginal other\n",
  );
  assert.equal(await f.stop(), f.pointers(["Directory"]));
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  await f.seal();
  await f.write(
    "docs/spec.md",
    "# Rules\nPreviously observed dirty rules\n# Other\nChanged other\n",
  );
  assert.equal(await f.stop(), f.pointers(["Directory"]));
  await f.write("docs/spec.md", "# Rules\nLater rules with a recorded fingerprint\n");
  assert.equal(await f.stop(), f.pointers(["Section"]));
});

test("Stop without a Git checkout stays silent, retains no native Node edits and creates no snapshot", async (t) => {
  const f = await fixture(t, false);
  await f.write("docs/spec.md", "# Rules\nOriginal section\n");
  const node = await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  const head = await f.adapter.history.currentCommit();
  const temp = path.join(f.systemRoot, "temp");
  const before = await fs.readdir(temp, { recursive: true });
  // Scratch lives inside this task's Git checkout. Hide only its unrelated
  // ancestor markers so this fixture represents a genuinely non-Git directory.
  const outsideMarker = (filename: unknown) => {
    const value = String(filename);
    const relative = path.relative(f.root, value);
    return (
      path.basename(value) === ".git" &&
      (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    );
  };
  const absent = () =>
    Promise.reject(Object.assign(new Error("No fixture Git owner"), { code: "ENOENT" }));
  const stat = fs.stat,
    lstat = fs.lstat;
  const statMock = t.mock.method(fs, "stat", (...args: Parameters<typeof stat>) =>
    outsideMarker(args[0]) ? absent() : stat(...args),
  );
  const lstatMock = t.mock.method(fs, "lstat", (...args: Parameters<typeof lstat>) =>
    outsideMarker(args[0]) ? absent() : lstat(...args),
  );
  syncBuiltinESMExports();
  try {
    assert.equal(await f.stop(), undefined);
    await f.write("docs/spec.md", "# Rules\nChanged section\n");
    const edited = node.raw + "\nUncaptured native edit.\n";
    await f.write(node.file, edited, f.systemRoot);
    assert.equal(await f.stop(), undefined);
    assert.equal(await f.adapter.history.currentCommit(), head);
    assert.deepEqual(await f.adapter.history.retainedPaths(), []);
    assert.equal(await f.adapter.readFile(node.file), edited);
    assert.deepEqual(await fs.readdir(temp, { recursive: true }), before);
    for (const directory of ["stop-snapshots", "stop-checkouts", "section-fingerprints"])
      await assert.rejects(fs.access(path.join(temp, directory)), { code: "ENOENT" });
  } finally {
    statMock.mock.restore();
    lstatMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Stop maps a nested Git Workspace and its linked checkout to the same absolute Node pointers", async (t) => {
  const f = await fixture(t);
  const prefix = "packages/app";
  const workspace = path.join(f.checkout, prefix);
  await fs.mkdir(workspace, { recursive: true });
  await initializeTentWorkspace(workspace);
  const system = path.join(workspace, ".tent");
  const adapter = openTestFs(system);
  const original = "# Rules\nbase\n# Other\nbase\n";
  await f.write(`${prefix}/docs/spec.md`, original);
  await f.write("docs/spec.md", original);
  await f.node("Directory", "resource: ../../docs/", "NESTED_BODY", system);
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"', "NESTED_BODY", system);
  assert.deepEqual((await captureNativeNodeEdits(adapter)).invalidNodes, []);
  await f.commit();
  await f.write("docs/spec.md", original.replace("base", "outside Workspace"));
  assert.equal(
    await f.stop(workspace),
    undefined,
    "repository paths outside the Workspace cannot select its Nodes",
  );
  const changed = original.replace("# Rules\nbase", "# Rules\nshared change");
  await f.write(`${prefix}/docs/spec.md`, changed);
  assert.equal(await f.stop(workspace), f.pointers(["Section"], system));
  const linked = path.join(f.root, "linked nested checkout");
  await git(f.checkout, "worktree", "add", "--quiet", "-b", "nested-linked", linked);
  const linkedWorkspace = path.join(linked, prefix);
  assert.equal(await f.stop(linkedWorkspace), undefined);
  await f.write(`${prefix}/docs/spec.md`, changed, linked);
  assert.equal(await f.stop(linkedWorkspace), f.pointers(["Section"], system));
  await f.write(
    `${prefix}/docs/spec.md`,
    changed.replace("# Other\nbase", "# Other\nlinked other"),
    linked,
  );
  assert.equal(await f.stop(linkedWorkspace), f.pointers(["Directory"], system));
  assert.equal(await f.stop(workspace), undefined);
  const foreign = path.join(linkedWorkspace, "foreign repository");
  await fs.mkdir(foreign);
  await git(foreign, "init", "--quiet", "-b", "foreign");
  await f.write("src/foreign.ts", "unrelated nested repository", foreign);
  assert.equal(
    await f.stop(foreign),
    undefined,
    "an independent nested Git boundary cannot borrow the parent Tent",
  );
});

test("Stop propagates real Git failures instead of silently treating a checkout as absent", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  await f.node("Exact", "resource: ../../src/a.ts");
  await f.seal();
  await f.commit();
  await f.write("src/a.ts", "changed");
  await fs.writeFile(path.join(f.checkout, ".git/config"), "[broken");
  let serialized = 0;
  await assert.rejects(
    runTurnHook("codex", { eventName: "Stop", cwd: f.checkout }, (reason) => {
      serialized++;
      return serialize(reason);
    }),
    /bad config|fatal/i,
  );
  assert.equal(serialized, 0);
  await assert.rejects(fs.access(path.join(f.systemRoot, "temp/stop-snapshots")), {
    code: "ENOENT",
  });
});

test("linked worktrees share absolute main Node pointers while snapshots and section records stay isolated", async (t) => {
  const f = await fixture(t);
  const original = "# Rules\nbase\n# Other\nbase\n";
  await f.write("docs/spec.md", original);
  await f.node("Directory", "resource: ../../docs/");
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  await f.seal();
  await f.commit();
  const linked = path.join(f.root, "linked checkout");
  await git(f.checkout, "worktree", "add", "--quiet", "-b", "linked", linked);
  assert.equal(await f.stop(), undefined);
  assert.equal(await f.stop(linked), undefined);
  const common = original.replace("# Rules\nbase", "# Rules\ncommon change");
  await f.write("docs/spec.md", common);
  assert.equal(await f.stop(), f.pointers(["Section"]));
  await f.write("docs/spec.md", common, linked);
  assert.equal(
    await f.stop(linked),
    f.pointers(["Section"]),
    "identical bytes still notify in the other checkout",
  );
  const linkedOnly = common.replace("common change", "linked-only rules");
  await f.write("docs/spec.md", linkedOnly, linked);
  assert.equal(await f.stop(linked), f.pointers(["Section"]));
  await f.write("docs/spec.md", common.replace("# Other\nbase", "# Other\nmain-only other"));
  assert.equal(
    await f.stop(),
    f.pointers(["Directory"]),
    "linked Rules cannot replace the main section baseline",
  );
  await f.write(
    "docs/spec.md",
    linkedOnly.replace("# Other\nbase", "# Other\nlinked-only other"),
    linked,
  );
  assert.equal(await f.stop(linked), f.pointers(["Directory"]));
  assert.equal(await f.stop(), undefined);
  assert.equal(await f.stop(linked), undefined);
});

test("Stop captures valid native edits and emits the exact ordered pointer and problem sections without bodies", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base a");
  await f.write("src/z.ts", "base z");
  const secret = "SECRET_BODY_NOT_OUTPUT_" + "汉".repeat(2000);
  const alpha = await f.node(
    "Alpha",
    "resource: ../../src/a.ts\nprovenance: [opaque, {by: native}]",
    secret,
  );
  const zulu = await f.node("Zulu", "resource: ../../src/z.ts", secret);
  const badZ = await f.node("BadZ", "description: Valid description", secret);
  const badA = await f.node("BadA", "description: Valid description", secret);
  const missing = await f.node("Missing", "description: Valid Node with a future material", secret);
  await f.seal();
  await f.commit();
  const before = (await f.adapter.history.currentCommit())!;
  const native = alpha.raw + "\nNative edit stays exact.\n";
  await f.write(alpha.file, native, f.systemRoot);
  await f.write(
    badZ.file,
    badZ.raw.replace("description: Valid description", "description: []"),
    f.systemRoot,
  );
  await f.write(
    badA.file,
    badA.raw.replace("description: Valid description", "description: 12"),
    f.systemRoot,
  );
  const missingRaw = missing.raw.replace(
    "type: prompt",
    "type: prompt\nresource: ../../missing.txt",
  );
  await f.write(missing.file, missingRaw, f.systemRoot);
  await f.write("src/a.ts", "changed a");
  await f.write("src/z.ts", "changed z");
  const output = await f.stop();
  assert.equal(
    output,
    f.pointers(["Alpha", "Zulu"]) +
      "\n\nThese Tent Node files have problems:\n" +
      ["BadA", "BadZ"]
        .map(
          (name) =>
            `- ${path.join(f.systemRoot, name, `${name}.md`)}: Node description must be a string`,
        )
        .join("\n") +
      `\n- ${missing.absolute}: Local material does not exist as a file`,
  );
  assert.ok(!output?.includes("SECRET_BODY_NOT_OUTPUT_"));
  assert.ok(!output?.includes("Native edit stays exact"));
  const head = (await f.adapter.history.currentCommit())!;
  assert.notEqual(head, before);
  assert.equal(await f.adapter.history.read({ commit: head, path: alpha.file }), native);
  assert.equal(await f.adapter.history.read({ commit: head, path: badA.file }), badA.raw);
  assert.equal(await f.adapter.history.read({ commit: head, path: badZ.file }), badZ.raw);
  assert.equal(await f.adapter.history.read({ commit: head, path: missing.file }), missingRaw);
  assert.equal(await f.adapter.readFile(zulu.file), zulu.raw);
  assert.equal(await f.adapter.readFile(alpha.file), native);
});

test("invalid Node reminders track changed bytes, recursive Stops, repair and checkout independently", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  const node = await f.node("Bad", "description: Valid description");
  await f.seal();
  await f.commit();
  const linked = path.join(f.root, "invalid linked checkout");
  await git(f.checkout, "worktree", "add", "--quiet", "-b", "invalid-linked", linked);
  const invalid = node.raw.replace("description: Valid description", "description: []");
  const problem = `These Tent Node files have problems:\n- ${node.absolute}: Node description must be a string`;
  await f.write(node.file, invalid, f.systemRoot);
  assert.equal(await f.stop(), problem);
  assert.equal(await f.stop(), undefined);
  assert.equal(
    await f.stop(linked),
    problem,
    "each checkout observes the shared invalid Node once",
  );
  assert.equal(await f.stop(linked), undefined);
  assert.equal(await f.stop(f.checkout, true), undefined);
  assert.equal(await f.stop(), undefined);
  const nextInvalid = invalid + "\nChanged body with the same metadata error.\n";
  await f.write(node.file, nextInvalid, f.systemRoot);
  assert.equal(await f.stop(), problem, "body changes must renew the same format diagnostic");
  const recursiveInvalid = nextInvalid + "\nAnother native body edit.\n";
  await f.write(node.file, recursiveInvalid, f.systemRoot);
  assert.equal(await f.stop(f.checkout, true), undefined);
  assert.equal(await f.stop(), undefined, "a recursive Stop still records observed problem bytes");
  await f.write(node.file, node.raw + "\nRepaired native Node.\n", f.systemRoot);
  assert.equal(await f.stop(), undefined);
  const retained = (await f.adapter.history.currentCommit())!;
  await f.write(node.file, recursiveInvalid, f.systemRoot);
  assert.equal(await f.stop(), problem, "repair clears the old problem observation");
  assert.equal(
    await f.adapter.history.currentCommit(),
    retained,
    "invalid bytes never enter history",
  );
});

test("a failed snapshot save does not consume the first invalid native Node reminder", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  await f.commit();
  const node = await f.node("NewBad", "description: []");
  const before = await f.adapter.history.currentCommit();
  const error = Object.assign(new Error("Controlled Stop snapshot publication failure"), {
    code: "EIO",
  });
  const snapshotDirectory = path.join(f.systemRoot, "temp/stop-snapshots");
  const rename = fs.rename;
  let failedSaves = 0;
  let serialized = 0;
  const mocked = t.mock.method(fs, "rename", (...args: Parameters<typeof rename>) => {
    if (path.relative(snapshotDirectory, path.dirname(String(args[1]))) === "") {
      failedSaves++;
      throw error;
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      runTurnHook("codex", { eventName: "Stop", cwd: f.checkout }, (reason) => {
        serialized++;
        return serialize(reason);
      }),
      (caught) => caught === error,
    );
    assert.ok(failedSaves > 0);
    assert.equal(serialized, 0);
    assert.equal(await f.adapter.history.currentCommit(), before);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    await f.stop(),
    `These Tent Node files have problems:\n- ${node.absolute}: Node description must be a string`,
  );
  assert.equal(await f.stop(), undefined);
  assert.deepEqual(await f.adapter.history.retainedPaths(), []);
});

test("Stop returns every equally specific Node beyond old body, count and 8 KiB budgets", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  const names = Array.from({ length: 80 }, (_, index) => `Node${String(index).padStart(3, "0")}`);
  for (const name of names)
    await f.node(name, "resource: ../../src/a.ts", "SECRET_LARGE_BODY" + "汉".repeat(1700));
  await f.seal();
  await f.commit();
  await f.write("src/a.ts", "changed");
  const output = await f.stop();
  assert.equal(output, f.pointers(names));
  assert.ok(Buffer.byteLength(serialize(output!)) > 8192);
  assert.equal(output!.split("\n").filter((line) => line.startsWith("- ")).length, names.length);
  assert.ok(!output!.includes("SECRET_LARGE_BODY"));
});

test("active Stop remains silent while capturing native edits and settling the current source snapshot", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  const node = await f.node("Exact", "resource: ../../src/a.ts");
  await f.seal();
  await f.commit();
  await f.write("src/a.ts", "first save");
  assert.equal(await f.stop(), f.pointers(["Exact"]));
  const raw = node.raw + "\nNative edit during active Stop.\n";
  await f.write(node.file, raw, f.systemRoot);
  await f.write("src/a.ts", "active save");
  assert.equal(await f.stop(f.checkout, true), undefined);
  const head = (await f.adapter.history.currentCommit())!;
  assert.equal(await f.adapter.history.read({ commit: head, path: node.file }), raw);
  assert.equal(await f.stop(), undefined);
});

test("Stop Node read failures propagate and leave the source change available to retry", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  const node = await f.node("Exact", "resource: ../../src/a.ts");
  await f.seal();
  await f.commit();
  const before = await f.adapter.history.currentCommit();
  const raw = node.raw + "\nPending valid native edit.\n";
  await f.write(node.file, raw, f.systemRoot);
  await f.write("src/a.ts", "changed");
  let serialized = 0;
  const emit = (reason: string) => {
    serialized++;
    return serialize(reason);
  };
  const error = Object.assign(new Error("Controlled native Node read failure"), {
    code: "EACCES",
  });
  const read = NodeFs.prototype.readFile;
  const mocked = t.mock.method(NodeFs.prototype, "readFile", function (this: NodeFs, file: string) {
    if (file === node.file) throw error;
    return read.call(this, file);
  });
  try {
    await assert.rejects(
      runTurnHook("codex", { eventName: "Stop", cwd: f.checkout }, emit),
      (caught) => caught === error,
    );
    assert.equal(await f.adapter.history.currentCommit(), before);
  } finally {
    mocked.mock.restore();
  }
  assert.equal(serialized, 0, "a failed Stop cannot serialize a success reminder");
  assert.equal(await f.stop(), f.pointers(["Exact"]));
  const head = (await f.adapter.history.currentCommit())!;
  assert.equal(await f.adapter.history.read({ commit: head, path: node.file }), raw);
});

/** Fails one Stop by breaking the order file every graph read needs, then removes it. */
async function failOneStop(systemRoot: string, checkout: string) {
  const order = path.join(systemRoot, "order.json");
  await fs.writeFile(order, "{broken");
  await assert.rejects(
    runTurnHook("codex", { eventName: "Stop", cwd: checkout }, serialize),
    /order\.json is not valid JSON/,
  );
  await fs.rm(order);
}

test("a failed first Git Stop preserves the HEAD section difference for its successful retry", async (t) => {
  const f = await fixture(t);
  await f.write("docs/spec.md", "# Rules\nbase rules\n# Other\nbase other\n");
  await f.node("Directory", "resource: ../../docs/");
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  await f.seal();
  await f.commit();
  await f.write("docs/spec.md", "# Rules\nchanged rules\n# Other\nbase other\n");
  await failOneStop(f.systemRoot, f.checkout);
  assert.equal(await f.stop(), f.pointers(["Section"]));
  assert.equal(await f.stop(), undefined);
});

test("missing section files do not block first Stop coverage; later creation is listed and deletion is reported once", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  await f.node("Exact", "resource: ../../src/a.ts");
  await f.node("Directory", "resource: ../../docs/");
  await f.node("Missing", 'resource: "../../docs/missing.md#Rules"');
  await f.seal();
  await f.commit();
  await f.write("src/a.ts", "changed");
  assert.equal(await f.stop(), f.pointers(["Exact"]));
  assert.equal(await f.stop(), undefined);
  await f.write("docs/missing.md", "# Rules\nCreated section\n# Other\nUnchanged\n");
  assert.equal(await f.stop(), f.pointers(["Directory"]));
  assert.equal(await f.stop(), undefined);
  await f.write("docs/missing.md", "# Rules\nChanged section\n# Other\nUnchanged\n");
  assert.equal(await f.stop(), f.pointers(["Missing"]));
  assert.equal(await f.stop(), undefined);
  await fs.unlink(path.join(f.checkout, "docs/missing.md"));
  assert.equal(
    await f.stop(),
    f.pointers(["Missing"]) +
      "\n\nThese Tent Node files have problems:\n" +
      `- ${path.join(f.systemRoot, "Missing", "Missing.md")}: Local material does not exist as a file`,
  );
  assert.equal(await f.stop(), undefined);
});

test("a listed Node's reference problem is named once, across quiet Stops, until it is fixed and breaks again", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  await f.write("docs/material.md", "# Needed\nText\n");
  await f.node("Watch", "resource: ../../src/a.ts\nsources:\n  - resource: ../../docs/material.md");
  await f.seal();
  await f.commit();
  const problem =
    "\n\nThese Tent Node files have problems:\n" +
    `- ${path.join(f.systemRoot, "Watch", "Watch.md")}: Local material does not exist as a file`;
  await fs.unlink(path.join(f.checkout, "docs/material.md"));
  await f.write("src/a.ts", "changed");
  assert.equal(await f.stop(), f.pointers(["Watch"]) + problem);
  assert.equal(await f.stop(), undefined);
  await f.write("src/a.ts", "changed again");
  assert.equal(await f.stop(), f.pointers(["Watch"]));
  await f.write("docs/material.md", "# Needed\nBack\n");
  await f.write("src/a.ts", "third");
  assert.equal(await f.stop(), f.pointers(["Watch"]));
  await fs.unlink(path.join(f.checkout, "docs/material.md"));
  await f.write("src/a.ts", "fourth");
  assert.equal(await f.stop(), f.pointers(["Watch"]) + problem);
});

test("changed files no Node covers get one reminder; a covered file whose other section changed stays quiet", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "base");
  await f.write("docs/guide.md", "# Rules\nrules\n# Other\nother\n");
  await f.node("Rules", 'resource: "../../docs/guide.md#Rules"');
  await f.seal();
  await f.commit();
  await f.write("src/a.ts", "changed");
  assert.equal(await f.stop(), uncovered);
  assert.equal(await f.stop(), undefined);
  await f.write("docs/guide.md", "# Rules\nrules\n# Other\nchanged\n");
  assert.equal(await f.stop(), undefined);
  await f.write("docs/guide.md", "# Rules\nchanged\n# Other\nchanged\n");
  assert.equal(await f.stop(), f.pointers(["Rules"]));
});

test("goals whose type, description, status or body changed are named once; tags and other types stay quiet", async (t) => {
  const f = await fixture(t);
  const goal = (description: string, body: string, tags = "[]") =>
    `---\nid: node-aim\ntype: goal\ndescription: ${description}\ntags: ${tags}\n---\n${body}\n`;
  await f.write("Aim/Aim.md", goal("Sign in.", "Users sign in."), f.systemRoot);
  await f.node("Rule", "description: A rule");
  await f.seal();
  await f.commit();
  assert.equal(await f.stop(), undefined);
  const named =
    "These goals changed this turn:\n" +
    `- Aim: ${path.join(f.systemRoot, "Aim", "Aim.md")}` +
    "\n\nA goal changes only when the user's will does. If the user has not been told, tell them what changed and why. If the edit only made the goal fit the work, undo it and tell the user the work differs from the goal. Leave an edit you did not make; another session answers for it.";
  await f.write("Aim/Aim.md", goal("Sign in.", "Users sign in with a code."), f.systemRoot);
  assert.equal(await f.stop(), named);
  assert.equal(await f.stop(), undefined);
  await f.write(
    "Aim/Aim.md",
    goal("Sign in.", "Users sign in with a code.", "[login]"),
    f.systemRoot,
  );
  await f.write(
    "Rule/Rule.md",
    "---\nid: node-rule\ntype: prompt\ndescription: Another rule\n---\nChanged.\n",
    f.systemRoot,
  );
  assert.equal(await f.stop(), undefined);
  await f.write(
    "Aim/Aim.md",
    goal("Sign in fast.", "Users sign in with a code.", "[login]"),
    f.systemRoot,
  );
  assert.equal(await f.stop(), named);
  await f.write(
    "Aim/Aim.md",
    goal("Sign in fast.", "Users sign in with a code.", "[login]").replace(
      "tags: [login]",
      "tags: [login]\nstatus: deprecated",
    ),
    f.systemRoot,
  );
  assert.equal(await f.stop(), named);
  const snapshots = path.join(f.systemRoot, "temp", "stop-snapshots");
  for (const file of await fs.readdir(snapshots)) {
    const saved = JSON.parse(await fs.readFile(path.join(snapshots, file), "utf8"));
    await fs.writeFile(
      path.join(snapshots, file),
      JSON.stringify({ ...saved, history: "f".repeat(64) }),
    );
  }
  await f.write(
    "Aim/Aim.md",
    goal("Sign in.", "A history the Tent no longer holds."),
    f.systemRoot,
  );
  assert.equal(await f.stop(), undefined);
});

test("a goal whose body differs only in trailing whitespace is not named", async (t) => {
  const f = await fixture(t);
  const raw = "---\nid: node-aim\ntype: goal\n---\nUsers sign in.";
  await f.write("Aim/Aim.md", raw, f.systemRoot);
  await f.seal();
  await f.commit();
  assert.equal(await f.stop(), undefined);
  await f.write("Aim/Aim.md", `${raw}\n`, f.systemRoot);
  assert.equal(await f.stop(), undefined);
  await f.write("Aim/Aim.md", `${raw} With a code.\n`, f.systemRoot);
  assert.match((await f.stop())!, /^These goals changed this turn:\n- Aim: /);
});

test("missing section files do not consume the HEAD baseline when the first Stop must retry", async (t) => {
  const f = await fixture(t);
  await f.write("docs/current.md", "# Rules\nOriginal section\n");
  await f.node("Directory", "resource: ../../docs/");
  await f.node("Current", 'resource: "../../docs/current.md#Rules"');
  await f.node("Missing", 'resource: "../../docs/missing.md#Rules"');
  await f.seal();
  await f.commit();
  await f.write("docs/current.md", "# Rules\nChanged section\n");
  await failOneStop(f.systemRoot, f.checkout);
  assert.equal(await f.stop(), f.pointers(["Current"]));
  assert.equal(await f.stop(), undefined);
});

test("section source ENOTDIR observes absence and still detects a later readable section", async (t) => {
  const f = await fixture(t);
  await f.write("docs/spec.md", "# Rules\nOriginal section\n");
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  await f.seal();
  await f.commit();
  await f.write("docs/spec.md", "# Rules\nChanged section before disappearing\n");
  const error = Object.assign(new Error("Controlled source disappears during open"), {
    code: "ENOTDIR",
  });
  const filename = path.join(f.checkout, "docs/spec.md");
  const readFile = fs.readFile;
  let blocked = 0;
  const mocked = t.mock.method(fs, "readFile", (...args: Parameters<typeof readFile>) => {
    if (path.relative(filename, String(args[0])) === "") {
      blocked++;
      throw error;
    }
    return readFile(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await f.stop(), f.pointers(["Section"]));
    assert.ok(blocked > 0);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  await f.write("docs/spec.md", "# Rules\nNew readable section\n");
  assert.equal(await f.stop(), f.pointers(["Section"]));
  assert.equal(await f.stop(), undefined);
});

test("a section source behind a link is read through it", async (t) => {
  const f = await fixture(t);
  await f.write("docs/spec.md", "# Rules\nOriginal section\n");
  await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
  await f.seal();
  await f.commit();
  const external = path.join(f.root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "spec.md"), "# Rules\nChanged behind the link\n");
  await fs.rm(path.join(f.checkout, "docs"), { recursive: true });
  await fs.symlink(
    external,
    path.join(f.checkout, "docs"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(await f.stop(), f.pointers(["Section"]));
});

for (const failure of ["EACCES", "invalid UTF-8"] as const) {
  test(`section source ${failure} remains a Stop failure rather than an absent section`, async (t) => {
    const f = await fixture(t);
    await f.write("docs/spec.md", "# Rules\nOriginal section\n");
    await f.node("Section", 'resource: "../../docs/spec.md#Rules"');
    await f.seal();
    await f.commit();
    let serialized = 0;
    const emit = (reason: string) => {
      serialized++;
      return serialize(reason);
    };
    if (failure === "EACCES") {
      await f.write("docs/spec.md", "# Rules\nChanged section\n");
      const error = Object.assign(new Error("Controlled section read failure"), { code: "EACCES" });
      const readFile = fs.readFile;
      const filename = path.join(f.checkout, "docs/spec.md");
      const mocked = t.mock.method(fs, "readFile", (...args: Parameters<typeof readFile>) => {
        if (path.relative(filename, String(args[0])) === "") throw error;
        return readFile(...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          runTurnHook("codex", { eventName: "Stop", cwd: f.checkout }, emit),
          (caught) => caught === error,
        );
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    } else {
      await fs.writeFile(path.join(f.checkout, "docs/spec.md"), Buffer.from([0xff]));
      await assert.rejects(
        runTurnHook("codex", { eventName: "Stop", cwd: f.checkout }, emit),
        (caught) => (caught as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA",
      );
    }
    assert.equal(serialized, 0);
    await assert.rejects(fs.access(path.join(f.systemRoot, "temp/stop-snapshots")), {
      code: "ENOENT",
    });
  });
}
