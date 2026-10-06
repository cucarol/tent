import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
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
  const latest = await history.latestCommitTimes([a, b, unicode, "missing.md", "nodes/*.md"]);
  assert.equal(latest.size, 3);
  assert.equal(latest.get(a), "2025-12-31T02:00:00.000Z");
  assert.equal(latest.get(b), "2026-01-02T02:00:00.000Z");
  assert.equal(latest.get(unicode), "2026-01-01T02:00:00.000Z");
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
  const latestMerged = await history.latestCommitTimes([a, b, unicode, branchPath]);
  for (const name of [a, b, unicode, branchPath]) {
    const first = (await history.pathVersions(name)).first!;
    assert.equal(merged.get(name), await history.commitTime(first.commit));
    const last = (await history.pathVersions(name)).latest!;
    assert.equal(latestMerged.get(name), await history.commitTime(last.commit));
    assert.equal(
      last.commit,
      git("--literal-pathspecs", "log", "--full-history", "-1", "--format=%H", "--", name),
    );
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

test("one HEAD shares a single history traversal, durable hits skip replay, and resets invalidate", async (t) => {
  const { root, git, history } = await fixture(t);
  const file = "Goal/Goal.md",
    nodeId = "node-cache";
  const raw = `---\nid: ${nodeId}\ntype: goal\n---\nfirst\n`;
  const first = await history.captureUnlocked([{ path: file, raw }]);
  const calls: string[][] = [];
  const original = childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof original>) => {
    calls.push(args[1] as string[]);
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  let builds = 0;
  const query = async (reader: GitDocumentHistory) => {
    const [events, times, records, reads, index] = await Promise.all([
      reader.changesInRange(),
      reader.firstCommitTimes([file]),
      reader.nodeRecords(),
      reader.readVersions(first.versions),
      reader.derived("test-progress", 1, async () => {
        builds++;
        return { events: (await reader.changesInRange()).length };
      }),
    ]);
    assert.ok(!(reads[0] instanceof Error));
    assert.equal(reads[0]!.raw, raw);
    assert.equal(times.get(file), events[0]!.time);
    assert.deepEqual(records, {});
    assert.equal(index.events, events.length);
    return events;
  };
  assert.equal((await query(history)).length, 1);
  assert.equal(calls.filter((args) => args.includes("log")).length, 1);
  assert.equal(calls.filter((args) => args.includes("cat-file")).length, 1);
  calls.length = 0;
  const warm = new GitDocumentHistory(root);
  const internal = warm as unknown as {
    snapshot(head: string): Promise<{ records: unknown[] }>;
  };
  const snapshot = internal.snapshot.bind(warm);
  internal.snapshot = async (head) => {
    const retained = await snapshot(head);
    retained.records = new Proxy(retained.records, {
      get(target, key, receiver) {
        if (key === Symbol.iterator)
          throw new Error("A warm query must not replay history records");
        return Reflect.get(target, key, receiver);
      },
    });
    return retained;
  };
  assert.equal((await query(warm)).length, 1);
  assert.equal(calls.length, 0);
  assert.equal(builds, 1);

  const second = await history.captureUnlocked([{ path: file, raw: raw + "second\n" }]);
  calls.length = 0;
  assert.equal((await query(new GitDocumentHistory(root))).length, 2);
  assert.equal(calls.filter((args) => args.includes("log")).length, 1);
  assert.equal(builds, 2);
  git("update-ref", "HEAD", first.commit!);
  calls.length = 0;
  assert.equal((await query(new GitDocumentHistory(root))).length, 1);
  assert.equal(calls.filter((args) => args.includes("log")).length, 1);
  assert.equal(builds, 3);
  const racing = new GitDocumentHistory(root);
  const bound = await racing.derived("moving-head", 1, async (head) => {
    git("update-ref", "HEAD", second.commit!);
    const events = await racing.changesInRange();
    const reads = await racing.readVersions(first.versions);
    assert.ok(!(reads[0] instanceof Error));
    assert.equal(reads[0]!.changedSince, false);
    return { head, last: events.at(-1)!.commit };
  });
  assert.deepEqual(bound, { head: first.commit, last: first.commit });
  assert.equal(await racing.currentCommit(), second.commit);
  await racing.derived("current-head", 1, async () => (await racing.changesInRange()).length);
  const retainedPromises = (racing as unknown as { derivedPromises: Map<string, unknown> })
    .derivedPromises;
  assert.ok([...retainedPromises.keys()].every((key) => key.endsWith(`:${second.commit}`)));
  const outer = new GitDocumentHistory(root),
    currentCommit = outer.currentCommit.bind(outer);
  git("update-ref", "HEAD", first.commit!);
  outer.currentCommit = async () => {
    const head = await currentCommit();
    git("update-ref", "HEAD", second.commit!);
    return head;
  };
  assert.equal((await outer.pathVersions(file)).latest!.commit, first.commit);
  const newHeadReader = new GitDocumentHistory(root);
  assert.equal((await newHeadReader.pathVersions(file)).latest!.commit, second.commit);
  await newHeadReader.readVersions(second.versions);
  git("update-ref", "HEAD", first.commit!);
  assert.deepEqual(
    await new GitDocumentHistory(root).derived("moving-head", 1, async () => {
      throw new Error("Exact old HEAD must reuse its correctly bound value");
    }),
    bound,
  );
  await query(new GitDocumentHistory(root));
  const cache = path.join(root, ".git/tent-derived-test-progress.json");
  const damaged = JSON.parse(await fs.readFile(cache, "utf8"));
  damaged.value = { events: 900 };
  await fs.writeFile(cache, JSON.stringify(damaged));
  calls.length = 0;
  assert.equal((await query(new GitDocumentHistory(root))).length, 1);
  assert.equal(calls.length, 0);
  assert.equal(builds, 4);
  const snapshotFile = path.join(root, ".git/tent-history-index.json");
  const damagedSnapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  damagedSnapshot.blobs[Object.keys(damagedSnapshot.blobs)[0]!] = "valid JSON, wrong Git bytes";
  await fs.writeFile(snapshotFile, JSON.stringify(damagedSnapshot));
  calls.length = 0;
  const reads = await new GitDocumentHistory(root).readVersions(first.versions);
  assert.ok(!(reads[0] instanceof Error));
  assert.equal(calls.filter((args) => args.includes("log")).length, 1);
});

test("captures selected raw Markdown and aligns the real index without changing unrelated files", async (t) => {
  const { root, git, history } = await fixture(t);
  git("config", "core.autocrlf", "true");
  await fs.writeFile(path.join(root, ".gitattributes"), "*.md text eol=lf\n");
  await fs.writeFile(path.join(root, "staged.md"), "staged\n");
  await fs.writeFile(path.join(root, "dirty.md"), "dirty\n");
  git("add", "staged.md");
  const raw = "\ufeff# One\r\nbody\r\n";
  const first = await history.captureUnlocked([{ path: "nodes/one.md", raw }]);
  assert.equal(first.created, true);
  assert.equal(first.versions.length, 1);
  assert.equal(await history.read(first.versions[0]!), raw);
  assert.equal(git("write-tree"), git("rev-parse", "HEAD^{tree}"));
  assert.equal(git("ls-tree", "-r", "--name-only", "HEAD"), "nodes/one.md");
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(await fs.readFile(path.join(root, "staged.md"), "utf8"), "staged\n");
  assert.equal(await fs.readFile(path.join(root, "dirty.md"), "utf8"), "dirty\n");
  const again = await history.captureUnlocked([{ path: "nodes/one.md", raw }]);
  assert.deepEqual(again, { commit: first.commit, created: false, versions: first.versions });
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
});

test("capture leaves a clean index, repairs legacy staging and makes manual commits retain documents", async (t) => {
  const { root, git, history } = await fixture(t);
  const file = "Node/Node.md";
  await fs.mkdir(path.join(root, "Node"));
  await fs.writeFile(path.join(root, file), "document\n");
  for (const name of ["index.md", "settings.json", "order.json", "mutation.lock"])
    await fs.writeFile(path.join(root, name), "operational\n");
  await fs.appendFile(path.join(root, ".git/info/exclude"), "\n/custom-cache\n");
  await fs.writeFile(path.join(root, "custom-cache"), "cache\n");
  const captured = await history.captureUnlocked([{ path: file, raw: "document\n" }]);
  assert.equal(git("status", "--porcelain"), "");
  git("read-tree", "--empty");
  assert.equal((await history.captureUnlocked([{ path: file, raw: "document\n" }])).created, false);
  assert.equal(git("status", "--porcelain"), "");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "Manual",
  );
  assert.equal(git("rev-parse", "HEAD^{tree}"), git("rev-parse", `${captured.commit}^{tree}`));
  await fs.writeFile(path.join(root, file), "external edit\n");
  await history.captureUnlocked([{ path: file, raw: "document\n" }]);
  assert.match(git("status", "--porcelain"), /M Node\/Node.md/);
  assert.equal(await fs.readFile(path.join(root, file), "utf8"), "external edit\n");
});

test("large commit metadata passes through stdin without command-line length limits", async (t) => {
  const { git, history } = await fixture(t);
  const objectIds = Array.from({ length: 3000 }, (_, index) => `node-message${index}`);
  const saved = await history.captureUnlocked([{ path: "Node/Node.md", raw: "document\n" }], {
    operation: "node.write-many",
    objectIds,
  });
  const message = git("show", "-s", "--format=%B", saved.commit!);
  assert.ok(Buffer.byteLength(message) > 32768);
  assert.match(message, /Tent-Object: node-message2999/);
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
  git("checkout", "-qb", "discarded");
  const discarded = await commit({ [files[0]!]: "discard this branch change" });
  git("checkout", "-q", branch);
  git("merge", "-s", "ours", "--no-ff", "-qm", "Keep first-parent tree", "discarded");
  const ours = git("rev-parse", "HEAD");
  const oursVersions = [discarded, ours].flatMap((commit) =>
    files.map((path) => ({ commit, path })),
  );
  const oursReads = await history.readVersions(oursVersions);
  for (const [index, version] of oursVersions.entries()) {
    const result = oursReads[index]!;
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.raw, await history.read(version));
    assert.equal(result.changedSince, await history.changedSince(version));
  }
});

test("selected historical reads retain deletion, recreation and ancestry despite clock skew", async (t) => {
  const { root, git, history } = await fixture(t);
  const file = "A/A.md";
  const commit = async (raw: string | null, date: string) => {
    await fs.mkdir(path.join(root, "A"), { recursive: true });
    if (raw === null) await fs.unlink(path.join(root, file));
    else await fs.writeFile(path.join(root, file), raw);
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
        "selected version",
      ],
      {
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        windowsHide: true,
      },
    );
    return git("rev-parse", "HEAD");
  };
  const first = await commit("first", "2026-03-01T00:00:00Z");
  const deleted = await commit(null, "2026-02-01T00:00:00Z");
  const recreated = await commit("replacement", "2026-01-01T00:00:00Z");
  const [old, absent, current] = await history.readVersions(
    [first, deleted, recreated].map((commit) => ({ commit, path: file })),
  );
  assert.ok(old && !(old instanceof Error));
  assert.deepEqual({ raw: old.raw, changed: old.changedSince }, { raw: "first", changed: true });
  assert.ok(absent instanceof Error);
  assert.ok(current && !(current instanceof Error));
  assert.deepEqual(
    { raw: current.raw, changed: current.changedSince },
    { raw: "replacement", changed: false },
  );
});
