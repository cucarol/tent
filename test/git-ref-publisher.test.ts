import assert from "node:assert/strict";
import childProcess, { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { GitDocumentHistory } from "../src/core/store/git-history.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { withTentMutation } from "../src/core/store/adapter.js";

async function fixture(t: TestContext, initialized = true) {
  await fs.mkdir(path.resolve(".scratch"), { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve(".scratch/git-ref-publisher-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const root = path.join(workspace, ".tent");
  await fs.mkdir(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  if (initialized) {
    git("init", "--quiet");
    git("config", "core.logAllRefUpdates", "false");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@invalid");
  }
  return { root, git, adapter: new NodeFs(root), history: new GitDocumentHistory(root) };
}

function observePublishers(t: TestContext, root: string) {
  const children: ChildProcess[] = [],
    startsOutsideLock: boolean[] = [];
  const original = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof original>) => {
    const child = original(...args),
      flags = args[1] as string[];
    if (flags.includes("update-ref") && flags.includes("--stdin")) {
      assert.equal(nativeFs.existsSync(path.join(root, "mutation.lock")), false);
      children.push(child);
      child.stdout!.on("data", (bytes: Buffer) => {
        if (bytes.toString().includes("start: ok"))
          startsOutsideLock.push(!nativeFs.existsSync(path.join(root, "mutation.lock")));
      });
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { children, startsOutsideLock };
}

test("NodeFs starts its Git publisher before the mutation lock and captures selected bytes", async (t) => {
  const { root, git, adapter } = await fixture(t);
  const file = "A/A.md",
    raw = "---\nid: node-a\ntype: prompt\n---\nfirst\r\n";
  await adapter.writeFile(file, raw);
  await adapter.history.captureUnlocked([{ path: file, raw }]);
  await adapter.writeFile("Other/Other.md", "external unselected bytes\n");
  const before = git("rev-parse", "HEAD"),
    observed = observePublishers(t, root);
  await withTentMutation(adapter, () => adapter.writeFile(file, raw + "saved\n"), {
    operation: "node.write",
  });
  assert.equal(observed.children.length, 1);
  assert.deepEqual(observed.startsOutsideLock, [true]);
  assert.equal(observed.children[0]!.exitCode, 0);
  assert.equal(git("rev-list", "--count", `${before}..HEAD`), "1");
  assert.equal(git("show", `HEAD:${file}`), (raw + "saved\n").trim());
  assert.equal(await adapter.readFile("Other/Other.md"), "external unselected bytes\n");
  assert.equal(git("ls-tree", "-r", "--name-only", "HEAD", "--", "Other"), "");
  assert.equal(nativeFs.existsSync(path.join(root, "mutation.lock")), false);
});

test("one ready Git process publishes several exact-CAS versions in a capture scope", async (t) => {
  const { root, git, history } = await fixture(t),
    observed = observePublishers(t, root);
  await history.withReadyPublisher(() =>
    history.withCaptureScope(async () => {
      const first = await history.captureUnlocked([{ path: "A/A.md", raw: "first\n" }]);
      const second = await history.captureUnlocked([{ path: "A/A.md", raw: "second\n" }]);
      assert.equal(git("rev-parse", "HEAD^"), first.commit);
      assert.equal(git("rev-parse", "HEAD"), second.commit);
      assert.equal(
        (await history.captureUnlocked([{ path: "A/A.md", raw: "second\n" }])).created,
        false,
      );
    }),
  );
  assert.equal(observed.children.length, 1);
  assert.equal(observed.children[0]!.exitCode, 0);
  assert.equal(git("rev-list", "--count", "HEAD"), "2");
});

test("ready publication creates and advances SHA256 history without changing raw UTF8 bytes", async (t) => {
  const { root, git, history } = await fixture(t, false);
  git("init", "--quiet", "--object-format=sha256");
  git("config", "core.logAllRefUpdates", "false");
  const observed = observePublishers(t, root),
    file = "文档/含 空格[1].md";
  const raw = "---\nid: node-utf8\ntype: prompt\n---\n中文\r\n";
  await history.withReadyPublisher(() =>
    history.withCaptureScope(async () => {
      const first = await history.captureUnlocked([{ path: file, raw }]);
      const second = await history.captureUnlocked([{ path: file, raw: raw + "next\r\n" }]);
      assert.equal(first.commit!.length, 64);
      assert.equal(second.commit!.length, 64);
      assert.equal(git("rev-parse", "HEAD^"), first.commit);
      assert.equal(await history.read(second.versions[0]!), raw + "next\r\n");
    }),
  );
  assert.equal(observed.children.length, 1);
  assert.equal(observed.children[0]!.exitCode, 0);
});

test("an action failure closes the ready publisher without changing unborn history", async (t) => {
  const { root, history } = await fixture(t),
    observed = observePublishers(t, root),
    failure = new Error("action failed");
  await assert.rejects(
    history.withReadyPublisher(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(await history.currentCommit(), null);
  assert.equal(observed.children[0]!.exitCode, 0);
});

test("lock-only operations remain usable before private Git initialization or repair", async (t) => {
  const { root, adapter } = await fixture(t, false);
  let actions = 0;
  await adapter.withLock("mutation.lock", async () => {
    actions++;
  });
  await fs.mkdir(path.join(root, ".git"));
  await adapter.withLock("mutation.lock", async () => {
    actions++;
  });
  assert.equal(actions, 2);
  assert.equal(nativeFs.existsSync(path.join(root, "mutation.lock")), false);
});

test("a publisher opened before private-repository migration cannot recreate reflogs", async (t) => {
  const { root, git, history } = await fixture(t);
  git("config", "core.logAllRefUpdates", "true");
  await history.captureUnlocked([{ path: "A/A.md", raw: "first\n" }]);
  const ref = (await fs.readFile(path.join(root, ".git/HEAD"), "utf8")).trim().slice(5);
  const logs = [path.join(root, ".git/logs/HEAD"), path.join(root, ".git/logs", ref)];
  const head = git("rev-parse", "HEAD");
  // The current capture path already disables logs; seed genuine legacy bytes
  // to exercise a child opened while the repository still says true.
  for (const file of logs) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `${"0".repeat(head.length)} ${head} Test <test@invalid> 1792870000 +0800\tfirst\n`,
      { flush: true },
    );
  }
  assert(logs.every((file) => nativeFs.existsSync(file)));
  await history.withReadyPublisher(async () => {
    // Repository opening/repair can migrate configuration after the child read it.
    git("config", "core.logAllRefUpdates", "false");
    for (const file of logs) await fs.unlink(file);
    await history.withCaptureScope(() =>
      history.captureUnlocked([{ path: "A/A.md", raw: "second\n" }]),
    );
  });
  assert(logs.every((file) => !nativeFs.existsSync(file)));
  assert.equal(git("show", "HEAD:A/A.md"), "second");
});

test("ready publication rejects a competing HEAD and closes its failed Git process", async (t) => {
  const { root, git, history } = await fixture(t);
  const first = await history.captureUnlocked([{ path: "A/A.md", raw: "first\n" }]),
    external = git(
      "commit-tree",
      git("rev-parse", "HEAD^{tree}"),
      "-p",
      first.commit!,
      "-m",
      "external",
    ),
    observed = observePublishers(t, root);
  await assert.rejects(
    history.withReadyPublisher(() =>
      history.withCaptureScope(async () => {
        await history.nodeRecords();
        git("update-ref", "HEAD", external, first.commit!);
        await history.captureUnlocked([{ path: "A/A.md", raw: "saved\n" }]);
      }),
    ),
    /HEAD changed during capture/,
  );
  assert.equal(git("rev-parse", "HEAD"), external);
  assert.equal(git("show", "HEAD:A/A.md"), "first");
  assert.equal(observed.children[0]!.exitCode, 128);
});

test("a lost commit acknowledgement settles file transactions and later captures use ordinary CAS", async (t) => {
  const { root, git, adapter } = await fixture(t);
  const history = adapter.history;
  const original = childProcess.spawn;
  let discarded = false;
  const publishers: ChildProcess[] = [];
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof original>) => {
    const child = original(...args),
      flags = args[1] as string[];
    if (flags.includes("update-ref") && flags.includes("--stdin")) {
      publishers.push(child);
      const stream = child.stdout!,
        emit = stream.emit.bind(stream);
      t.mock.method(stream, "emit", (...event: Parameters<typeof stream.emit>) => {
        if (event[0] === "data" && String(event[1]).includes("commit: ok")) {
          discarded = true;
          child.stdin!.end();
          return true;
        }
        return emit(...event);
      });
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await history.withReadyPublisher(async () => {
    await withTentMutation(adapter, () => adapter.writeFile("A/A.md", "first\n"), {
      operation: "node.write",
    });
    const first = await history.currentCommit();
    assert.equal(git("rev-parse", "HEAD"), first);
    assert.equal(await adapter.exists(".git/tent-transaction.json"), false);
    await withTentMutation(adapter, () => adapter.writeFile("A/A.md", "second\n"), {
      operation: "node.write",
    });
    assert.equal(git("rev-parse", "HEAD^"), first);
    assert.equal(git("show", "HEAD:A/A.md"), "second");
    assert.equal(await adapter.readFile("A/A.md"), "second\n");
    assert.equal(await adapter.exists(".git/tent-transaction.json"), false);
  });
  assert.equal(discarded, true);
  assert.equal(publishers[0]!.exitCode, 0);
});

test("a mirror storage failure is retried within a capture scope rather than memoized", async (t) => {
  const { root, history } = await fixture(t),
    file = "A/A.md",
    raw = "first\n";
  await history.captureUnlocked([{ path: file, raw }]);
  const writer = new GitDocumentHistory(root),
    original = childProcess.spawn;
  let failures = 0;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof original>) => {
    const flags = args[1] as string[],
      options = args[2] as { env?: NodeJS.ProcessEnv };
    if (flags.includes("read-tree") && !options.env?.GIT_INDEX_FILE && failures++ === 0)
      return original("git", ["tent-injected-storage-failure"], args[2]);
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await writer.withCaptureScope(async () => {
    await assert.rejects(writer.captureUnlocked([{ path: file, raw }]), /Git read-tree failed/);
    assert.equal((await writer.captureUnlocked([{ path: file, raw }])).created, false);
  });
  assert.equal(failures, 2);
});
