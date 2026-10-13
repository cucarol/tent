import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { createModuleDependencyWatch } from "../src/fs/module-dependency-watch.js";
import { createModuleDependencyRepositoryReader } from "../src/fs/module-dependencies.js";
import { createModuleDependencyQuery } from "../src/core/module-dependency-query.js";
import { readModuleDependencies } from "../src/core/module-dependencies.js";
import { NodeFs } from "../src/fs/node-fs.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const scratch = path.resolve(".scratch/module-dependency-watch");
  await fs.mkdir(scratch, { recursive: true });
  const base = await fs.mkdtemp(path.join(scratch, "fixture-"));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const root = path.join(base, "project");
  await fs.mkdir(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
    }).trim();
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  await write(".gitignore", ".tent/\n.scratch/\n.worktrees/\nnode_modules/\n");
  await write("src/main.ts", "export const value = 1;\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    "test: watch",
  );
  return { root, base, write, git };
}

async function until(check: () => boolean, message: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const unavailable of [false, true]) {
  test(`ignored in-workspace excludes update the query through ${unavailable ? "verify fallback" : "watch invalidation"}`, async (t) => {
    const { root, write, git } = await fixture(t);
    await write("src/main.ts", 'import "./other.js";\n');
    await write("src/other.ts", "export const other = 1;\n");
    await write(".scratch/exclude", "");
    await fs.mkdir(path.join(root, ".tent"));
    git("config", "core.excludesFile", ".scratch/exclude");
    const nativeWatch = fsSync.watch;
    const folders: Array<{ folder: string; recursive: boolean }> = [];
    t.mock.method(
      fsSync,
      "watch",
      (
        folder: string,
        options: fsSync.WatchOptions,
        listener: (kind: string, filename: string | Buffer | null) => void,
      ) => {
        if (unavailable && folder === path.join(root, ".scratch"))
          throw new Error("control watch unavailable");
        folders.push({ folder, recursive: options.recursive === true });
        return nativeWatch(folder, options, listener);
      },
    );
    const repository = createModuleDependencyRepositoryReader(root);
    const compute = () =>
      readModuleDependencies(new NodeFs(path.join(root, ".tent")), root, repository());
    let changes = 0;
    const query = createModuleDependencyQuery({
      compute,
      watch: (changed, failed) =>
        createModuleDependencyWatch(
          root,
          () => {
            changes++;
            changed();
          },
          failed,
        ),
      reportMode: () => {},
    });
    t.after(() => query.close());
    const before = await query.read();
    assert.equal(before.mode, unavailable ? "verify" : "watch");
    assert.equal(before.unresolved, 0);
    assert.equal(before.uncovered, 2);
    if (unavailable) assert.match(before.reason!, /control watch unavailable/);
    else
      assert.ok(
        folders.some((item) => item.folder === path.join(root, ".scratch") && !item.recursive),
      );
    assert.ok(
      !folders.some((item) => item.folder === path.join(root, ".scratch") && item.recursive),
    );
    const basis = before.basis;
    await write(".scratch/exclude", "src/other.ts\n");
    if (!unavailable) await until(() => changes > 0, "No ignored control-file invalidation");
    // Functional convergence, not the separately measured real-workspace latency gate.
    const deadline = Date.now() + 10000;
    let after = await query.read();
    while ((!after.fresh || after.unresolved !== 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = await query.read();
    }
    assert.equal(after.fresh, true);
    assert.equal(after.unresolved, 1);
    assert.equal(after.uncovered, 1);
    assert.deepEqual(after.basis, basis);
    assert.notEqual(after.computedAt, before.computedAt);
    const direct = await compute();
    assert.equal(after.unresolved, direct.unresolved);
    assert.equal(after.uncovered, direct.uncovered);
  });
}

test("live watch invalidates source edits, membership, nested ignores and Tent declarations, then closes", async (t) => {
  const { root, write } = await fixture(t);
  let changes = 0;
  const errors: Error[] = [];
  const watch = await createModuleDependencyWatch(
    root,
    () => changes++,
    (error) => errors.push(error),
  );
  t.after(() => watch.close());
  for (const [file, content] of [
    ["src/main.ts", "export const value = 2;\n"],
    ["src/new.ts", "export const added = 1;\n"],
    ["src/.gitignore", "new.ts\n"],
    [".tent/Goal/Goal.md", "---\ntype: goal\n---\n"],
  ]) {
    const before = changes;
    await write(file!, content!);
    await until(() => changes > before, `No notification for ${file}`);
  }
  let before = changes;
  await fs.rename(path.join(root, "src/new.ts"), path.join(root, "src/renamed.ts"));
  await until(() => changes > before, "No rename notification");
  before = changes;
  await fs.unlink(path.join(root, "src/renamed.ts"));
  await until(() => changes > before, "No deletion notification");
  assert.deepEqual(errors, []);
  watch.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  before = changes;
  await write("src/main.ts", "export const value = 3;\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(changes, before);
});

test("ignored operation directories and Git object/log/lock writes do not invalidate cached inputs", async (t) => {
  const { root, write } = await fixture(t);
  let changes = 0;
  const events: Array<{ folder: string; kind: string; filename: string | null }> = [];
  const notifications: unknown[] = [];
  const nativeWatch = fsSync.watch;
  const traced = t.mock.method(
    fsSync,
    "watch",
    (
      folder: string,
      options: fsSync.WatchOptions,
      listener: (kind: string, filename: string | Buffer | null) => void,
    ) =>
      nativeWatch(folder, options, (kind, filename) => {
        events.push({
          folder: path.relative(root, folder),
          kind,
          filename: filename?.toString() ?? null,
        });
        listener(kind, filename);
      }),
  );
  const errors: Error[] = [];
  const watch = await createModuleDependencyWatch(
    root,
    () => {
      changes++;
      notifications.push(events[events.length - 1]);
    },
    (error) => errors.push(error),
  );
  t.after(() => watch.close());
  for (const file of [
    ".scratch/noise.txt",
    ".worktrees/noise.txt",
    "node_modules/pkg/index.js",
    ".git/objects/noise",
    ".git/logs/noise",
    ".git/index.lock",
  ])
    await write(file, "noise\n");
  await new Promise((resolve) => setTimeout(resolve, 150));
  traced.mock.restore();
  assert.equal(changes, 0, JSON.stringify(notifications));
  assert.deepEqual(errors, []);
});

test("watch covers external include/exclude files, replacements and newly introduced includes", async (t) => {
  const { base, root, git } = await fixture(t);
  const include = path.join(base, "included");
  const exclude = path.join(base, "excludes");
  const later = path.join(base, "new-config");
  await fs.writeFile(include, "[core]\n\texcludesFile = " + exclude.replace(/\\/g, "/") + "\n");
  await fs.writeFile(exclude, "initial.ts\n");
  git("config", "include.path", include);
  let changes = 0;
  const errors: Error[] = [];
  const watch = await createModuleDependencyWatch(
    root,
    () => changes++,
    (error) => errors.push(error),
  );
  t.after(() => watch.close());
  let before = changes;
  await fs.writeFile(exclude, "changed.ts\n");
  await until(() => changes > before, "No external excludes notification");
  await fs.writeFile(later, '[filter "new"]\n\trequired = false\n');
  await fs.writeFile(include, `[include]\n\tpath = ${later.replace(/\\/g, "/")}\n`);
  // Wait for coverage refresh before isolating the next external-file event.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  before = changes;
  const replacement = path.join(base, "replacement");
  await fs.writeFile(replacement, '[filter "new"]\n\trequired = true\n');
  await fs.rename(replacement, later);
  await until(() => changes > before, "No atomic config replacement notification");
  assert.deepEqual(errors, []);
});

test("nested Workspace watches ancestor ignore rules and external worktree metadata", async (t) => {
  const { base, root, git } = await fixture(t);
  const checkout = path.join(base, "checkout");
  git("worktree", "add", "--quiet", "-b", "work", checkout);
  let changes = 0;
  const errors: Error[] = [];
  const watch = await createModuleDependencyWatch(
    path.join(checkout, "src"),
    () => changes++,
    (error) => errors.push(error),
  );
  t.after(() => watch.close());
  for (const file of [
    path.join(checkout, ".gitignore"),
    path.join(root, ".git/info/exclude"),
    path.join(root, ".git/refs/heads/work"),
    path.join(root, ".git/worktrees/checkout/index"),
  ]) {
    const before = changes;
    const bytes = await fs.readFile(file);
    await fs.writeFile(file, bytes);
    await until(() => changes > before, `No input notification for ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.deepEqual(errors, []);
});

test("setup failures and later watcher errors close every handle and report unavailable", async (t) => {
  const { root } = await fixture(t);
  const records: Array<{
    emitter: EventEmitter;
    closed: boolean;
    folder: string;
    callback: (kind: string, filename: string | null) => void;
  }> = [];
  let failAt = 2;
  const mocked = t.mock.method(
    fsSync,
    "watch",
    (
      folder: string,
      _options: unknown,
      callback: (kind: string, filename: string | null) => void,
    ) => {
      if (records.length + 1 === failAt) throw new Error("watch limit");
      const record = { emitter: new EventEmitter(), closed: false, folder, callback };
      Object.assign(record.emitter, {
        close: () => {
          record.closed = true;
        },
      });
      records.push(record);
      return record.emitter as unknown as fsSync.FSWatcher;
    },
  );
  try {
    await assert.rejects(
      createModuleDependencyWatch(
        root,
        () => {},
        () => {},
      ),
      /watch limit/,
    );
    assert.ok(records.every((record) => record.closed));
    records.length = 0;
    failAt = Infinity;
    const errors: Error[] = [];
    await createModuleDependencyWatch(
      root,
      () => {},
      (error) => errors.push(error),
    );
    records[0]!.emitter.emit("error", new Error("lost watch"));
    assert.equal(errors[0]!.message, "lost watch");
    assert.ok(records.every((record) => record.closed));
    records.length = 0;
    await createModuleDependencyWatch(
      root,
      () => {},
      (error) => errors.push(error),
    );
    records[0]!.callback("rename", null);
    assert.match(errors[1]!.message, /Module dependency watch lost event path:/);
    assert.ok(records.every((record) => record.closed));
    records.length = 0;
    await createModuleDependencyWatch(
      root,
      () => {},
      (error) => errors.push(error),
    );
    records[0]!.emitter.emit("close");
    assert.match(errors[2]!.message, /Module dependency watch closed unexpectedly:/);
    assert.ok(records.every((record) => record.closed));
    records.length = 0;
    await createModuleDependencyWatch(
      root,
      () => {},
      (error) => errors.push(error),
    );
    await fs.rename(root, `${root}-moved`);
    records
      .find((record) => record.folder === path.dirname(root))!
      .callback("rename", path.basename(root));
    await until(() => errors.length === 4, "No directory replacement fallback");
    assert.match(errors[3]!.message, /Module dependency watch directory was replaced:/);
    await fs.rename(`${root}-moved`, root);
    assert.ok(records.every((record) => record.closed));
  } finally {
    mocked.mock.restore();
  }
});

test("relative excludesFile follows the Git working directory rather than the included config directory", async (t) => {
  const { base, root, git, write } = await fixture(t);
  const include = path.join(base, "included");
  await fs.writeFile(include, "[core]\n\texcludesFile = relative-ignore\n");
  await fs.writeFile(path.join(base, "relative-ignore"), "sibling-hidden.ts\n");
  await write("relative-ignore", "root-hidden.ts\n");
  await write("root-hidden.ts", "export const rootFile = 1;\n");
  await write("sibling-hidden.ts", "export const sibling = 1;\n");
  git("config", "include.path", include);
  const listed = git("ls-files", "--others", "--exclude-standard", "-z").split("\0");
  assert.ok(!listed.includes("root-hidden.ts"));
  assert.ok(listed.includes("sibling-hidden.ts"));
  let changes = 0;
  const watch = await createModuleDependencyWatch(
    root,
    () => changes++,
    () => {},
  );
  t.after(() => watch.close());
  const before = changes;
  await write("relative-ignore", "sibling-hidden.ts\n");
  await until(() => changes > before, "No relative excludes notification");
});

test("finite source watches cover empty and newly created directories while avoiding ignored trees and Git objects", async (t) => {
  const { root, write } = await fixture(t);
  await fs.mkdir(path.join(root, "src/empty/deep"), { recursive: true });
  await write(".worktrees/large/.git/objects/hidden", "ignored\n");
  await write("node_modules/large/nested/index.js", "ignored\n");
  await Promise.all(
    Array.from({ length: 323 }, (_, i) =>
      write(`.tent/Nodes/N${i}/N${i}.md`, "---\ntype: goal\n---\n"),
    ),
  );
  const established: Array<{ folder: string; recursive: boolean }> = [];
  const native = fsSync.watch;
  const mocked = t.mock.method(
    fsSync,
    "watch",
    (
      folder: string,
      options: fsSync.WatchOptions,
      listener: (kind: string, filename: string | Buffer | null) => void,
    ) => {
      established.push({ folder, recursive: options.recursive === true });
      return native(folder, options, listener);
    },
  );
  let changes = 0;
  const errors: Error[] = [];
  const watch = await createModuleDependencyWatch(
    root,
    () => changes++,
    (error) => errors.push(error),
  );
  t.after(() => watch.close());
  mocked.mock.restore();
  assert.ok(established.some((item) => item.folder === root && !item.recursive));
  assert.ok(established.some((item) => item.folder === path.join(root, "src") && item.recursive));
  assert.ok(
    established.some((item) => item.folder === path.join(root, ".tent/Nodes") && item.recursive),
  );
  assert.ok(
    !established.some((item) =>
      [".worktrees", "node_modules", ".git/objects", ".tent/.git/objects"].some((prefix) =>
        item.folder.startsWith(path.join(root, prefix)),
      ),
    ),
  );
  let before = changes;
  await write("src/empty/deep/added.ts", "export const added=1;\n");
  await until(() => changes > before, "No empty-directory member notification");
  await write("src/new/deep/a.ts", "export const first=1;\n");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  before = changes;
  await write("src/new/deep/a.ts", "export const next=2;\n");
  await until(() => changes > before, "No newly created directory coverage");
  const renameStarted = Date.now();
  for (;;) {
    try {
      await fs.rename(path.join(root, "src/new"), path.join(root, "src/moved"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || Date.now() - renameStarted > 2000)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  before = changes;
  await write("src/moved/deep/a.ts", "export const moved = 3;\n");
  await until(() => changes > before, "No renamed directory coverage");
  assert.deepEqual(errors, []);
});

test("missing default global config, ignore and attributes files are watched before creation", async (t) => {
  const { base, root } = await fixture(t);
  const taskHome = path.join(base, "home");
  await fs.mkdir(taskHome);
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = taskHome;
  process.env.XDG_CONFIG_HOME = path.join(taskHome, ".config");
  let changes = 0;
  const errors: Error[] = [];
  let watch: Awaited<ReturnType<typeof createModuleDependencyWatch>> | undefined;
  try {
    watch = await createModuleDependencyWatch(
      root,
      () => changes++,
      (error) => errors.push(error),
    );
    let before = changes;
    await fs.writeFile(path.join(taskHome, ".gitconfig"), '[filter "new"]\n\trequired = false\n');
    await until(() => changes > before, "No new default global config notification");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    before = changes;
    await fs.mkdir(path.join(taskHome, ".config/git"), { recursive: true });
    await fs.writeFile(path.join(taskHome, ".config/git/ignore"), "ignored.ts\n");
    await until(() => changes > before, "No new default ignore notification");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    before = changes;
    await fs.writeFile(path.join(taskHome, ".config/git/attributes"), "*.ts text\n");
    await until(() => changes > before, "No new default attributes notification");
    assert.deepEqual(errors, []);
  } finally {
    watch?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});

test("Windows layouts needing child watch roots fall back before obstructing source-parent rename", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows native directory-handle limitation");
  for (const boundary of ["ignored", "repository", "junction"])
    await t.test(boundary, async (t) => {
      const { root, base, write, git } = await fixture(t);
      await write("src/core/live.ts", "export const live=1;\n");
      if (boundary === "ignored") {
        await write(".gitignore", ".tent/\n.scratch/\n.worktrees/\nnode_modules/\nsrc/vendor/\n");
        await write("src/vendor/hidden.ts", "ignored\n");
      } else if (boundary === "repository") {
        await fs.mkdir(path.join(root, "src/vendor"));
        git("init", "--quiet", path.join(root, "src/vendor"));
      } else {
        const target = path.join(base, "target");
        await fs.mkdir(target);
        await fs.symlink(target, path.join(root, "src/link"), "junction");
      }
      const records: Array<{ closed: boolean }> = [];
      const native = fsSync.watch;
      const mocked = t.mock.method(
        fsSync,
        "watch",
        (
          folder: string,
          options: fsSync.WatchOptions,
          listener: (kind: string, filename: string | Buffer | null) => void,
        ) => {
          const handle = native(folder, options, listener);
          const record = { closed: false };
          records.push(record);
          const close = handle.close.bind(handle);
          handle.close = () => {
            record.closed = true;
            return close();
          };
          return handle;
        },
      );
      try {
        await assert.rejects(
          createModuleDependencyWatch(
            root,
            () => {},
            () => {},
          ),
          (error: Error) =>
            error.message.startsWith(
              "Windows source directory requires nested watch roots that obstruct rename:",
            ) && error.message.includes(path.join(root, "src")),
        );
        assert.ok(records.length > 0 && records.every((record) => record.closed));
        await fs.rename(path.join(root, "src"), path.join(root, "moved"));
        assert.ok((await fs.stat(path.join(root, "moved/core/live.ts"))).isFile());
      } finally {
        mocked.mock.restore();
      }
    });
});
