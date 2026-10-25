import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NodeFs } from "../src/fs/node-fs.js";
import { GitDocumentHistory } from "../src/core/store/git-history.js";
import { repairHistoryUnlocked } from "../src/core/store/git-history-repair.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { cliErrorText } from "../src/cli/error-text.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext, format: "sha1" | "sha256" = "sha1") {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "history-repair-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Repair" });
  const root = path.join(workspace, ".tent");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet", `--object-format=${format}`);
  const branch = git("symbolic-ref", "HEAD");
  const adapter = new NodeFs(root),
    history = new GitDocumentHistory(root);
  const file = "roles/role-main.md",
    other = "roles/role-review.md";
  const raw = (body: string, id = "role-main") => `---\nid: ${id}\ntype: role\n---\n${body}\n`;
  const save = async (body: string) => {
    const value = raw(body);
    await adapter.writeFile(file, value);
    return (
      await history.captureUnlocked([{ path: file, raw: value }], {
        operation: "role.write",
        objectIds: ["role-main"],
      })
    ).commit!;
  };
  const first = await save("first"),
    second = await save("second"),
    last = await save("last");
  const legacyLogs = async (extra?: string) => {
    const commits = [first, second, last, ...(extra ? [extra] : [])];
    let before = "0".repeat(first.length);
    const lines = commits
      .map((commit) => {
        const line = `${before} ${commit} Tent <tent@local.invalid> 1792870000 +0800\n`;
        before = commit;
        return line;
      })
      .join("");
    for (const log of ["logs/HEAD", `logs/${branch}`]) {
      await fs.mkdir(path.dirname(path.join(root, ".git", log)), { recursive: true });
      await fs.writeFile(path.join(root, ".git", log), lines);
    }
  };
  await legacyLogs();
  const repair = (head?: string) =>
    adapter.withLock("mutation.lock", () => repairHistoryUnlocked(root, { head }));
  const zero = async (file: string) => {
    const bytes = await fs.readFile(path.join(root, file));
    await fs.writeFile(path.join(root, file), Buffer.alloc(bytes.length));
    return bytes;
  };
  return {
    legacyLogs,
    workspace,
    root,
    git,
    branch,
    adapter,
    history,
    file,
    other,
    raw,
    first,
    second,
    last,
    save,
    repair,
    zero,
  };
}

for (const format of ["sha1", "sha256"] as const) {
  test(`repair restores zero ref/index/documents and archives damaged logs, preserving edits (${format})`, async (t) => {
    const f = await fixture(t, format);
    const { root, git, branch, file, other, raw, first, last, history, repair, zero } = f;
    await f.adapter.writeFile(other, raw("retained review", "role-review"));
    const newest = (
      await history.captureUnlocked([{ path: other, raw: raw("retained review", "role-review") }])
    ).commit!;
    await f.legacyLogs(newest);
    const edited = raw("uncaptured valid edit", "role-review");
    await f.adapter.writeFile(other, edited);
    // Legacy log records are two saves behind and must not select the recovery point.
    for (const log of ["logs/HEAD", `logs/${branch}`]) {
      const p = path.join(root, ".git", log);
      const lines = (await fs.readFile(p, "utf8")).trimEnd().split("\n");
      assert.ok(lines[0]!.includes(first));
      await fs.writeFile(p, Buffer.concat([Buffer.from(lines[0] + "\n"), Buffer.alloc(250)]));
    }
    const originalRef = await zero(`.git/${branch}`),
      originalIndex = await zero(".git/index"),
      originalDocument = await zero(file);
    await assert.rejects(new GitDocumentHistory(root).available(), (error) => {
      assert.match(
        cliErrorText(error, "tent card list", { workspace: f.workspace }),
        /branch ref is unreadable[\s\S]*Next: tent workspace repair --workspace/,
      );
      return true;
    });
    const result = await repair();
    assert.equal(
      result.head,
      newest,
      "uses intact descendants beyond the last surviving reflog record",
    );
    assert.equal(result.fsck, "clean");
    assert.equal(git("rev-parse", "HEAD"), newest);
    assert.equal(await fs.readFile(path.join(root, file), "utf8"), raw("last"));
    assert.equal(await fs.readFile(path.join(root, other), "utf8"), edited);
    assert.deepEqual(result.restored, [file]);
    assert.ok(result.kept.includes(other));
    const archivedLog = await fs.readFile(path.join(f.workspace, result.reflogArchive!, "HEAD"));
    assert.ok(
      archivedLog.subarray(-250).equals(Buffer.alloc(250)),
      "legacy logs are archived unchanged, not parsed or rewritten",
    );
    const backup = path.join(f.workspace, result.backup!);
    assert.deepEqual(
      await fs.readFile(path.join(backup, `.git/${branch}`)),
      Buffer.alloc(originalRef.length),
    );
    assert.deepEqual(
      await fs.readFile(path.join(backup, ".git/index")),
      Buffer.alloc(originalIndex.length),
    );
    assert.deepEqual(
      await fs.readFile(path.join(backup, file)),
      Buffer.alloc(originalDocument.length),
    );
    assert.equal(git("show", `${last}:${file}`), raw("last").trim());
    git("fsck", "--full", "--no-dangling");
    assert.equal((await repair()).intact, true);
    assert.equal((await fs.readdir(path.join(root, ".git/tent-repair"))).length, 1);
  });
}

test("index-only corruption is diagnosed and repaired without changing HEAD or edits", async (t) => {
  const f = await fixture(t);
  await f.adapter.writeFile(f.file, f.raw("editor work"));
  await f.zero(".git/index");
  await assert.rejects(
    f.history.captureUnlocked([{ path: f.file, raw: f.raw("must not capture") }]),
    /Git index.*zero-filled/,
  );
  assert.equal(f.git("rev-parse", "HEAD"), f.last);
  await assert.rejects(new GitDocumentHistory(f.root).available(), (error) => {
    const message = cliErrorText(error, "tent card show", { workspace: f.workspace });
    assert.match(message, /Git index.*zero-filled/);
    assert.match(message, /Next: tent workspace repair --workspace/);
    assert.doesNotMatch(message, /Commits.*intact/);
    return true;
  });
  const result = await f.repair();
  assert.equal(result.head, f.last);
  assert.deepEqual(result.repaired, ["index rebuilt"]);
  assert.equal(await f.adapter.readFile(f.file), f.raw("editor work"));
});

test("a dangling fork is listed, never chosen by date; --head selects and retains the other objects", async (t) => {
  const f = await fixture(t);
  const fork = f.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit-tree",
    f.git("rev-parse", `${f.last}^{tree}`),
    "-p",
    f.first,
    "-m",
    "Later clock does not win",
  );
  const bytes = await f.zero(`.git/${f.branch}`);
  const rejected = await runWorkspaceCommand("repair", ["--json"], { workspace: f.workspace });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /cannot choose a recovery point\. 2 commits/);
  assert.ok(rejected.stderr.includes(f.last) && rejected.stderr.includes(fork));
  assert.match(rejected.stderr, /Next: tent workspace repair --head/);
  assert.deepEqual(
    await fs.readFile(path.join(f.root, ".git", f.branch)),
    Buffer.alloc(bytes.length),
  );
  const result = await runWorkspaceCommand("repair", ["--head", f.last, "--json"], {
    workspace: f.workspace,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).head, f.last);
  assert.equal(f.git("cat-file", "-t", fork), "commit");
});

test("a lost ref recovers the unique global tip without reflogs or packed refs", async (t) => {
  const f = await fixture(t);
  f.git("pack-refs", "--all");
  await fs.rm(path.join(f.root, ".git/logs"), { recursive: true });
  // A healthy packed ref is intact and must not advance to a dangling descendant.
  const descendant = f.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit-tree",
    f.git("rev-parse", `${f.last}^{tree}`),
    "-p",
    f.last,
    "-m",
    "unpublished",
  );
  assert.equal((await f.repair()).intact, true);
  assert.equal(f.git("rev-parse", "HEAD"), f.last);
  await fs.writeFile(path.join(f.root, ".git", f.branch), Buffer.alloc(41));
  assert.equal((await f.repair()).head, descendant);
  await fs.rm(path.join(f.root, ".git/packed-refs"));
  await fs.rm(path.join(f.root, ".git/tent-reflogs"), { recursive: true, force: true });
  await fs.rm(path.join(f.root, ".git/logs"), { recursive: true, force: true });
  await f.zero(`.git/${f.branch}`);
  assert.equal((await f.repair()).head, descendant, "no recovery anchor is required");
});

test("repair respects native Git locks and leaves all bytes unchanged", async (t) => {
  const f = await fixture(t);
  await f.zero(".git/index");
  const before = await fs.readFile(path.join(f.root, ".git/index"));
  await fs.writeFile(path.join(f.root, ".git/index.lock"), "external owner");
  await assert.rejects(f.repair(), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), before);
  assert.equal(await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"), "external owner");
  await assert.rejects(fs.stat(path.join(f.root, ".git/HEAD.lock")), { code: "ENOENT" });
  await fs.unlink(path.join(f.root, ".git/index.lock"));
});

test("repair is offline in help, rejects unrelated options, and leaves an intact history untouched", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.root, ".git/index"));
  const help = await runWorkspaceCommand("repair", ["--help"], { workspace: "/missing-workspace" });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /tent workspace repair \[--head <commit>\]/);
  assert.equal(
    (await runWorkspaceCommand("repair", ["--limit", "2"], { workspace: f.workspace })).exitCode,
    1,
  );
  assert.equal(
    (await runWorkspaceCommand("check", ["--head", f.last], { workspace: f.workspace })).exitCode,
    1,
  );
  const result = await runWorkspaceCommand("repair", [], { workspace: f.workspace });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "Tent history is intact.\n");
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), before);
  await assert.rejects(fs.stat(path.join(f.root, ".git/tent-repair")), { code: "ENOENT" });
});

test("zero derived caches are rebuilt from Git without repair or fact changes", async (t) => {
  const f = await fixture(t);
  const events = await f.history.changesInRange();
  const expected = [{ path: f.file, raw: f.raw("last") }];
  await f.history.changedRetainedDocuments(expected);
  const names = ["tent-history-index.json", "tent-derived-retained-document-blobs.json"];
  for (const name of names) await f.zero(`.git/${name}`);
  const reader = new GitDocumentHistory(f.root);
  assert.deepEqual(await reader.changesInRange(), events);
  assert.deepEqual(await reader.changedRetainedDocuments(expected), []);
  const [retained] = await reader.readVersions([{ commit: f.last, path: f.file }]);
  assert.ok(retained && !(retained instanceof Error));
  assert.equal(retained.raw, f.raw("last"));
  for (const name of names) {
    const rebuilt = JSON.parse(await fs.readFile(path.join(f.root, ".git", name), "utf8"));
    assert.equal(rebuilt.head, f.last);
  }
  assert.equal(f.git("rev-parse", "HEAD"), f.last);
  assert.equal(await f.adapter.readFile(f.file), f.raw("last"));
  assert.equal((await f.repair()).intact, true);
  await assert.rejects(fs.stat(path.join(f.root, ".git/tent-repair")), { code: "ENOENT" });
});

test("missing ref objects are diagnosed without claiming intact commits; explicit invalid heads do not mutate files", async (t) => {
  const f = await fixture(t);
  const missing = "e".repeat(40);
  await fs.writeFile(path.join(f.root, ".git", f.branch), missing + "\n");
  await assert.rejects(new GitDocumentHistory(f.root).available(), (error) => {
    const text = cliErrorText(error, "tent card show", { workspace: f.workspace });
    assert.match(text, /branch ref points to eeeeeeee.*missing or unreadable/);
    assert.match(text, /Next: tent workspace repair --workspace/);
    return true;
  });
  await assert.rejects(f.repair(missing), /--head does not identify exactly one intact commit/);
  assert.equal(await fs.readFile(path.join(f.root, ".git", f.branch), "utf8"), missing + "\n");
  assert.equal((await f.repair()).head, f.last);
});

test("capture archives old logs exactly; reads leave them alone and no compatibility log is maintained", async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(path.join(f.root, ".git/logs/HEAD"));
  await f.history.readDirectory(f.last);
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/logs/HEAD")), original);
  const unchanged = await f.history.captureUnlocked([{ path: f.file, raw: f.raw("last") }]);
  assert.equal(unchanged.created, false);
  await assert.rejects(fs.stat(path.join(f.root, ".git/logs")), { code: "ENOENT" });
  const archiveRoot = path.join(f.root, ".git/tent-reflogs"),
    folders = await fs.readdir(archiveRoot);
  assert.equal(folders.length, 1);
  assert.deepEqual(await fs.readFile(path.join(archiveRoot, folders[0]!, "HEAD")), original);
  const latest = await f.save("after migration");
  assert.equal((await fs.readdir(archiveRoot)).length, 1);
  await assert.rejects(fs.stat(path.join(f.root, ".git/logs")), { code: "ENOENT" });
  await f.zero(`.git/${f.branch}`);
  assert.equal((await f.repair()).head, latest);
  assert.deepEqual(await fs.readFile(path.join(archiveRoot, folders[0]!, "HEAD")), original);
});

test("a unique merge tip is recoverable even when older reflogs describe a different line", async (t) => {
  const f = await fixture(t);
  const command = (...args: string[]) =>
    f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args);
  const tree = f.git("rev-parse", `${f.last}^{tree}`);
  const side = command("commit-tree", tree, "-p", f.first, "-m", "side branch");
  const merged = command("commit-tree", tree, "-p", f.last, "-p", side, "-m", "unique merged tip");
  await f.zero(`.git/${f.branch}`);
  assert.equal((await f.repair()).head, merged);
  assert.equal(f.git("cat-file", "-t", side), "commit");
});
