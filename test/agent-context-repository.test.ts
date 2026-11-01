import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "./helpers.js";
import { testScratchRoot } from "./scratch.js";
import { removeTestFixture } from "./node-fs.js";
import { readAgentContextRepository, readModuleMapRepository } from "../src/fs/workspace-scan.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "context-repository-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  for (const [file, content] of Object.entries({
    "nested/src/a.ts": "export const a = 1;",
    "nested/test/a.test.ts": "import { a } from '../src/a'; console.log(a);",
    "nested/tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler"}}',
    "nested/.tent/hidden.ts": "export const hidden = 1;",
    "outside.ts": "export const outside = 1;",
  })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  await git(root, "add", ".");
  return { root, workspace: path.join(root, "nested") };
}

test("context repository preserves current source and test facts without requiring project history", async (t) => {
  const { root, workspace } = await fixture(t);
  const baseline = await readModuleMapRepository(workspace);
  const expected = { trackedFiles: baseline.trackedFiles, sources: baseline.sources };
  assert.deepEqual(await readAgentContextRepository(workspace), expected);
  assert.deepEqual(expected.trackedFiles, ["src/a.ts", "test/a.test.ts", "tsconfig.json"]);
  assert.ok(expected.sources.files.find((file) => file.path === "test/a.test.ts")?.content);
  assert.deepEqual(expected.sources.errors, []);

  // HEAD resolves, but its object is unavailable: history consumers must still fail.
  await fs.writeFile(path.join(root, ".git/refs/heads/main"), "a".repeat(40) + "\n");
  await assert.rejects(readModuleMapRepository(workspace));
  assert.deepEqual(await readAgentContextRepository(workspace), expected);
});

test("context repository retains required source read errors and reobserves changed test bytes", async (t) => {
  const { workspace } = await fixture(t);
  await fs.unlink(path.join(workspace, "src/a.ts"));
  const changed = "import { a } from '../src/a'; console.log(a + 1);";
  await fs.writeFile(path.join(workspace, "test/a.test.ts"), changed);
  const repository = await readAgentContextRepository(workspace);
  assert.ok(repository.trackedFiles.includes("src/a.ts"));
  assert.equal(
    repository.sources.files.find((file) => file.path === "src/a.ts")?.content,
    undefined,
  );
  assert.deepEqual(
    repository.sources.errors.map((error) => error.file),
    ["src/a.ts"],
  );
  assert.equal(
    repository.sources.files.find((file) => file.path === "test/a.test.ts")?.content,
    changed,
  );
});

test("context repository does not turn failed repository discovery into empty evidence", async (t) => {
  const { root, workspace } = await fixture(t);
  await fs.rename(path.join(root, ".git"), path.join(root, "saved-git"));
  // A broken gitdir prevents accidental discovery of this test checkout's parent repository.
  await fs.writeFile(path.join(root, ".git"), "gitdir: ./missing-repository\n");
  await assert.rejects(readAgentContextRepository(workspace));
});
