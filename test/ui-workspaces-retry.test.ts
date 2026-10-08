import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readWorkspaces, rememberWorkspace } from "../src/ui-server/workspaces.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "ui-workspaces-retry-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "ui-workspaces.json");
  const workspace = (i: number) => ({
    root: path.join(dir, `ws${i}`),
    name: `ws${i}`,
    id: `ws-${i}`,
  });
  await rememberWorkspace(file, workspace(0));
  return { file, workspace };
}

function simulateWindowsRename(t: TestContext, implementation: typeof fs.rename) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  const mocked = t.mock.method(fs, "rename", implementation);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  });
  return mocked;
}

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`concurrent workspace writes retain every entry after transient Windows ${code}`, async (t) => {
    const { file, workspace } = await fixture(t);
    const rename = fs.rename;
    let attempts = 0;
    simulateWindowsRename(t, async (from, to) => {
      assert.equal(from, `${file}.${process.pid}.tmp`);
      assert.equal(to, file);
      if (++attempts <= 2) {
        assert.deepEqual(
          (await readWorkspaces(file)).map((w) => w.id),
          ["ws-0"],
        );
        throw Object.assign(new Error("temporarily occupied"), { code });
      }
      return rename(from, to);
    });
    await Promise.all(
      Array.from({ length: 7 }, (_, i) => rememberWorkspace(file, workspace(i + 1))),
    );
    assert.deepEqual(
      (await readWorkspaces(file)).map((w) => w.id),
      ["ws-7", "ws-6", "ws-5", "ws-4", "ws-3", "ws-2", "ws-1", "ws-0"],
    );
    assert.equal(attempts, 9);
  });
}

test("exhausted workspace publication preserves the old list and lets the next queued write succeed", async (t) => {
  const { file, workspace } = await fixture(t);
  const rename = fs.rename;
  const before = await fs.readFile(file, "utf8");
  const failure = Object.assign(new Error("still occupied"), { code: "EPERM" });
  let attempts = 0;
  simulateWindowsRename(t, async (from, to) => {
    if (++attempts <= 10) {
      assert.equal(await fs.readFile(file, "utf8"), before);
      throw failure;
    }
    return rename(from, to);
  });
  const failed = rememberWorkspace(file, workspace(1));
  const next = rememberWorkspace(file, workspace(2));
  await Promise.all([assert.rejects(failed, (error) => error === failure), next]);
  assert.equal(attempts, 11);
  assert.deepEqual(
    (await readWorkspaces(file)).map((w) => w.id),
    ["ws-2", "ws-0"],
  );
});
