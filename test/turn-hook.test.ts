import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { findPreparedHookWorkspace } from "../src/fs/hook-material-index.js";
import { readTurnRecord, turnReviewIdentity, readTurnDirty } from "../src/fs/turn-review-state.js";
import {
  startTurnObservation,
  changedTurnFiles,
  readTurnHead,
  parseTurnStatus,
  turnDirtyPaths,
} from "../src/core/return/turn-changes.js";
import { runTurnHook } from "../src/cli/turn-hook.js";
import { runToolHook } from "../src/cli/tool-hook.js";
import { TOOL_REVIEW_ACTION } from "../src/core/return/tool-turn-review.js";
import { hasStopReviewClaim } from "../src/fs/stop-review-claim.js";
import { seedSessionTurnDirty } from "../src/fs/turn-dirty-baseline.js";
import { recordSectionFingerprints } from "../src/fs/section-fingerprint-baseline.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "turn-hook-"));
  initializeFixtureRepository(root);
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { encoding: "utf8", windowsHide: true },
    );
  await fs.writeFile(path.join(root, ".git/empty-attributes"), "");
  git("config", "core.attributesFile", path.join(root, ".git/empty-attributes"));
  await fs.mkdir(path.join(root, "src"));
  const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);
  await write(".gitignore", ".tent/\nignored.txt\n");
  await write("src/a.ts", "before\n");
  await write("src/b.ts", "before\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  await scaffoldInWorkspace(openTestFs(root), { name: "turn" });
  const system = path.join(root, ".tent");
  await fs.mkdir(path.join(system, ".git"));
  for (const [name, prefix] of [
    ["Module", "src/"],
    ["Other", "lib/"],
  ]) {
    await fs.mkdir(path.join(system, name!));
    await fs.writeFile(
      path.join(system, name!, name + ".md"),
      `---\nid: node-${name!.toLowerCase()}\ntype: prompt\nsources:\n  - resource: ../../${prefix}\n    track: structure\n---\nRule\n`,
    );
  }
  await loadStopMaterialIndex(system, root);
  // An ordinary Git boundary must contain every read-only discovery before any Hook call.
  assert.equal((await findPreparedHookWorkspace(root))?.systemRoot, system);
  const serialize = (reason: string) => JSON.stringify({ decision: "block", reason }) + "\n";
  const hook = (eventName: string, extra: Record<string, unknown> = {}, host = "codex") =>
    runTurnHook(
      host,
      { eventName, cwd: root, sessionId: "session", turnId: "turn", prompt: "work", ...extra },
      serialize,
    );
  return { root, system, git, write, hook };
}

test("turn start reads HEAD metadata only, including packed and linked checkout refs", async (t) => {
  const f = await fixture(t);
  const expected = f.git("rev-parse", "HEAD").trim();
  const execute = childProcess.execFile;
  const list = fs.readdir,
    stat = fs.lstat,
    read = fs.readFile;
  childProcess.execFile = (() => {
    throw new Error("UPS must not spawn Git");
  }) as unknown as typeof execute;
  fs.readdir = (() => {
    throw new Error("UPS must not enumerate project files");
  }) as typeof list;
  fs.lstat = (() => {
    throw new Error("UPS must not stat project files");
  }) as typeof stat;
  fs.readFile = (async (...args: Parameters<typeof read>) => {
    assert.ok(String(args[0]).startsWith(path.join(f.root, ".git") + path.sep));
    return read(...args);
  }) as typeof read;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await startTurnObservation(f.root, 123), { startedAt: 123, head: expected });
  } finally {
    childProcess.execFile = execute;
    fs.readdir = list;
    fs.lstat = stat;
    fs.readFile = read;
    syncBuiltinESMExports();
  }
  f.git("pack-refs", "--all");
  assert.equal(await readTurnHead(f.root), expected);
  const linked = path.join(f.root, ".worktrees/linked");
  f.git("worktree", "add", "--quiet", "--detach", linked, expected);
  await f.write("src/a.ts", "second commit\n");
  f.git("add", "src/a.ts");
  f.git("commit", "--quiet", "-m", "second");
  assert.equal(await readTurnHead(linked), expected);
  assert.notEqual(await readTurnHead(f.root), expected);
  const unborn = path.join(f.root, "unborn");
  initializeFixtureRepository(unborn);
  assert.deepEqual(await startTurnObservation(unborn, 456), { startedAt: 456, head: null });
});

test("status timestamp selection includes committed writes and accepts preserved-time misses", async (t) => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 5000);
  await f.write("src/a.ts", "preexisting dirt\n");
  await fs.utimes(path.join(f.root, "src/a.ts"), old, old);
  const before = await startTurnObservation(f.root);
  f.git("add", "src/a.ts");
  f.git("commit", "--quiet", "-m", "commit preexisting dirt");
  assert.deepEqual(await changedTurnFiles(f.root, before, []), []);
  const current = await startTurnObservation(f.root);
  await f.write("src/a.ts", "fresh committed write\n");
  await f.write("src/new.ts", "fresh new file\n");
  const changedTime = new Date(current.startedAt + 2000);
  for (const file of ["src/a.ts", "src/new.ts"])
    await fs.utimes(path.join(f.root, file), changedTime, changedTime);
  f.git("add", "src");
  f.git("commit", "--quiet", "-m", "during turn");
  assert.deepEqual(await changedTurnFiles(f.root, current, []), ["src/a.ts", "src/new.ts"]);
  const preserved = await startTurnObservation(f.root);
  await f.write("src/a.ts", "preserved timestamp\n");
  await fs.utimes(path.join(f.root, "src/a.ts"), old, old);
  assert.deepEqual(await changedTurnFiles(f.root, preserved, []), []);
});

test("committed deleted gitlinks stay excluded while ordinary deletions and writes stay visible", async (t) => {
  const f = await fixture(t);
  const target = "src/vendor";
  await fs.mkdir(path.join(f.root, target));
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.git("rev-parse", "HEAD").trim()},${target}`,
  );
  f.git("commit", "--quiet", "-m", "fixture gitlink");
  assert.match(f.git("ls-tree", "HEAD", "--", target), /^160000 commit /);
  await seedSessionTurnDirty(f.system, f.root, f.root, "codex", "session");
  assert.deepEqual(await readTurnDirty(f.system, "codex", "session", f.root), []);
  await f.hook("UserPromptSubmit");
  f.git("update-index", "--force-remove", target);
  await fs.rmdir(path.join(f.root, target));
  f.git("commit", "--quiet", "-m", "remove gitlink during turn");
  assert.equal(f.git("diff", "--name-only", "HEAD^", "HEAD").trim(), target);
  assert.equal(await f.hook("Stop"), "{}\n");

  await f.hook("UserPromptSubmit", { turnId: "ordinary" });
  const ordinary = await readTurnRecord(f.system, "codex", "session", "ordinary");
  assert.ok(ordinary);
  await fs.unlink(path.join(f.root, "src/a.ts"));
  await f.write("src/b.ts", "fresh ordinary change\n");
  const changedTime = new Date(ordinary.baseline.startedAt + 2000);
  await fs.utimes(path.join(f.root, "src/b.ts"), changedTime, changedTime);
  f.git("add", "src");
  f.git("commit", "--quiet", "-m", "ordinary deletion and write during turn");
  const output = JSON.parse(await f.hook("Stop", { turnId: "ordinary" }));
  assert.match(output.reason, /node-module/);
  assert.match(output.reason, /src\/a\.ts/);
  assert.match(output.reason, /src\/b\.ts/);
  assert.doesNotMatch(output.reason, /src\/vendor/);
});

test("committed gitlink replacement keeps the fresh ordinary file visible", async (t) => {
  const f = await fixture(t);
  const target = "src/vendor";
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.git("rev-parse", "HEAD").trim()},${target}`,
  );
  f.git("commit", "--quiet", "-m", "fixture gitlink");
  await seedSessionTurnDirty(f.system, f.root, f.root, "codex", "session");
  await f.hook("UserPromptSubmit");
  const original = await readTurnRecord(f.system, "codex", "session", "turn");
  assert.ok(original);
  await f.write(target, "fresh ordinary replacement\n");
  const changedTime = new Date(original.baseline.startedAt + 2000);
  await fs.utimes(path.join(f.root, target), changedTime, changedTime);
  f.git("add", target);
  f.git("commit", "--quiet", "-m", "replace gitlink with ordinary file during turn");
  assert.match(f.git("ls-tree", "HEAD", "--", target), /^100644 blob /);
  assert.match(JSON.parse(await f.hook("Stop")).reason, /node-module.*src\/vendor/);
});

test("malformed HEAD refs cannot escape Git metadata and the hook stays quiet", async (t) => {
  const f = await fixture(t);
  const head = path.join(f.root, ".git/HEAD");
  const original = await fs.readFile(head, "utf8");
  await f.write("outside", "a".repeat(40) + "\n");
  try {
    for (const ref of [
      "refs/a\\..\\..\\..\\outside",
      "refs/../outside",
      "refs//heads/main",
      "refs/./heads/main",
      "refs/heads/x:stream",
    ]) {
      await fs.writeFile(head, "ref: " + ref + "\n");
      await assert.rejects(readTurnHead(f.root), /HEAD is unavailable/);
      assert.equal(await f.hook("UserPromptSubmit"), "{}\n");
      assert.equal(await readTurnRecord(f.system, "codex", "session", "turn"), undefined);
    }
  } finally {
    await fs.writeFile(head, original);
  }
});

test("deletions use SessionStart then previous Stop dirty paths, with unknown baseline quiet", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, "src/a.ts"));
  await seedSessionTurnDirty(f.system, f.root, f.root, "codex", "session");
  assert.deepEqual(await readTurnDirty(f.system, "codex", "session", f.root), ["src/a.ts"]);
  await f.hook("UserPromptSubmit");
  assert.equal(await f.hook("Stop"), "{}\n");
  await f.hook("UserPromptSubmit", { turnId: "next" });
  await fs.unlink(path.join(f.root, "src/b.ts"));
  const output = JSON.parse(await f.hook("Stop", { turnId: "next" }));
  assert.match(output.reason, /src\/b\.ts/);
  assert.doesNotMatch(output.reason, /src\/a\.ts/);
  assert.deepEqual(await readTurnDirty(f.system, "codex", "session", f.root), [
    "src/a.ts",
    "src/b.ts",
  ]);
  const unknown = await fixture(t);
  await unknown.hook("UserPromptSubmit");
  await fs.unlink(path.join(unknown.root, "src/a.ts"));
  assert.equal(await unknown.hook("Stop"), "{}\n");
});

test("both host namespaces block once, retain exact wording, and preserve their own continuation baseline", async (t) => {
  for (const host of ["codex", "claude-code"]) {
    const f = await fixture(t);
    assert.equal(await f.hook("Stop", {}, host), "{}\n");
    assert.equal(await f.hook("UserPromptSubmit", {}, host), "{}\n");
    const original = await readTurnRecord(f.system, host, "session", "turn");
    assert.ok(original);
    await f.write("src/a.ts", "shell\n");
    const changedTime = new Date(original.baseline.startedAt + 2000);
    await fs.utimes(path.join(f.root, "src/a.ts"), changedTime, changedTime);
    const output = JSON.parse(await f.hook("Stop", {}, host));
    assert.equal(output.decision, "block");
    assert.equal(
      output.reason,
      `Tent: these Nodes cover files changed during this turn:\n- Module (node-module, .tent/Module/Module.md): src/a.ts\n${TOOL_REVIEW_ACTION}`,
    );
    assert.equal(await f.hook("Stop", {}, host), "{}\n");
    await f.hook("UserPromptSubmit", { turnId: "continuation", prompt: output.reason }, host);
    assert.deepEqual(await readTurnRecord(f.system, host, "session", "continuation"), original);
    assert.equal(await turnReviewIdentity(f.system, host, "session", "continuation"), "turn");
    assert.equal(
      await f.hook("Stop", { turnId: "continuation", stopHookActive: true }, host),
      "{}\n",
    );
    assert.equal(await f.hook("Stop", { turnId: "continuation" }, host), "{}\n");
    const old = new Date(Date.now() - 5000);
    await fs.utimes(path.join(f.root, "src/a.ts"), old, old);
    await f.hook("UserPromptSubmit", { turnId: "next", prompt: "new work" }, host);
    assert.equal((await readTurnRecord(f.system, host, "session", "next"))?.turnId, "next");
    assert.equal(await f.hook("Stop", { turnId: "next" }, host), "{}\n");
  }
});

test("native claims are shared with Stop, and uncovered files alone never request continuation", async (t) => {
  const f = await fixture(t);
  await f.hook("UserPromptSubmit");
  const original = await readTurnRecord(f.system, "codex", "session", "turn");
  assert.ok(original);
  const changedTime = new Date(original.baseline.startedAt + 2000);
  await f.write("src/a.ts", "native\n");
  await fs.utimes(path.join(f.root, "src/a.ts"), changedTime, changedTime);
  assert.match(
    await runToolHook("codex", {
      hook_event_name: "PostToolUse",
      cwd: f.root,
      session_id: "session",
      turn_id: "turn",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** End Patch" },
      tool_response: "Success. Updated the following files:\nM src/a.ts\n",
    }),
    /node-module/,
  );
  assert.equal(await f.hook("Stop"), "{}\n");
  await f.write("outside.ts", "uncovered\n");
  await fs.utimes(path.join(f.root, "outside.ts"), changedTime, changedTime);
  assert.equal(await f.hook("Stop"), "{}\n");
  await fs.mkdir(path.join(f.root, "lib"));
  await f.write("lib/b.ts", "shell\n");
  for (const file of ["lib/b.ts", "lib"])
    await fs.utimes(path.join(f.root, file), changedTime, changedTime);
  assert.match(await f.hook("Stop"), /node-other/);
});

test("parallel Stop calls produce one bounded block and claim only rendered Nodes", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 7; i++) {
    await fs.mkdir(path.join(f.system, "Extra" + i));
    await fs.writeFile(
      path.join(f.system, `Extra${i}/Extra${i}.md`),
      `---\nid: node-extra${i}\ntype: prompt\nsources:\n  - resource: ../../src/a.ts\n---\nRule\n`,
    );
  }
  await loadStopMaterialIndex(f.system, f.root);
  await f.hook("UserPromptSubmit");
  const original = await readTurnRecord(f.system, "codex", "session", "turn");
  assert.ok(original);
  await f.write("src/a.ts", "shell\n");
  const changedTime = new Date(original.baseline.startedAt + 2000);
  await fs.utimes(path.join(f.root, "src/a.ts"), changedTime, changedTime);
  const outputs = await Promise.all([f.hook("Stop"), f.hook("Stop")]);
  assert.equal(outputs.filter((out) => out !== "{}\n").length, 1);
  const output = outputs.find((out) => out !== "{}\n")!;
  assert.ok(Buffer.byteLength(output) <= 2048);
  assert.match(output, /\+3 more modules/);
  assert.equal(
    await hasStopReviewClaim(
      f.system,
      "codex",
      "session",
      JSON.stringify(["turn", "node", "node-extra6"]),
    ),
    false,
  );
});

test("no start, malformed identity, non-Git and missing prepared index stay quiet", async (t) => {
  const f = await fixture(t);
  await f.write("src/a.ts", "change\n");
  assert.equal(await f.hook("Stop"), "{}\n");
  assert.equal(await f.hook("UserPromptSubmit", { turnId: undefined }), "{}\n");
  assert.equal(await f.hook("Stop", { stopHookActive: true }), "{}\n");
  const other = path.join(f.root, "isolated");
  initializeFixtureRepository(other);
  assert.equal(await f.hook("UserPromptSubmit", { cwd: other }), "{}\n");
});

test("Stop shares section filtering, unknown seeding and named-only settling with native writes", async (t) => {
  const f = await fixture(t);
  await f.write("notes.md", "# One\nbefore\n# Two\nbefore\n");
  for (const name of ["One", "Two"]) {
    await fs.mkdir(path.join(f.system, name));
    await fs.writeFile(
      path.join(f.system, `${name}/${name}.md`),
      `---\nid: node-${name.toLowerCase()}\ntype: prompt\nsources:\n  - resource: ../../notes.md#${name}\n---\nRule\n`,
    );
  }
  const index = await loadStopMaterialIndex(f.system, f.root);
  await recordSectionFingerprints(f.system, f.root, index);
  await f.hook("UserPromptSubmit");
  const original = await readTurnRecord(f.system, "codex", "session", "turn");
  assert.ok(original);
  await f.write("notes.md", "# One\nafter\n# Two\nbefore\n");
  const changedTime = new Date(original.baseline.startedAt + 2000);
  await fs.utimes(path.join(f.root, "notes.md"), changedTime, changedTime);
  const read = fs.readFile;
  const contentReads: string[] = [];
  fs.readFile = (async (...args: Parameters<typeof read>) => {
    const name = String(args[0]);
    if (
      name.startsWith(f.root + path.sep) &&
      !name.includes(path.sep + ".tent" + path.sep) &&
      !name.includes(path.sep + ".git" + path.sep) &&
      !name.endsWith("index.md")
    ) {
      contentReads.push(path.relative(f.root, name));
      assert.equal(path.relative(f.root, name), "notes.md");
    }
    return read(...args);
  }) as typeof read;
  syncBuiltinESMExports();
  let output: string;
  try {
    output = await f.hook("Stop");
  } finally {
    fs.readFile = read;
    syncBuiltinESMExports();
  }
  assert.match(output, /node-one/);
  assert.doesNotMatch(output, /node-two/);
  assert.equal(contentReads.length, 2);
  await f.hook("UserPromptSubmit", { turnId: "next" });
  const next = await readTurnRecord(f.system, "codex", "session", "next");
  assert.ok(next);
  await f.write("notes.md", "# One\nafter\n# Two\nnew two\n");
  const nextTime = new Date(next.baseline.startedAt + 2000);
  await fs.utimes(path.join(f.root, "notes.md"), nextTime, nextTime);
  assert.match(await f.hook("Stop", { turnId: "next" }), /node-two/);

  await fs.mkdir(path.join(f.system, "Unknown"));
  await f.write("unknown.md", "# Unknown\nbefore\n");
  await fs.writeFile(
    path.join(f.system, "Unknown/Unknown.md"),
    "---\nid: node-unknown\ntype: prompt\nsources:\n  - resource: ../../unknown.md#Unknown\n---\nRule\n",
  );
  await loadStopMaterialIndex(f.system, f.root);
  await f.hook("UserPromptSubmit", { turnId: "unknown" });
  const unknown = await readTurnRecord(f.system, "codex", "session", "unknown");
  assert.ok(unknown);
  await f.write("unknown.md", "# Unknown\nafter\n");
  const unknownTime = new Date(unknown.baseline.startedAt + 2000);
  await fs.utimes(path.join(f.root, "unknown.md"), unknownTime, unknownTime);
  assert.equal(await f.hook("Stop", { turnId: "unknown" }), "{}\n");
});

test("status-listed paths use Git scope while tracked submodules stay excluded", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "src/nested"));
  await f.write("src/nested/file.ts", "before\n");
  f.git("add", "src");
  f.git("commit", "--quiet", "-m", "nested before boundary");
  initializeFixtureRepository(path.join(f.root, "src/nested"));
  await fs.mkdir(path.join(f.root, "vendor"));
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.git("rev-parse", "HEAD").trim()},vendor`,
  );
  const before = await startTurnObservation(f.root);
  const changedTime = new Date(before.startedAt + 2000);
  await f.write("src/nested/file.ts", "after\n");
  await f.write("vendor/file.ts", "after\n");
  for (const file of ["src/nested/file.ts", "vendor/file.ts"])
    await fs.utimes(path.join(f.root, file), changedTime, changedTime);
  assert.ok((await fs.stat(path.join(f.root, "src/nested/file.ts"))).mtimeMs >= before.startedAt);
  const status = await turnDirtyPaths(f.root);
  assert.ok(status.paths.some((item) => item.address === "src/nested/file.ts"));
  assert.deepEqual(await changedTurnFiles(f.root, before, [], status), ["src/nested/file.ts"]);
  f.git("commit", "--quiet", "-m", "commit tracked nested path", "--", "src/nested/file.ts");
  await f.write("src/nested/file.ts", "fresh status and HEAD candidate\n");
  await fs.utimes(path.join(f.root, "src/nested/file.ts"), changedTime, changedTime);
  assert.deepEqual(await changedTurnFiles(f.root, before), ["src/nested/file.ts"]);
});

test("HEAD and enumerated candidates retain nested repository and symlink boundaries", async (t) => {
  const f = await fixture(t);
  const before = await startTurnObservation(f.root);
  const changedTime = new Date(before.startedAt + 2000);
  await fs.mkdir(path.join(f.root, "src/committed"));
  await f.write("src/committed/file.ts", "fresh committed\n");
  await fs.utimes(path.join(f.root, "src/committed/file.ts"), changedTime, changedTime);
  assert.ok(
    (await fs.stat(path.join(f.root, "src/committed/file.ts"))).mtimeMs >= before.startedAt,
  );
  f.git("add", "src");
  f.git("commit", "--quiet", "-m", "commit before nested boundary");
  initializeFixtureRepository(path.join(f.root, "src/committed"));
  assert.equal(f.git("status", "--porcelain=v2"), "");
  assert.deepEqual(await changedTurnFiles(f.root, before, []), []);

  const untracked = await startTurnObservation(f.root);
  await fs.mkdir(path.join(f.root, "loose/nested"), { recursive: true });
  await f.write("loose/code.ts", "fresh\n");
  await f.write("loose/nested/hidden.ts", "nested\n");
  initializeFixtureRepository(path.join(f.root, "loose/nested"));
  const target = path.join(f.system, "temp/symlink-target");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "hidden.ts"), "outside boundary\n");
  await fs.symlink(target, path.join(f.root, "loose/link"), "junction");
  const enumeratedTime = new Date(untracked.startedAt + 2000);
  for (const file of ["loose/code.ts", "loose/nested/hidden.ts", "loose/nested", "loose"])
    await fs.utimes(path.join(f.root, file), enumeratedTime, enumeratedTime);
  await fs.lutimes(path.join(f.root, "loose/link"), enumeratedTime, enumeratedTime);
  const stat = fs.lstat;
  let markerCalls = 0;
  fs.lstat = ((...args: Parameters<typeof stat>) => {
    if (String(args[0]) === path.join(f.root, "loose/.git")) markerCalls++;
    return stat(...args);
  }) as typeof stat;
  try {
    assert.deepEqual(await changedTurnFiles(f.root, untracked, []), [
      "loose/code.ts",
      "loose/link",
    ]);
    assert.equal(markerCalls, 1);
  } finally {
    fs.lstat = stat;
  }
});

test("a newly ignored untracked path is not misreported as a deletion", async (t) => {
  const f = await fixture(t);
  await f.write("loose.txt", "before\n");
  const before = await startTurnObservation(f.root);
  await f.write(".gitignore", ".tent/\nignored.txt\nloose.txt\n");
  await f.write("loose.txt", "now ignored\n");
  const changedTime = new Date(before.startedAt + 2000);
  for (const file of [".gitignore", "loose.txt"])
    await fs.utimes(path.join(f.root, file), changedTime, changedTime);
  assert.deepEqual(await changedTurnFiles(f.root, before), [".gitignore"]);
});

test("leaving Git inventory is not deletion when a tracked file still exists unchanged", async (t) => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 5000);
  await fs.utimes(path.join(f.root, "src/a.ts"), old, old);
  await f.hook("UserPromptSubmit");
  const before = await startTurnObservation(f.root);
  f.git("rm", "--cached", "--quiet", "--", "src/a.ts");
  await f.write(".gitignore", ".tent/\nignored.txt\nsrc/a.ts\n");
  const changedTime = new Date(before.startedAt + 2000);
  await fs.utimes(path.join(f.root, ".gitignore"), changedTime, changedTime);
  assert.deepEqual(await changedTurnFiles(f.root, before), [".gitignore"]);
  assert.equal(await f.hook("Stop"), "{}\n");
});

test("new untracked directories are timestamp-gated and ignored children stay excluded", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", ".tent/\nignored.txt\n*.tmp\n");
  f.git("add", ".gitignore");
  f.git("commit", "--quiet", "-m", "ignore fixture children");
  const before = await startTurnObservation(f.root);
  await fs.mkdir(path.join(f.root, "lib/new"), { recursive: true });
  await f.write("lib/new/code.ts", "fresh\n");
  await f.write("lib/new/ignored.tmp", "ignored\n");
  const changedTime = new Date(before.startedAt + 2000);
  for (const file of ["lib/new/code.ts", "lib/new/ignored.tmp", "lib/new", "lib"])
    await fs.utimes(path.join(f.root, file), changedTime, changedTime);
  assert.deepEqual(await changedTurnFiles(f.root, before), ["lib/new/code.ts"]);
  const old = new Date(Date.now() - 5000);
  await fs.utimes(path.join(f.root, "lib"), old, old);
  const later = await startTurnObservation(f.root);
  await f.write("lib/new/code.ts", "changed inside an old untracked directory\n");
  const laterTime = new Date(later.startedAt + 2000);
  await fs.utimes(path.join(f.root, "lib/new/code.ts"), laterTime, laterTime);
  assert.deepEqual(await changedTurnFiles(f.root, later), []);
});

test("initial commit paths use the empty-tree comparison without a prior HEAD", async (t) => {
  const f = await fixture(t);
  const root = path.join(f.root, "unborn");
  initializeFixtureRepository(root);
  const before = await startTurnObservation(root);
  await fs.writeFile(path.join(root, "first.txt"), "first\n");
  const changedTime = new Date(before.startedAt + 2000);
  await fs.utimes(path.join(root, "first.txt"), changedTime, changedTime);
  for (const args of [
    ["add", "."],
    ["commit", "--quiet", "-m", "first"],
  ])
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        `core.attributesFile=${path.join(f.root, ".git/empty-attributes")}`,
        ...args,
      ],
      { windowsHide: true },
    );
  assert.deepEqual(await changedTurnFiles(root, before, []), ["first.txt"]);
});

test("porcelain parser preserves paths and excludes gitlinks and operational paths", () => {
  const oid = "a".repeat(40);
  assert.deepEqual(
    parseTurnStatus(
      [
        `1 .M N... 100644 100644 100644 ${oid} ${oid} src/a b.ts`,
        "? new/",
        "! new/skip.tmp",
        `1 M. S... 160000 160000 160000 ${oid} ${oid} vendor`,
        "? .tent/temp/",
        "",
      ].join("\0"),
    ),
    {
      paths: [
        { address: "src/a b.ts", directory: false },
        { address: "new/", directory: true },
      ],
      ignored: ["new/skip.tmp"],
    },
  );
});

test("every silent Stop still observes once and saves the next deletion baseline", async (t) => {
  const f = await fixture(t);
  const execute = childProcess.execFile;
  let statuses = 0;
  childProcess.execFile = ((...args: unknown[]) => {
    if (Array.isArray(args[1]) && args[1].includes("status")) statuses++;
    return (execute as (...values: unknown[]) => unknown)(...args);
  }) as unknown as typeof execute;
  syncBuiltinESMExports();
  try {
    await fs.unlink(path.join(f.root, "src/a.ts"));
    assert.equal(await f.hook("Stop", { turnId: undefined }), "{}\n");
    assert.equal(statuses, 1);
    assert.deepEqual(await readTurnDirty(f.system, "codex", "session", f.root), ["src/a.ts"]);
    await f.hook("UserPromptSubmit");
    assert.equal(statuses, 1);
    await fs.unlink(path.join(f.root, "src/b.ts"));
    assert.equal(await f.hook("Stop", { stopHookActive: true }), "{}\n");
    assert.equal(statuses, 2);
    assert.deepEqual(await readTurnDirty(f.system, "codex", "session", f.root), [
      "src/a.ts",
      "src/b.ts",
    ]);
    await f.hook("UserPromptSubmit", { turnId: "next" });
    assert.equal(await f.hook("Stop", { turnId: "next" }), "{}\n");
    assert.equal(statuses, 3);
  } finally {
    childProcess.execFile = execute;
    syncBuiltinESMExports();
  }
});

test("status retains its configured clean-filter behavior under the explicit Git exception", async (t) => {
  const f = await fixture(t);
  const log = path.join(f.root, ".git/filter-calls");
  const script = path.join(f.root, ".git/filter.cjs");
  await fs.writeFile(
    script,
    `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(log)}, "called\\n"); process.stdout.write(fs.readFileSync(0));`,
  );
  f.git("config", "filter.fixture.clean", `node "${script.split(path.sep).join("/")}"`);
  await f.write(".gitattributes", "src/a.ts filter=fixture\n");
  f.git("add", ".gitattributes", "src/a.ts");
  f.git("commit", "--quiet", "-m", "fixture clean filter");
  await fs.writeFile(log, "");
  const before = await startTurnObservation(f.root);
  // Equal size and a distinct mtime make Git compare content instead of deciding from size.
  await f.write("src/a.ts", "AFTER!\n");
  const changedTime = new Date(before.startedAt + 2000);
  await fs.utimes(path.join(f.root, "src/a.ts"), changedTime, changedTime);
  assert.deepEqual(await changedTurnFiles(f.root, before, []), ["src/a.ts"]);
  assert.ok((await fs.readFile(log, "utf8")).length > 0);
});

test("status metadata is concurrent, observes only listed paths, and preserves errors", async (t) => {
  const f = await fixture(t);
  const before = await startTurnObservation(f.root);
  const changedTime = new Date(before.startedAt + 2000);
  await f.write("src/a.ts", "fresh\n");
  await fs.utimes(path.join(f.root, "src/a.ts"), changedTime, changedTime);
  const syncStat = nativeFs.lstatSync,
    asyncStat = fs.lstat;
  const syncList = nativeFs.readdirSync,
    asyncList = fs.readdir;
  const calls = new Map<string, number>();
  let fail = false;
  let active = 0;
  let peak = 0;
  const unavailable = Object.assign(new Error("unavailable fixture metadata"), { code: "EACCES" });
  const record = (filename: unknown) => {
    const name = String(filename);
    calls.set(name, (calls.get(name) ?? 0) + 1);
    assert.notEqual(name, path.join(f.root, "src/b.ts"));
  };
  Object.defineProperty(nativeFs, "lstatSync", {
    value: () => {
      throw new Error("selected metadata must use async stat");
    },
  });
  fs.lstat = (async (...args: Parameters<typeof asyncStat>) => {
    record(args[0]);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (fail && String(args[0]) === path.join(f.root, "src/a.ts")) throw unavailable;
      return await asyncStat(...args);
    } finally {
      active--;
    }
  }) as typeof asyncStat;
  nativeFs.readdirSync = (() => {
    throw new Error("tracked candidates need no directory enumeration");
  }) as typeof syncList;
  fs.readdir = (() => {
    throw new Error("tracked candidates need no directory enumeration");
  }) as typeof asyncList;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await changedTurnFiles(f.root, before, []), ["src/a.ts"]);
    assert.equal(calls.get(path.join(f.root, "src/a.ts")), 1);
    assert.equal(calls.get(path.join(f.root, "src")), undefined);
    assert.equal(calls.get(path.join(f.root, "src/.git")), undefined);
    const listed = {
      paths: [
        { address: "src/a.ts", directory: false },
        { address: "new.txt", directory: false },
      ],
      ignored: [],
    };
    await f.write("new.txt", "fresh\n");
    await fs.utimes(path.join(f.root, "new.txt"), changedTime, changedTime);
    assert.deepEqual(await changedTurnFiles(f.root, before, [], listed), ["new.txt", "src/a.ts"]);
    assert.equal(peak, 2);
    fail = true;
    await assert.rejects(
      changedTurnFiles(f.root, before, [], listed),
      (error) => error === unavailable,
    );
    assert.equal(active, 0);
    fail = false;
    const childOfFile = "src/a.ts/child";
    assert.deepEqual(
      await changedTurnFiles(f.root, before, [childOfFile], {
        paths: [{ address: childOfFile, directory: false }],
        ignored: [],
      }),
      [],
    );
  } finally {
    Object.defineProperty(nativeFs, "lstatSync", { value: syncStat });
    fs.lstat = asyncStat;
    nativeFs.readdirSync = syncList;
    fs.readdir = asyncList;
    syncBuiltinESMExports();
  }
});
