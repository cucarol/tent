import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { GitDocumentHistory } from "../src/core/git-history.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, init = true) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "git-history-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, ".tent");
  await fs.mkdir(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  if (init) git("init", "--quiet");
  return { workspace, root, git, history: new GitDocumentHistory(root) };
}

test("batched first timestamps retain publication across edits, removal and re-addition", async (t) => {
  const { root, git, history } = await fixture(t);
  const a = "cards/card-a.md",
    b = "cards/card-b.md",
    unicode = "nodes/空 白[1].md";
  assert.deepEqual(await history.firstCommitTimes([a]), new Map());
  const commit = async (changes: Record<string, string | null>, date: string) => {
    for (const [name, raw] of Object.entries(changes)) {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (raw === null) await fs.unlink(file);
      else await fs.writeFile(file, raw);
    }
    git("add", "--all");
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@invalid",
        "commit",
        "-qm",
        "test: retained documents",
      ],
      {
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        windowsHide: true,
      },
    );
  };
  await commit({ [a]: "first a", [unicode]: "unicode" }, "2026-01-01T10:00:00+08:00");
  const initial = git("rev-parse", "HEAD");
  await commit({ [a]: "updated a", [b]: "first b" }, "2026-01-02T10:00:00+08:00");
  await commit({ [a]: null }, "2026-01-03T10:00:00+08:00");
  await commit({ [a]: "returned a" }, "2025-12-31T10:00:00+08:00");
  const before = git("rev-parse", "HEAD");
  const result = await history.firstCommitTimes([a, b, unicode, "missing.md", "nodes/*.md"]);
  assert.deepEqual(
    result,
    new Map([
      [a, "2026-01-01T02:00:00.000Z"],
      [unicode, "2026-01-01T02:00:00.000Z"],
      [b, "2026-01-02T02:00:00.000Z"],
    ]),
  );
  for (const name of [a, b, unicode]) {
    const first = (await history.pathVersions(name)).first!;
    assert.equal(result.get(name), await history.commitTime(first.commit));
  }
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(git("status", "--porcelain"), "");
  await assert.rejects(history.firstCommitTimes(["../outside.md"]), /Invalid Git document path/);

  git("checkout", "--quiet", "--detach", initial);
  const branchPath = "cards/card-branch.md";
  await commit({ [branchPath]: "branch input" }, "2026-01-05T10:00:00+08:00");
  const branchHead = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "--detach", before);
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid",
    "merge",
    "--no-ff",
    "--no-edit",
    branchHead,
  );
  const merged = await history.firstCommitTimes([a, b, unicode, branchPath]);
  for (const name of [a, b, unicode, branchPath]) {
    const first = (await history.pathVersions(name)).first!;
    assert.equal(merged.get(name), await history.commitTime(first.commit));
  }

  const renamed = "cards/card-renamed.md";
  await commit({ [b]: null, [renamed]: "first b" }, "2026-01-06T10:00:00+08:00");
  await commit({ [b]: "new b" }, "2026-01-07T10:00:00+08:00");
  const afterRename = await history.firstCommitTimes([b, renamed]);
  assert.equal(afterRename.get(renamed), "2026-01-06T02:00:00.000Z");
  for (const name of [b, renamed]) {
    const first = (await history.pathVersions(name)).first!;
    assert.equal(afterRename.get(name), await history.commitTime(first.commit));
  }
});

test("captures selected raw Markdown without touching the user index or unrelated files", async (t) => {
  const { root, git, history } = await fixture(t);
  git("config", "core.autocrlf", "true");
  await fs.writeFile(path.join(root, ".gitattributes"), "*.md text eol=lf\n");
  await fs.writeFile(path.join(root, "staged.md"), "staged\n");
  await fs.writeFile(path.join(root, "dirty.md"), "dirty\n");
  git("add", "staged.md");
  const stagedBefore = git("ls-files", "--stage");
  const raw = "\ufeff# One\r\nbody\r\n";
  const first = await history.captureUnlocked([{ path: "nodes/one.md", raw }]);
  assert.equal(first.created, true);
  assert.equal(first.versions.length, 1);
  assert.equal(await history.read(first.versions[0]!), raw);
  assert.equal(git("ls-files", "--stage"), stagedBefore);
  assert.equal(git("ls-tree", "-r", "--name-only", "HEAD"), "nodes/one.md");
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(await fs.readFile(path.join(root, "staged.md"), "utf8"), "staged\n");
  assert.equal(await fs.readFile(path.join(root, "dirty.md"), "utf8"), "dirty\n");
  const again = await history.captureUnlocked([{ path: "nodes/one.md", raw }]);
  assert.deepEqual(again, { commit: first.commit, created: false, versions: first.versions });
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
});

test("batch changes, deletion and old versions remain reachable after garbage collection", async (t) => {
  const { git, history } = await fixture(t);
  const initial = await history.captureUnlocked([
    { path: "nodes/a.md", raw: "alpha\n" },
    { path: "nodes/b.md", raw: "bravo\n" },
  ]);
  assert.equal(initial.versions.length, 2);
  const next = await history.captureUnlocked([
    { path: "nodes/a.md", raw: "alpha changed\n" },
    { path: "nodes/b.md", raw: null },
  ]);
  assert.equal(next.created, true);
  assert.deepEqual(next.versions, [{ commit: next.commit, path: "nodes/a.md" }]);
  assert.equal(git("rev-list", "--count", "HEAD"), "2");
  assert.equal(git("ls-tree", "-r", "--name-only", "HEAD"), "nodes/a.md");
  git("gc", "--prune=now");
  assert.equal(await history.read(initial.versions[0]!), "alpha\n");
  assert.equal(await history.read(initial.versions[1]!), "bravo\n");
  assert.match(await history.diff(initial.versions[0]!, next.versions[0]!), /\+alpha changed/);
  await assert.rejects(history.read({ commit: next.commit!, path: "nodes/b.md" }));
});

test("public version reads and diffs reject unreachable commits and non-blob paths", async (t) => {
  const { git, history } = await fixture(t);
  const captured = await history.captureUnlocked([{ path: "A/A.md", raw: "stored\n" }]);
  const version = captured.versions[0]!;
  const tree = git("rev-parse", `${captured.commit}^{tree}`);
  const unreachable = git(
    "-c",
    "user.name=Detached",
    "-c",
    "user.email=detached@example.invalid",
    "commit-tree",
    tree,
    "-p",
    captured.commit!,
    "-m",
    "Unreachable descendant",
  );

  assert.equal(await history.read(version), "stored\n");
  await assert.rejects(
    history.read({ commit: unreachable, path: version.path }),
    /Git merge-base failed/,
  );
  await assert.rejects(
    history.diff(version, { commit: unreachable, path: version.path }),
    /Git merge-base failed/,
  );
  await assert.rejects(history.read({ commit: version.commit, path: "A" }), /Git cat-file failed/);
  await assert.rejects(history.diff(version, { commit: version.commit, path: "A" }), /not a blob/);
});

test("rejects missing or outer Git repository, unsafe paths and inherited Git routing", async (t) => {
  const { workspace, root, git, history } = await fixture(t, false);
  assert.equal(await history.available(), false);
  await assert.rejects(
    history.captureUnlocked([{ path: "nodes/a.md", raw: "x" }]),
    /must be rooted|unavailable/,
  );
  execFileSync("git", ["-C", workspace, "init", "--quiet"], { windowsHide: true });
  assert.equal(await history.available(), false);
  git("init", "--quiet");
  assert.equal(await history.available(), true);
  for (const bad of [
    "../escape.md",
    "/absolute.md",
    "nodes\\a.md",
    "nodes//a.md",
    ".git/config",
    "nodes/./a.md",
    "nodes/../a.md",
    "nodes/a\n.md",
  ]) {
    await assert.rejects(
      history.captureUnlocked([{ path: bad, raw: "x" }]),
      /Invalid Git document path/,
    );
  }
  await assert.rejects(
    history.captureUnlocked([
      { path: "a.md", raw: "a" },
      { path: "a.md", raw: "b" },
    ]),
    /Duplicate/,
  );
  const outerGit = path.join(workspace, ".git");
  const previousDir = process.env.GIT_DIR;
  const previousTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = outerGit;
    process.env.GIT_WORK_TREE = workspace;
    const captured = await history.captureUnlocked([{ path: "nodes/a.md", raw: "isolated\n" }]);
    assert.equal(await history.read(captured.versions[0]!), "isolated\n");
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousDir;
    if (previousTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousTree;
  }
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(
    execFileSync("git", ["-C", workspace, "rev-list", "--all"], {
      encoding: "utf8",
      windowsHide: true,
    }),
    "",
  );
  await assert.rejects(history.read({ commit: "HEAD", path: "nodes/a.md" }), /Invalid Git commit/);
  await assert.rejects(
    history.diff(
      { commit: "0".repeat(40), path: "../bad" },
      { commit: "0".repeat(40), path: "a.md" },
    ),
    /Invalid Git document path|Git cat-file failed/,
  );
  assert.equal(
    (await fs.readdir(path.join(root, ".git"))).some((name) => name.startsWith("tent-index-")),
    false,
  );
});

test("unchanged comparison follows externally advanced HEAD and SHA-256 object identity", async (t) => {
  const { root, git, history } = await fixture(t, false);
  git("init", "--quiet", "--object-format=sha256");
  const initial = await history.captureUnlocked([{ path: "Node/Node.md", raw: "original\r\n" }]);
  assert.equal(initial.commit!.length, 64);
  assert.equal(
    (await history.captureUnlocked([{ path: "Node/Node.md", raw: "original\r\n" }])).created,
    false,
  );
  await new GitDocumentHistory(root).captureUnlocked([
    { path: "Node/Node.md", raw: "another process" },
  ]);
  const restored = await history.captureUnlocked([{ path: "Node/Node.md", raw: "original\r\n" }]);
  assert.equal(restored.created, true);
  assert.notEqual(restored.commit, initial.commit);
  assert.equal(await history.read(restored.versions[0]!), "original\r\n");
  assert.equal(
    (await history.captureUnlocked([{ path: "Node/Node.md", raw: "original\r\n" }])).created,
    false,
  );
});

test("identity history follows rename and move, including old commits and deletion", async (t) => {
  const { root, git, history } = await fixture(t);
  const raw = (title: string) => `---\nid: node-abc123\ntype: goal\n---\n# ${title}\n`;
  await fs.mkdir(path.join(root, "Alpha"));
  await fs.writeFile(path.join(root, "Alpha", "Alpha.md"), raw("Alpha"));
  git("add", "Alpha/Alpha.md");
  git(
    "-c",
    "user.name=Old",
    "-c",
    "user.email=old@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Legacy capture",
  );
  const legacy = git("rev-parse", "HEAD");

  const renamed = await history.captureUnlocked(
    [
      { path: "Alpha/Alpha.md", raw: null },
      { path: "Beta/Beta.md", raw: raw("Beta") },
    ],
    { operation: "node.rename", objectIds: ["node-abc123"], entry: "cli" },
  );
  const moved = await history.captureUnlocked(
    [
      { path: "Beta/Beta.md", raw: null },
      { path: "Group/Beta/Beta.md", raw: raw("Beta") },
    ],
    { operation: "node.move", entry: "ui" },
  );
  const deleted = await history.captureUnlocked([{ path: "Group/Beta/Beta.md", raw: null }], {
    operation: "node.delete",
    entry: "core",
  });
  const versions = await history.nodeVersions("node-abc123");
  assert.deepEqual(
    versions.map((row) => [row.commit, row.changes[0]?.before?.path, row.changes[0]?.after?.path]),
    [
      [legacy, undefined, "Alpha/Alpha.md"],
      [renamed.commit, "Alpha/Alpha.md", "Beta/Beta.md"],
      [moved.commit, "Beta/Beta.md", "Group/Beta/Beta.md"],
      [deleted.commit, "Group/Beta/Beta.md", undefined],
    ],
  );
  assert.equal(versions[0]?.operation, undefined);
  assert.deepEqual(
    [versions[1]?.operation, versions[1]?.entry, versions[1]?.objectIds],
    ["node.rename", "cli", ["node-abc123"]],
  );
  assert.deepEqual(
    (await history.changesInRange({ from: renamed.commit!, to: deleted.commit! })).map(
      (row) => row.commit,
    ),
    [moved.commit, deleted.commit],
  );
  assert.deepEqual(await history.changesInRange({ from: deleted.commit! }), []);
  await assert.rejects(history.changesInRange({ from: deleted.commit!, to: renamed.commit! }));
});

test("history preserves mixed-case identity in captures, trailers and queries", async (t) => {
  const { git, history } = await fixture(t);
  const firstRaw = "---\nid: node-Ab\ntype: goal\n---\nfirst\n";
  const first = await history.captureUnlocked([{ path: "Alpha/Alpha.md", raw: firstRaw }]);
  assert.match(git("show", "-s", "--format=%B", first.commit!), /^Tent-Object: node-Ab$/m);
  assert.equal(await history.read(first.versions[0]!), firstRaw);
  assert.deepEqual(
    (await history.nodeVersions("node-Ab")).map((row) => row.commit),
    [first.commit],
  );

  const secondRaw = "---\nid: node-Ab\ntype: goal\n---\nsecond\n";
  const second = await history.captureUnlocked([{ path: "Alpha/Alpha.md", raw: secondRaw }], {
    operation: "node.write",
    objectIds: ["node-Ab", "role-Cd", "card-Ef"],
    entry: "cli",
  });
  const message = git("show", "-s", "--format=%B", second.commit!);
  assert.match(message, /^Tent-Object: node-Ab$/m);
  assert.match(message, /^Tent-Object: role-Cd$/m);
  assert.match(message, /^Tent-Object: card-Ef$/m);
  assert.equal(await history.read(second.versions[0]!), secondRaw);
  assert.deepEqual(
    (await history.nodeVersions("node-Ab")).map((row) => row.commit),
    [first.commit, second.commit],
  );
  assert.deepEqual(await history.nodeVersions("node-ab"), []);
  assert.deepEqual(
    (await history.changesInRange({ from: first.commit! })).map((row) => row.objectIds),
    [["card-Ef", "node-Ab", "role-Cd"]],
  );
  await assert.rejects(
    history.captureUnlocked([{ path: "Alpha/Alpha.md", raw: secondRaw }], {
      operation: "node.write",
      objectIds: ["node-A_"],
    }),
    /Invalid Tent history object id/,
  );
});

test("history rejects ambiguous duplicate Node identities in a commit", async (t) => {
  const { history } = await fixture(t);
  const raw = "---\nid: node-abc123\ntype: goal\n---\nbody\n";
  await history.captureUnlocked([{ path: "A/A.md", raw }]);
  await history.captureUnlocked([{ path: "B/B.md", raw }]);
  await assert.rejects(history.nodeVersions("node-abc123"), /Duplicate historical identity/);
});

test("batch history preserves first-parent merge, empty commits, ranges and streamed Unicode blobs", async (t) => {
  const { root, git, history } = await fixture(t);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const branch = git("symbolic-ref", "--short", "HEAD");
  const name = "空间 🪁",
    file = `${name}/${name}.md`;
  await fs.mkdir(path.join(root, name));
  const raw = `\uFEFF---\nid: node-Mixed\ntype: prompt\n---\n${"数据 🪁\n".repeat(40_000)}`;
  await fs.writeFile(path.join(root, file), raw);
  git("add", "--all");
  git(
    "commit",
    "-qm",
    `Initial\n\n${"a".repeat(40)}\n:100644 100644 raw-looking message\n\nTent-Operation: node.create`,
  );
  const initial = git("rev-parse", "HEAD");
  git("checkout", "-qb", "side");
  await fs.mkdir(path.join(root, "roles"));
  await fs.writeFile(
    path.join(root, "roles/role-Side.md"),
    "---\nid: role-Side\ntype: role\n---\nSide direction",
  );
  git("add", "--all");
  git("commit", "-qm", "Side role");
  git("checkout", "-q", branch);
  await fs.writeFile(path.join(root, file), raw + "Main change\n");
  git("add", "--all");
  git("commit", "-qm", "Main edit");
  const edited = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "Empty");
  const empty = git("rev-parse", "HEAD");
  git("merge", "--no-ff", "-qm", "Merge side", "side");
  const merged = git("rev-parse", "HEAD");
  const rows = await history.changesInRange();
  assert.deepEqual(
    rows.map((row) => row.commit),
    [initial, edited, empty, merged],
  );
  assert.equal(rows[0]!.operation, "node.create");
  assert.deepEqual(rows[0]!.objectIds, ["node-Mixed"]);
  assert.equal(rows[1]!.changes[0]!.before!.path, file);
  assert.equal(rows[2]!.changes.length, 0);
  assert.equal(rows[3]!.parent, empty);
  assert.deepEqual(rows[3]!.objectIds, ["role-Side"]);
  assert.equal(rows[3]!.changes[0]!.after!.path, "roles/role-Side.md");
  assert.deepEqual(await history.changesInRange({ from: initial, to: merged }), rows.slice(1));
  assert.deepEqual(await history.changesInRange({ from: merged }), []);
});

test("current HEAD reads loose, packed, detached and unborn refs without caching", async (t) => {
  const { root, git, history } = await fixture(t);
  assert.equal(await history.currentCommit(), null);
  const initial = await history.captureUnlocked([{ path: "A/A.md", raw: "first" }]);
  assert.equal(await history.currentCommit(), initial.commit);
  git("pack-refs", "--all");
  assert.equal(await history.currentCommit(), initial.commit);
  const next = await history.captureUnlocked([{ path: "A/A.md", raw: "second" }]);
  assert.equal(await history.currentCommit(), next.commit);
  git("update-ref", "--no-deref", "HEAD", initial.commit!);
  assert.equal(await history.currentCommit(), initial.commit);
  await fs.writeFile(path.join(root, ".git/HEAD"), "ref: refs/../config\n");
  await assert.rejects(history.currentCommit(), /Invalid Tent Git HEAD reference/);
  await fs.writeFile(path.join(root, ".git/HEAD"), "ref: refs/heads/cycle\n");
  await fs.writeFile(path.join(root, ".git/refs/heads/cycle"), "ref: refs/heads/cycle\n");
  await assert.rejects(history.currentCommit(), /Cyclic/);
});

test("batched source reads match single-path history through merges, ABA and invalid versions", async (t) => {
  const { root, git, history } = await fixture(t);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const branch = git("symbolic-ref", "--short", "HEAD");
  const files = ["空间 🪁/空间 🪁.md", "B/B.md", "C/C.md"];
  const commit = async (changes: Record<string, string>) => {
    for (const [file, raw] of Object.entries(changes)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), raw);
    }
    git("add", "--all");
    git("commit", "-qm", "edit");
    return git("rev-parse", "HEAD");
  };
  const initial = await commit(Object.fromEntries(files.map((file) => [file, "initial"])));
  git("checkout", "-qb", "side");
  const side = await commit({ [files[0]!]: "side 🪁\n".repeat(40_000) });
  git("checkout", "-q", branch);
  const main = await commit({ [files[1]!]: "main" });
  git("merge", "--no-ff", "-qm", "Merge side", "side");
  const merge = git("rev-parse", "HEAD");
  const aba1 = await commit({ [files[2]!]: "change" });
  const aba2 = await commit({ [files[2]!]: "initial" });
  const versions = [initial, side, main, merge, aba1, aba2].flatMap((commit) =>
    files.map((path) => ({ commit, path })),
  );
  const results = await history.readVersions(versions);
  for (const [i, version] of versions.entries()) {
    const result = results[i]!;
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.raw, await history.read(version));
    assert.equal(result.changedSince, await history.changedSince(version), JSON.stringify(version));
  }
  const invalid = await history.readVersions([
    { commit: "0".repeat(40), path: files[0]! },
    { commit: merge, path: "missing.md" },
    { commit: merge, path: "B" },
    { commit: merge, path: "../outside" },
    { commit: merge, path: files[0]! },
  ]);
  assert.ok(invalid.slice(0, 4).every((item) => item instanceof Error));
  assert.ok(!(invalid[4] instanceof Error));
});
