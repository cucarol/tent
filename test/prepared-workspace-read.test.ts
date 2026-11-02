import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { git } from "./helpers.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import { loadStopMaterialIndex, preparedGraphSnapshot } from "../src/fs/stop-material-index.js";
import { readAgentContextRepository } from "../src/fs/workspace-scan.js";
import { sourceDirectoryPaths } from "../src/fs/directory-observation.js";
import { findPreparedHookWorkspace } from "../src/fs/hook-material-index.js";

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(testScratchRoot(), "prepared-workspace-"));
  const root = path.join(base, "project"),
    home = path.join(base, "home");
  t.after(() =>
    removeTestFixture(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await fs.mkdir(root);
  await fs.mkdir(home);
  const previousHome = process.env.HOME,
    previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });
  await git(root, "init", "--quiet");
  for (const directory of ["src", "lib", "other", ".tent/.git", ".tent/A"])
    await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, "src/main.ts"), 'import "../lib/value.js";');
  await fs.writeFile(path.join(root, "lib/value.ts"), "export const value = 1;");
  await fs.writeFile(path.join(root, "other/value.ts"), "export const value = 2;");
  await git(root, "add", "src", "lib", "other");
  await fs.writeFile(path.join(root, ".tent/index.md"), '---\nokf_version: "0.2"\n---\n');
  await fs.writeFile(
    path.join(root, ".tent/A/A.md"),
    "---\nid: node-a\ntype: goal\nsources:\n  - resource: ../../src/\n    track: structure\n---\nGoal\n",
  );
  const now = Date.now() + 10_000;
  t.mock.method(Date, "now", () => now);
  const adapter = openTestFs(path.join(root, ".tent"));
  const read = (forceContent = false) =>
    adapter.observationScope(
      async () => ({
        repository: await readAgentContextRepository(root),
        live: await sourceDirectoryPaths(root, root),
        material: await adapter.observeMaterial("../../src/", "A/A.md"),
      }),
      { forceContent },
    );
  return {
    root,
    home,
    adapter,
    read,
    prepare: () => loadStopMaterialIndex(path.join(root, ".tent"), root, [], adapter),
  };
}

test("the shared Hook snapshot preserves repository, listing and material observations", async (t) => {
  const f = await fixture(t);
  const original = await f.read(true);
  await f.prepare();
  assert.ok((await preparedGraphSnapshot(path.join(f.root, ".tent"), f.root))?.repository);
  assert.deepEqual(await f.read(), original);
  await fs.writeFile(path.join(f.root, "src/main.ts"), 'import "../other/value.js";');
  const current = await f.read();
  assert.deepEqual(current, await f.read(true));
  assert.notDeepEqual(current.repository, original.repository);
  await f.prepare();
  await fs.writeFile(path.join(f.root, "src/new.ts"), "new file");
  assert.ok((await f.read()).live.includes(path.join(f.root, "src/new.ts")));
});

test("unrelated external home writes leave both read and Hook prepared validity intact", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const before = await f.read();
  const hook = await findPreparedHookWorkspace(f.root);
  assert.ok(hook);
  await fs.writeFile(path.join(f.home, "session-state"), "unrelated change");
  assert.ok((await preparedGraphSnapshot(path.join(f.root, ".tent"), f.root))?.repository);
  assert.deepEqual(await f.read(), before);
  assert.deepEqual(await findPreparedHookWorkspace(f.root), hook);
});

test("ignore changes and repository discovery failures do not reuse prepared evidence", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  await fs.writeFile(path.join(f.root, ".gitignore"), "src/\n");
  assert.deepEqual(await f.read(), await f.read(true));
  await f.prepare();
  await fs.writeFile(path.join(f.root, ".git/config"), "[invalid\n");
  await assert.rejects(f.read(), /git|config|fatal/i);
});

test("recovered transient source errors are reobserved rather than retained", async (t) => {
  const f = await fixture(t),
    originalRead = fs.readFile;
  let injected = false;
  const mocked = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (!injected && path.resolve(String(args[0])) === path.join(f.root, "src/main.ts")) {
      injected = true;
      throw Object.assign(new Error("EIO: temporary source read failure"), { code: "EIO" });
    }
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  try {
    await f.prepare();
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(injected);
  assert.deepEqual(await f.read(), await f.read(true));
  await f.prepare();
  assert.ok((await preparedGraphSnapshot(path.join(f.root, ".tent"), f.root))?.repository);
  assert.deepEqual(await f.read(), await f.read(true));
});
