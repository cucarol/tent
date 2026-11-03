import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { observeStopChanges } from "../src/fs/stop-snapshot.js";

const execute = promisify(execFile);
const scratch = fileURLToPath(new URL("../.scratch/converge-stop1103/snapshot/", import.meta.url));
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
async function fixture(t: TestContext) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "case-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const checkout = path.join(root, "checkout with spaces");
  const system = path.join(root, "system");
  await fs.mkdir(checkout);
  await git(checkout, "init", "-b", "main", "--quiet");
  await git(checkout, "config", "user.name", "Snapshot Test");
  await git(checkout, "config", "user.email", "snapshot@example.invalid");
  await git(checkout, "config", "commit.gpgsign", "false");
  await git(checkout, "config", "core.autocrlf", "false");
  async function write(file: string, contents: string) {
    const target = path.join(checkout, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  async function commit() {
    await git(checkout, "add", "-A");
    await git(checkout, "commit", "--quiet", "-m", "fixture");
  }
  async function stop() {
    const observed = await observeStopChanges(system, checkout);
    await observed.settle();
    return observed.files;
  }
  return { root, checkout, system, write, commit, stop };
}

test("Git first Stop compares dirty content, repeats stay silent, and settling is deferred", async (t) => {
  const f = await fixture(t);
  await f.write("file.txt", "base");
  await f.commit();
  await f.write("file.txt", "one!");
  const first = await observeStopChanges(f.system, f.checkout);
  assert.deepEqual(first.files, ["file.txt"]);
  assert.deepEqual((await observeStopChanges(f.system, f.checkout)).files, ["file.txt"]);
  await first.settle();
  assert.deepEqual(await f.stop(), []);
  const state = await fs.stat(path.join(f.checkout, "file.txt"));
  await f.write("file.txt", "two!");
  await fs.utimes(path.join(f.checkout, "file.txt"), state.atime, state.mtime);
  assert.deepEqual(await f.stop(), ["file.txt"], "same size and mtime still compare actual bytes");
  assert.deepEqual(await f.stop(), []);
  await f.commit();
  assert.deepEqual(await f.stop(), [], "committing previously observed content is silent");
  await f.write("file.txt", "new committed bytes");
  await f.commit();
  assert.deepEqual(await f.stop(), ["file.txt"]);
});

test("Git parallel candidate batches preserve normalized content and path ordering", async (t) => {
  const f = await fixture(t);
  await f.write(".gitattributes", "*.txt text eol=lf\n");
  const files = Array.from({ length: 130 }, (_, index) => `folder ${index % 3}/中文 ${index}.txt`);
  await Promise.all(files.map((file, index) => f.write(file, `base ${index}\n`)));
  await f.commit();
  await f.stop();
  await Promise.all(files.map((file, index) => f.write(file, `changed ${index}\r\n`)));
  const parents = new Set(files.map((file) => path.dirname(path.join(f.checkout, file))));
  const candidates = new Set(files.map((file) => path.join(f.checkout, file)));
  const listings = new Map<string, number>();
  let perFileChecks = 0;
  const readdir = fs.readdir,
    lstat = fs.lstat;
  const listingMock = t.mock.method(fs, "readdir", (...args: Parameters<typeof readdir>) => {
    const parent = String(args[0]);
    if (parents.has(parent)) listings.set(parent, (listings.get(parent) ?? 0) + 1);
    return readdir(...args);
  });
  const stateMock = t.mock.method(fs, "lstat", (...args: Parameters<typeof lstat>) => {
    if (candidates.has(String(args[0]))) perFileChecks++;
    return lstat(...args);
  });
  try {
    assert.deepEqual(new Set(await f.stop()), new Set(files));
    assert.deepEqual(listings, new Map([...parents].map((parent) => [parent, 1])));
    assert.equal(perFileChecks, 0, "known regular Dirents classify candidates without leaf lstat");
  } finally {
    listingMock.mock.restore();
    stateMock.mock.restore();
  }
  assert.deepEqual(await f.stop(), []);
  await Promise.all(files.map((file, index) => f.write(file, `changed ${index}\n`)));
  assert.deepEqual(await f.stop(), [], "Git normalizes CRLF in every batch");
  await f.write(files[64]!, "another change\n");
  assert.deepEqual(await f.stop(), [files[64]!], "results remain paired with their input paths");
});

test("a single Git candidate checks its own path without listing its parent", async (t) => {
  const f = await fixture(t);
  await f.write("scope/a.txt", "base");
  await f.write("scope/unchanged.txt", "unrelated sibling");
  await f.commit();
  await f.stop();
  await f.write("scope/a.txt", "changed");
  const parent = path.join(f.checkout, "scope");
  const readdir = fs.readdir;
  const mocked = t.mock.method(fs, "readdir", (...args: Parameters<typeof readdir>) => {
    assert.notEqual(String(args[0]), parent, "one candidate must not enumerate siblings");
    return readdir(...args);
  });
  try {
    assert.deepEqual(await f.stop(), ["scope/a.txt"]);
  } finally {
    mocked.mock.restore();
  }
});

for (const listing of ["failure", "missing name", "unknown type"] as const) {
  test(`Git candidate listing ${listing} falls back to real paths and preserves their error identity`, async (t) => {
    const f = await fixture(t);
    const files = ["scope/a.txt", "scope/b.txt"];
    for (const file of files) await f.write(file, "base");
    await f.commit();
    await f.stop();
    for (const file of files) await f.write(file, "first real change");
    const parent = path.join(f.checkout, "scope"),
      target = path.join(parent, "a.txt");
    const original = Object.assign(new Error("Original candidate path access failure"), {
      code: "EACCES",
    });
    const readdir = fs.readdir,
      lstat = fs.lstat;
    let rejectPath = false,
      pathChecks = 0,
      listings = 0;
    const listingMock = t.mock.method(
      fs,
      "readdir",
      async (...args: Parameters<typeof readdir>) => {
        if (String(args[0]) !== parent) return readdir(...args);
        listings++;
        if (listing === "failure")
          throw Object.assign(new Error("Optional parent listing failed"), { code: "EACCES" });
        const entries = await readdir(...args);
        if (listing === "missing name")
          return entries.filter((entry) => String(entry.name) !== "a.txt");
        return entries.map((entry) =>
          String(entry.name) !== "a.txt"
            ? entry
            : new Proxy(entry, {
                get(value, key) {
                  if (["isFile", "isDirectory", "isSymbolicLink"].includes(String(key)))
                    return () => false;
                  const member = Reflect.get(value, key);
                  return typeof member === "function" ? member.bind(value) : member;
                },
              }),
        );
      },
    );
    const stateMock = t.mock.method(fs, "lstat", (...args: Parameters<typeof lstat>) => {
      if (String(args[0]) === target) {
        pathChecks++;
        if (rejectPath) throw original;
      }
      return lstat(...args);
    });
    try {
      assert.deepEqual(await f.stop(), files);
      assert.ok(
        listings > 0 && pathChecks > 0,
        "a real path check recovers usable candidate content",
      );
      for (const file of files) await f.write(file, "second real change");
      rejectPath = true;
      await assert.rejects(observeStopChanges(f.system, f.checkout), (error) => error === original);
    } finally {
      listingMock.mock.restore();
      stateMock.mock.restore();
    }
    assert.deepEqual(
      (await observeStopChanges(f.system, f.checkout)).files,
      files,
      "a failed fallback does not advance the settled baseline",
    );
  });
}

test(
  "Git hash failure drains other started filters before rejecting and leaves the snapshot unsettled",
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const signals = path.join(f.checkout, ".git/drain");
    await fs.mkdir(signals);
    await fs.writeFile(
      path.join(f.checkout, ".git/drain-filter.cjs"),
      String.raw`
const fs = require("node:fs"), path = require("node:path");
const directory = path.join(process.cwd(), ".git/drain");
const raw = fs.readFileSync(0), id = raw.toString("utf8").trim();
const marker = name => path.join(directory, name);
const wait = condition => {
  const deadline = Date.now() + 30000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Filter barrier was not released");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
fs.writeFileSync(marker(id + ".started"), "");
if (id === "fail") {
  wait(() => fs.readdirSync(directory).some(name => name.endsWith(".started") && name !== "fail.started"));
  fs.writeFileSync(marker("fail.completed"), "failed deliberately");
  process.stderr.write("CONTROLLED_REQUIRED_CLEAN_FAILURE");
  process.exit(23);
}
wait(() => fs.existsSync(marker("release")));
fs.writeFileSync(marker(id + ".completed"), "completed");
process.stdout.write(raw);
`,
    );
    await git(
      f.checkout,
      "config",
      "filter.snapshot.clean",
      `"${process.execPath.replaceAll("\\", "/")}" .git/drain-filter.cjs`,
    );
    await git(f.checkout, "config", "filter.snapshot.required", "true");
    await f.write(".gitattributes", "*.txt filter=snapshot\n");
    await f.commit();
    await f.stop();
    const files = Array.from(
      { length: 130 },
      (_, index) => `candidate ${String(index).padStart(3, "0")}.txt`,
    );
    await Promise.all(
      files.map((file, index) => f.write(file, index === 0 ? "fail" : `file-${index}`)),
    );
    const bounded = async <T>(pending: Promise<T>, label: string, milliseconds = 30_000) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error(`${label} did not finish`)), milliseconds);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    };
    const processes: Array<{
      child: ReturnType<typeof execFile>;
      closed: boolean;
      done: Promise<void>;
    }> = [];
    let failedClosed!: () => void;
    const failed = new Promise<void>((resolve) => {
      failedClosed = resolve;
    });
    const nativeExecFile = childProcess.execFile;
    const mocked = t.mock.method(
      childProcess,
      "execFile",
      (...args: Parameters<typeof nativeExecFile>) => {
        const child = Reflect.apply(nativeExecFile, childProcess, args) as ReturnType<
          typeof nativeExecFile
        >;
        if (Array.isArray(args[1]) && args[1].includes("hash-object")) {
          let close!: () => void;
          const record = {
            child,
            closed: false,
            done: new Promise<void>((resolve) => {
              close = resolve;
            }),
          };
          processes.push(record);
          child.once("close", (code) => {
            record.closed = true;
            close();
            if (code !== 0) failedClosed();
          });
        }
        return child;
      },
    );
    syncBuiltinESMExports();
    let settled = false;
    const observation = observeStopChanges(f.system, f.checkout).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await bounded(failed, "Required filter failure barrier");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(processes.length >= 2, "real filters ran in more than one Git process");
      assert.ok(
        processes.some((process) => !process.closed),
        "another Git process is held at the explicit release barrier",
      );
      assert.equal(
        settled,
        false,
        "the failed observation waits for the other started Git process",
      );
      await bounded(fs.writeFile(path.join(signals, "release"), "release"), "Filter release");
      const error = await bounded(observation, "Failed Git observation");
      assert.ok(error instanceof Error);
      assert.match(error.message, /CONTROLLED_REQUIRED_CLEAN_FAILURE/);
      assert.ok(processes.every((process) => process.closed));
      const markers = await fs.readdir(signals);
      const started = markers
        .filter((name) => name.endsWith(".started"))
        .map((name) => name.slice(0, -8))
        .sort();
      const completed = markers
        .filter((name) => name.endsWith(".completed"))
        .map((name) => name.slice(0, -10))
        .sort();
      assert.deepEqual(completed, started, "every started filter completed before rejection");
    } finally {
      try {
        await bounded(fs.writeFile(path.join(signals, "release"), "release"), "Cleanup release");
        await bounded(
          Promise.all([observation, ...processes.map((process) => process.done)]),
          "Git cleanup drain",
        );
      } finally {
        for (const process of processes) if (!process.closed) process.child.kill();
        try {
          await bounded(
            Promise.all(processes.map((process) => process.done)),
            "Terminated Git close",
            5000,
          );
        } finally {
          mocked.mock.restore();
          syncBuiltinESMExports();
        }
      }
    }
    await git(f.checkout, "config", "filter.snapshot.required", "false");
    await git(f.checkout, "config", "--unset", "filter.snapshot.clean");
    assert.deepEqual(
      (await observeStopChanges(f.system, f.checkout)).files,
      files.sort(),
      "the failed observation did not publish a new baseline",
    );
  },
);

test("a hash worker that fails before status returns is reported only by the batch that uses it", async (t) => {
  const f = await fixture(t);
  await f.write("file.txt", "base");
  await f.commit();
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  const nativeExecFile = childProcess.execFile;
  const mocked = t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    const [file, argv, options, callback] = args as [
      string,
      string[],
      object,
      (...result: unknown[]) => void,
    ];
    if (argv.includes("hash-object"))
      return nativeExecFile("tent-missing-git-for-test", argv, options, callback);
    if (argv.includes("status"))
      return nativeExecFile(file, argv, options, (...result: unknown[]) =>
        setTimeout(() => callback(...result), 200),
      );
    return Reflect.apply(nativeExecFile, childProcess, args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await f.stop(), [], "an unused failed worker does not fail Stop");
    await f.write("file.txt", "changed");
    await assert.rejects(observeStopChanges(f.system, f.checkout), /ENOENT/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", record);
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Git deletion, restoration and untracked removal each compare the last settled bytes", async (t) => {
  const f = await fixture(t);
  await f.write("tracked.txt", "base");
  await f.commit();
  assert.deepEqual(await f.stop(), []);
  await fs.unlink(path.join(f.checkout, "tracked.txt"));
  assert.deepEqual(await f.stop(), ["tracked.txt"]);
  assert.deepEqual(await f.stop(), []);
  await f.write("tracked.txt", "base");
  assert.deepEqual(await f.stop(), ["tracked.txt"]);
  assert.deepEqual(await f.stop(), []);
  await f.write("new.txt", "new");
  assert.deepEqual(await f.stop(), ["new.txt"]);
  await fs.unlink(path.join(f.checkout, "new.txt"));
  assert.deepEqual(await f.stop(), ["new.txt"]);
  assert.deepEqual(await f.stop(), []);
});

test("Git expands new directories, handles renamed paths with spaces, and excludes .tent", async (t) => {
  const f = await fixture(t);
  await f.write("old name.txt", "content");
  await f.write(".gitignore", "ignored/\n");
  await f.write(".tent/tracked.md", "local graph");
  await f.commit();
  await f.stop();
  await fs.mkdir(path.join(f.checkout, "new folder"));
  await fs.rename(
    path.join(f.checkout, "old name.txt"),
    path.join(f.checkout, "new folder/new name.txt"),
  );
  await f.write("new folder/deep/a.txt", "nested");
  await f.write("ignored/file.txt", "ignored");
  await f.write(".tent/tracked.md", "changed graph");
  await f.write("new folder/.tent/hidden.md", "nested graph");
  const expected = ["new folder/deep/a.txt", "new folder/new name.txt", "old name.txt"];
  assert.deepEqual(await f.stop(), expected);
  await f.commit();
  assert.deepEqual(await f.stop(), []);
});

test("Git unborn snapshots preserve content when the initial commit is made", async (t) => {
  const f = await fixture(t);
  await f.write("initial.txt", "initial");
  assert.deepEqual(await f.stop(), ["initial.txt"]);
  await f.commit();
  assert.deepEqual(await f.stop(), []);
});

test("Git switching to an empty orphan branch reports removed committed files", async (t) => {
  const f = await fixture(t);
  await f.write("removed.txt", "committed");
  await f.commit();
  await f.stop();
  await git(f.checkout, "switch", "--quiet", "--orphan", "empty");
  assert.deepEqual(await f.stop(), ["removed.txt"]);
  assert.deepEqual(await f.stop(), []);
});

test("Git content digests apply configured clean filters", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.checkout, ".git/clean.cjs"),
    "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(s.toLowerCase()));",
  );
  const command = `"${process.execPath.replaceAll("\\", "/")}" .git/clean.cjs`;
  await git(f.checkout, "config", "filter.snapshot.clean", command);
  await git(f.checkout, "config", "filter.snapshot.required", "true");
  await f.write(".gitattributes", "*.txt filter=snapshot\n");
  await f.write("filtered.txt", "base");
  await f.commit();
  await f.stop();
  await f.write("filtered.txt", "CHANGED");
  assert.deepEqual(await f.stop(), ["filtered.txt"]);
  await f.commit();
  assert.deepEqual(await f.stop(), [], "clean-filtered working bytes match the new commit");
  await f.write("filtered.txt", "changed");
  assert.deepEqual(await f.stop(), []);
});

test("Git batch hashing preserves quoted, spaced and Unicode path names with clean filters", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.checkout, ".git/clean.cjs"),
    "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(s.toLowerCase()));",
  );
  await git(
    f.checkout,
    "config",
    "filter.snapshot.clean",
    `"${process.execPath.replaceAll("\\", "/")}" .git/clean.cjs`,
  );
  await git(f.checkout, "config", "filter.snapshot.required", "true");
  await f.write(".gitattributes", "*.txt filter=snapshot\n");
  const files = ["space folder/'quoted' name.txt", "space folder/中文.txt"];
  if (process.platform !== "win32")
    files.push(
      'space folder/"double quote".txt',
      "space folder/line\nbreak.txt",
      "space folder/back\\slash.txt",
    );
  for (const file of files) await f.write(file, "base");
  await f.commit();
  await f.stop();
  for (const file of files) await f.write(file, "CHANGED");
  assert.deepEqual(await f.stop(), files.sort());
  assert.deepEqual(await f.stop(), []);
  await f.commit();
  assert.deepEqual(await f.stop(), []);
});

test("linked worktrees sharing systemRoot keep separate Stop snapshots", async (t) => {
  const f = await fixture(t);
  await f.write("file.txt", "base");
  await f.commit();
  const linked = path.join(f.root, "linked checkout with spaces");
  await git(f.checkout, "worktree", "add", "--quiet", "-b", "linked", linked);
  await f.write("file.txt", "main changed");
  assert.deepEqual(await f.stop(), ["file.txt"]);
  const initial = await observeStopChanges(f.system, linked);
  assert.deepEqual(initial.files, []);
  await initial.settle();
  await fs.writeFile(path.join(linked, "file.txt"), "linked changed");
  const changed = await observeStopChanges(f.system, linked);
  assert.deepEqual(changed.files, ["file.txt"]);
  await changed.settle();
  assert.deepEqual(await f.stop(), []);
  assert.equal((await fs.readdir(path.join(f.system, "temp/stop-snapshots"))).length, 2);
});

test("Git candidates under a replaced directory link never read outside the checkout", async (t) => {
  const f = await fixture(t);
  await f.write("directory/file.txt", "committed");
  await f.write("directory/second.txt", "committed second");
  await f.commit();
  await f.stop();
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "file.txt"), "external");
  await fs.rm(path.join(f.checkout, "directory"), { recursive: true });
  await fs.symlink(
    outside,
    path.join(f.checkout, "directory"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const read = fs.readFile;
  const readdir = fs.readdir;
  let listings = 0;
  const listingMock = t.mock.method(fs, "readdir", (...args: Parameters<typeof readdir>) => {
    if (String(args[0]) === path.join(f.checkout, "directory")) listings++;
    return readdir(...args);
  });
  const mocked = t.mock.method(fs, "readFile", (...args: Parameters<typeof read>) => {
    const relative = path.relative(path.join(f.checkout, "directory"), String(args[0]));
    assert.ok(relative.startsWith(".."), "no file bytes may be read through the directory link");
    return read(...args);
  });
  try {
    assert.ok((await f.stop()).includes("directory/file.txt"));
    await fs.writeFile(path.join(outside, "file.txt"), "external modified");
    assert.deepEqual(await f.stop(), []);
    assert.equal(listings, 0, "ancestor links are rejected before parent type batching");
  } finally {
    mocked.mock.restore();
    listingMock.mock.restore();
  }
});

test("an independent nested Git boundary prevents candidate parent listing", async (t) => {
  const f = await fixture(t);
  await f.write("nested/a.txt", "base a");
  await f.write("nested/b.txt", "base b");
  await f.commit();
  await f.stop();
  const parent = path.join(f.checkout, "nested");
  await git(parent, "init", "--quiet", "-b", "nested");
  await f.write("nested/a.txt", "foreign a");
  await f.write("nested/b.txt", "foreign b");
  const readdir = fs.readdir;
  const mocked = t.mock.method(fs, "readdir", (...args: Parameters<typeof readdir>) => {
    assert.notEqual(
      String(args[0]),
      parent,
      "a nested Git boundary is checked before listing candidate types",
    );
    return readdir(...args);
  });
  try {
    await observeStopChanges(f.system, f.checkout);
  } finally {
    mocked.mock.restore();
  }
});

test("Git directory links never report changes to their external target contents", async (t) => {
  const f = await fixture(t);
  await f.write("base.txt", "committed baseline");
  await f.commit();
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "external.txt"), "before");
  await fs.symlink(
    outside,
    path.join(f.checkout, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await f.stop();
  await fs.writeFile(path.join(outside, "external.txt"), "after and longer");
  assert.deepEqual(await f.stop(), []);
});
