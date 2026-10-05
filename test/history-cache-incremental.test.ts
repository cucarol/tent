import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { GitDocumentHistory } from "../src/core/git-history.js";

const file = "Goal/Goal.md";
const raw = (body: string) => `---\nid: node-cache\ntype: goal\n---\n${body}\n`;
type Snapshot = {
  head: string;
  records: Array<{ commit: string; files: unknown[] }>;
  blobs: Record<string, string>;
  frontmatters: Record<string, unknown>;
  digest: string;
};
const snapshot = (history: GitDocumentHistory, head: string) =>
  (history as unknown as { snapshot(head: string): Promise<Snapshot> }).snapshot(head);

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch/now-history");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "incremental-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@invalid");
  const commit = async (body: string, target = file) => {
    await fs.mkdir(path.dirname(path.join(root, target)), { recursive: true });
    await fs.writeFile(path.join(root, target), raw(body));
    git("add", "--all");
    git("commit", "--allow-empty", "-qm", body);
    return git("rev-parse", "HEAD");
  };
  return {
    root,
    git,
    commit,
    cache: path.join(root, ".git/tent-history-index.json"),
    history: new GitDocumentHistory(root),
  };
}

function traceGit(t: TestContext) {
  const calls: string[][] = [];
  const batches: string[] = [];
  const original = childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof original>) => {
    const command = args[1] as string[];
    calls.push(command);
    const child = original(...args);
    if (command.includes("--batch")) {
      const end = child.stdin!.end.bind(child.stdin!);
      child.stdin!.end = ((...input: unknown[]) => {
        batches.push(String(input[0]));
        return end(...(input as Parameters<typeof end>));
      }) as typeof end;
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return { calls, batches, logs: () => calls.filter((args) => args.includes("log")) };
}

test("linear history extension requests only added commits and missing blobs, matching a cold rebuild", async (t) => {
  const { root, git, commit, cache, history } = await fixture(t);
  await commit("first");
  await commit("second");
  const base = await commit("third");
  await snapshot(history, base);
  const head = await commit("fourth");
  const before = git("write-tree");
  const trace = traceGit(t);
  const retained = await snapshot(new GitDocumentHistory(root), head);
  assert.equal(trace.logs().length, 1);
  assert.equal(trace.logs()[0]!.at(-1), `${base}..${head}`);
  assert.deepEqual(trace.batches, [git("rev-parse", `${head}:${file}`) + "\n"]);
  assert.equal(Object.keys(retained.blobs).length, 4);
  const incremental = await new GitDocumentHistory(root).changesInRange();
  await fs.rm(cache);
  const cold = await snapshot(new GitDocumentHistory(root), head);
  assert.deepEqual(retained, cold);
  assert.deepEqual(await new GitDocumentHistory(root).changesInRange({ to: head }), incremental);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("write-tree"), before);
});

test("multiple appended commits preserve moves, identity replacement and blob reuse", async (t) => {
  const { root, git, commit, history } = await fixture(t);
  const base = await commit("first");
  await snapshot(history, base);
  git("mv", file, "Goal/Other.md");
  git("commit", "-qm", "move out of document paths");
  git("mv", "Goal/Other.md", file);
  git("commit", "-qm", "move back");
  await fs.writeFile(path.join(root, file), raw("first").replace("node-cache", "node-other"));
  git("add", "--all");
  git("commit", "-qm", "replace identity");
  const head = git("rev-parse", "HEAD");
  const trace = traceGit(t);
  const retained = await snapshot(new GitDocumentHistory(root), head);
  assert.equal(trace.logs().length, 1);
  assert.equal(trace.logs()[0]!.at(-1), `${base}..${head}`);
  assert.deepEqual(trace.batches, [git("rev-parse", `${head}:${file}`) + "\n"]);
  const events = await new GitDocumentHistory(root).changesInRange({ to: head });
  assert.deepEqual(events.at(-1)!.objectIds, ["node-cache", "node-other"]);
  assert.equal(retained.records.length, 4);
});

test("an empty appended commit starts no blob batch", async (t) => {
  const { root, git, commit, history } = await fixture(t);
  const base = await commit("first");
  await snapshot(history, base);
  git("commit", "--allow-empty", "-qm", "empty");
  const head = git("rev-parse", "HEAD");
  const trace = traceGit(t);
  const retained = await snapshot(new GitDocumentHistory(root), head);
  assert.equal(trace.logs()[0]!.at(-1), `${base}..${head}`);
  assert.deepEqual(trace.batches, []);
  assert.equal(retained.records.length, 2);
});

for (const change of ["reset", "fork", "merge"] as const) {
  test(`${change} rebuilds the complete reachable graph`, async (t) => {
    const { root, git, commit, cache, history } = await fixture(t);
    const first = await commit("first");
    const base = await commit("second");
    await snapshot(history, base);
    if (change === "reset") git("reset", "--hard", first);
    else {
      git("checkout", "-qb", "side", first);
      await commit("side", "Side/Side.md");
      if (change === "merge") {
        git("checkout", "-q", "--detach", base);
        git("merge", "--no-ff", "-qm", "merge", "side");
      }
    }
    const head = git("rev-parse", "HEAD");
    const trace = traceGit(t);
    const retained = await snapshot(new GitDocumentHistory(root), head);
    assert.ok(trace.logs().some((args) => args.at(-1) === head));
    await fs.rm(cache);
    assert.deepEqual(retained, await snapshot(new GitDocumentHistory(root), head));
    if (change === "merge") {
      const next = await commit("third");
      trace.calls.length = 0;
      const extended = await snapshot(new GitDocumentHistory(root), next);
      assert.equal(trace.logs().length, 1);
      assert.equal(trace.logs()[0]!.at(-1), `${head}..${next}`);
      await fs.rm(cache);
      assert.deepEqual(extended, await snapshot(new GitDocumentHistory(root), next));
    }
  });
}

for (const damage of ["missing", "digest", "blob", "record"] as const) {
  test(`${damage} cache damage falls back to a complete rebuild`, async (t) => {
    const { root, commit, cache, history } = await fixture(t);
    await commit("first");
    const base = await commit("second");
    const saved = await snapshot(history, base);
    const head = await commit("third");
    if (damage === "missing") await fs.rm(cache);
    else {
      if (damage === "digest") saved.blobs[Object.keys(saved.blobs)[0]!] = "wrong bytes";
      if (damage === "blob") delete saved.blobs[Object.keys(saved.blobs)[0]!];
      if (damage === "record") saved.records.shift();
      if (damage !== "digest")
        saved.digest = createHash("sha256")
          .update(
            JSON.stringify({
              head: saved.head,
              records: saved.records,
              blobs: saved.blobs,
              frontmatters: saved.frontmatters,
            }),
          )
          .digest("hex");
      await fs.writeFile(cache, JSON.stringify(saved));
    }
    const trace = traceGit(t);
    const retained = await snapshot(new GitDocumentHistory(root), head);
    assert.deepEqual(
      trace.logs().map((args) => args.at(-1)),
      [head],
    );
    assert.equal(retained.records.length, 3);
    assert.equal(Object.keys(retained.blobs).length, 3);
  });
}

test("concurrent queries retain their own heads while a newer query extends the cache", async (t) => {
  const { root, git, commit, history } = await fixture(t);
  const first = await commit("first");
  await snapshot(history, first);
  const second = await commit("second");
  git("update-ref", "HEAD", first);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = async (reader: GitDocumentHistory) => {
    const [events, versions, reads] = await Promise.all([
      reader.changesInRange(),
      reader.pathVersions(file),
      reader.readVersions([{ commit: first, path: file }]),
    ]);
    assert.ok(!(reads[0] instanceof Error));
    return {
      commits: events.map((event) => event.commit),
      latest: versions.latest?.commit,
      changed: reads[0]!.changedSince,
    };
  };
  const reader = new GitDocumentHistory(root);
  const old = reader.derived("old-head", 1, async () => {
    entered();
    await gate;
    return read(reader);
  });
  await started;
  git("update-ref", "HEAD", second);
  const current = reader.derived("new-head", 1, () => read(reader));
  release();
  const [previous, next] = await Promise.all([old, current]);
  assert.deepEqual(previous, { commits: [first], latest: first, changed: false });
  assert.deepEqual(next, { commits: [first, second], latest: second, changed: true });
});
