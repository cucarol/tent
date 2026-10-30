import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { importGitHistory } from "../src/fs/import-git-history.js";
import { testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { git } from "./helpers.js";

async function inventory(root: string, prefix = ""): Promise<[string, string][]> {
  const rows: [string, string][] = [];
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) rows.push([file, "directory"], ...(await inventory(root, file)));
    else
      rows.push([
        file,
        createHash("sha256")
          .update(await fs.readFile(path.join(root, file)))
          .digest("hex"),
      ]);
  }
  return rows;
}

async function legacy(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-target-")),
    source = path.join(workspace, "source/.tent");
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await fs.mkdir(path.join(source, "Goal"), { recursive: true });
  await git(source, "init", "--quiet", "--initial-branch=main", "--template=");
  await git(source, "config", "core.autocrlf", "false");
  // Keep the byte inventory stable after commit; background Git housekeeping owns transient locks.
  await git(source, "config", "maintenance.auto", "false");
  await git(source, "config", "gc.auto", "0");
  const raw = "---\nid: node-goal\ntype: prompt\n---\nRetained bytes\n";
  await fs.writeFile(path.join(source, "Goal/Goal.md"), raw);
  await git(source, "add", ".");
  await git(source, "commit", "--quiet", "-m", "legacy target boundary");
  return { workspace, source, raw };
}

test("migration rejects source and missing descendants before changing any source bytes", async (t) => {
  const { source } = await legacy(t),
    before = await inventory(source);
  for (const target of [source, path.join(source, "missing/target/.tent")]) {
    await assert.rejects(importGitHistory(source, target), /target must be separate/);
    assert.deepEqual(await inventory(source), before);
  }
});

test("migration rejects a case alias descendant before creating its target", async (t) => {
  const { workspace, source } = await legacy(t),
    alias = path.join(workspace, "SOURCE/.tent");
  if (
    !(await fs.stat(alias).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return false;
        throw e;
      },
    ))
  )
    return t.skip("This filesystem does not resolve the alternate-case fixture parent");
  const before = await inventory(source);
  await assert.rejects(
    importGitHistory(source, path.join(alias, "missing/.tent")),
    /target must be separate/,
  );
  assert.deepEqual(await inventory(source), before);
});

test("migration rejects a junction descendant but allows a separate target through a junction", async (t) => {
  const { workspace, source, raw } = await legacy(t),
    alias = path.join(workspace, "source-alias"),
    external = path.join(workspace, "external"),
    externalAlias = path.join(workspace, "external-alias");
  await fs.symlink(source, alias, "junction");
  const before = await inventory(source);
  await assert.rejects(
    importGitHistory(source, path.join(alias, "missing/.tent")),
    /target must be separate/,
  );
  assert.deepEqual(await inventory(source), before);
  await fs.mkdir(external);
  await fs.symlink(external, externalAlias, "junction");
  const target = path.join(externalAlias, "new/.tent"),
    imported = await importGitHistory(source, target),
    adapter = openTestFs(target);
  assert.equal(
    await adapter.history.read({ commit: imported.targetHead!, path: "Goal/Goal.md" }),
    raw,
  );
  await adapter.close();
  assert.deepEqual(await inventory(source), before);
});

test("migration accepts a separate sibling sharing the source name prefix", async (t) => {
  const { source, raw } = await legacy(t),
    before = await inventory(source),
    target = source + "-separate";
  const imported = await importGitHistory(source, target),
    adapter = openTestFs(target);
  assert.equal(
    await adapter.history.read({ commit: imported.targetHead!, path: "Goal/Goal.md" }),
    raw,
  );
  await adapter.close();
  assert.deepEqual(await inventory(source), before);
});
