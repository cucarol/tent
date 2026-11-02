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
