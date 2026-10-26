import { openTestFs, removeTestFixture } from "./node-fs.js";
import { historyHead } from "./scratch.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { initialSourceFile } from "../src/fs/checked-source-file.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

/** Force the two real kernel failures to arrive in either order, without changing the files. */
async function missingFailureOrder<T>(
  t: TestContext,
  directory: string,
  first: "lstat" | "realpath",
  action: () => Promise<T>,
): Promise<T> {
  let firstFailed!: () => void;
  const failed = new Promise<void>((resolve) => {
    firstFailed = resolve;
  });
  const pending: Promise<unknown>[] = [];
  const seen = new Set<string>();
  const mocks = (["lstat", "realpath"] as const).map((method) => {
    const original = fs[method];
    return t.mock.method(fs, method, (...args: unknown[]) => {
      const run = (async () => {
        if (String(args[0]) !== directory) return Reflect.apply(original, fs, args);
        seen.add(method);
        if (method !== first) {
          await failed;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        try {
          return await Reflect.apply(original, fs, args);
        } finally {
          if (method === first) firstFailed();
        }
      })();
      pending.push(run);
      return run;
    });
  });
  syncBuiltinESMExports();
  try {
    const result = await action();
    assert.deepEqual(seen, new Set(["lstat", "realpath"]));
    return result;
  } finally {
    await Promise.allSettled(pending);
    for (const mocked of mocks) mocked.mock.restore();
    syncBuiltinESMExports();
  }
}

test("a missing source directory has the same diagnostic whichever probe fails first", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "missing-order-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const directory = path.join(root, "absent");
  const errors = [];
  for (const first of ["realpath", "lstat"] as const) {
    errors.push(
      await missingFailureOrder(t, directory, first, async () => {
        try {
          await initialSourceFile(root, path.join(directory, "file.md"));
          assert.fail("missing material must remain unavailable");
        } catch (error) {
          const failure = error as NodeJS.ErrnoException;
          assert.equal(failure.code, "ENOENT");
          return { message: failure.message, syscall: failure.syscall, path: failure.path };
        }
      }),
    );
  }
  assert.deepEqual(errors[0], errors[1]);
  assert.equal(errors[0]!.syscall, "lstat");
  assert.equal(errors[0]!.path, directory, "report the missing ancestor, not a leaf underneath it");
});

test("drift cursors survive missing-material probe order but still reject a material repair", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "drift-missing-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), { name: "Drift" });
  const system = path.join(root, ".tent");
  await initializeFixtureHistory(system);
  const directory = path.join(root, "materials");
  await fs.mkdir(directory);
  const resource = path.join(directory, "input.md");
  await fs.writeFile(resource, "original\n");
  const options = { workspace: root, json: true };
  for (const name of ["One", "Two"]) {
    const created = await runNodeCommand(
      "create",
      [name, "--type", "prompt", "--resource", "materials/input.md"],
      options,
    );
    assert.equal(created.exitCode, 0, created.stderr);
  }
  await fs.rm(directory, { recursive: true });
  const canvas = path.join(system, "canvas.json");
  const role = path.join(system, "roles", "role-local.md");
  await fs.mkdir(path.dirname(role), { recursive: true });
  await fs.writeFile(
    role,
    "---\ntype: role\nid: role-local\ntitle: Local\n---\nUncommitted role text.\n",
  );
  await fs.writeFile(canvas, '{"version":3,"drawings":[]}\n');
  const before = {
    head: await historyHead(system),
    status: await fs.readFile(path.join(system, ".git/history.sqlite"), "hex"),
    role: await fs.readFile(role, "utf8"),
    canvas: await fs.readFile(canvas, "utf8"),
  };
  const read = (first: "lstat" | "realpath", args: string[]) =>
    missingFailureOrder(t, directory, first, async () => {
      const result = await runWorkspaceCommand("drift", args, options);
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout);
    });
  const first = await read("realpath", ["--limit", "1"]);
  const repeated = await read("lstat", ["--limit", "1"]);
  assert.deepEqual(repeated, first);
  assert.equal(first.page.hasMore, true);
  const second = await read("lstat", ["--cursor", first.page.nextCursor]);
  assert.equal(second.revision, first.revision);
  assert.equal(second.page.hasMore, false);
  assert.notEqual(second.items[0].nodeId, first.items[0].nodeId);
  assert.deepEqual(
    {
      head: await historyHead(system),
      status: await fs.readFile(path.join(system, ".git/history.sqlite"), "hex"),
      role: await fs.readFile(role, "utf8"),
      canvas: await fs.readFile(canvas, "utf8"),
    },
    before,
  );
  await fs.mkdir(directory);
  await fs.writeFile(resource, "original\n");
  const changed = await runWorkspaceCommand("drift", ["--cursor", first.page.nextCursor], options);
  assert.equal(changed.exitCode, 1);
  assert.match(changed.stderr, /SOURCE_CHANGED|source changed/i);
});
