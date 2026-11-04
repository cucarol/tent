import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory, initializeFixtureRepository } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { observeMaterialResource as observeResource } from "../src/fs/source-observation.js";
import {
  materialLocator,
  isDirectoryMaterial,
  localMaterialPath,
  rewriteMaterialPaths,
  isCardResponseSource,
  materialFields,
} from "../src/core/base/material.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { serializeFrontmatter, parseFrontmatter } from "../src/core/base/frontmatter.js";
import { createCardDocument } from "../src/core/graph/card-document.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";

test("directory and prefix declarations inspect local and external addresses without reading members", async (t) => {
  const workspace = await fixture(t);
  const external = await fs.mkdtemp(path.join(testScratchRoot(), "external-directory-"));
  t.after(() => removeTestFixture(external, { recursive: true, force: true }));
  initializeFixtureRepository(external);
  await fs.writeFile(path.join(external, "member.txt"), "never read this member");
  await fs.writeFile(path.join(workspace, ".gitignore"), "uninterpreted rules/**\n");
  const originalOpen = fs.open,
    originalReaddir = fs.readdir;
  const opened = t.mock.method(fs, "open", (..._args: Parameters<typeof originalOpen>) => {
    throw new Error("coverage must not open members");
  });
  const listed = t.mock.method(fs, "readdir", (..._args: Parameters<typeof originalReaddir>) => {
    throw new Error("coverage must not enumerate members");
  });
  syncBuiltinESMExports();
  try {
    const adapter = openTestFs(path.join(workspace, ".tent"));
    for (const resource of [
      "../src/",
      "../src/no-current-match-*",
      pathToFileURL(path.join(workspace, "src")).href + "/",
      pathToFileURL(path.join(workspace, "src", "a*")).href,
      pathToFileURL(external).href + "/",
      pathToFileURL(path.join(external, "member*")).href,
    ]) {
      await adapter.observeMaterial(resource, "index.md");
    }
    await assert.rejects(adapter.observeMaterial("../missing/", "index.md"), /ENOENT/);
    await assert.rejects(adapter.observeMaterial("../missing/a-*", "index.md"), /ENOENT/);
    assert.equal(opened.mock.callCount(), 0);
    assert.equal(listed.mock.callCount(), 0);
  } finally {
    opened.mock.restore();
    listed.mock.restore();
    syncBuiltinESMExports();
  }
});

test("coverage address checks preserve missing directory and prefix-parent diagnostics", async (t) => {
  const workspace = await fixture(t);
  await scaffoldInWorkspace(workspace, {
    name: "Checks",
    nodes: [
      { id: "node-dir", name: "Directory", type: "prompt" },
      { id: "node-prefix", name: "Prefix", type: "prompt" },
    ],
  });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  for (const [id, name, resource] of [
    ["node-dir", "Directory", "../../missing/"],
    ["node-prefix", "Prefix", "../../missing/a-*"],
  ])
    await adapter.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter({ id, type: "prompt", resource }, ""),
    );
  const checked = await runWorkspaceCommand("check", [], { cwd: workspace, json: true });
  assert.equal(checked.exitCode, 1);
  const result = JSON.parse(checked.stdout);
  assert.ok(
    result.issues.some((issue: { kind: string }) => issue.kind === "missing-material-file"),
  );
  assert.ok(result.errors.some((error: { reason: string }) => /ENOENT/.test(error.reason)));
});

test("material text reads live bytes despite clean filters, ident and assume-unchanged", async (t) => {
  const workspace = await fixture(t);
  await fs.writeFile(
    path.join(workspace, ".gitattributes"),
    "src/data.filter filter=ignore\nsrc/ident.txt ident\n",
  );
  await git(workspace, "config", "filter.ignore.clean", "echo constant");
  await fs.writeFile(path.join(workspace, "src/data.filter"), "actual bytes\n");
  await fs.writeFile(path.join(workspace, "src/ident.txt"), "$Id$\n");
  await git(workspace, "add", ".gitattributes", "src");
  await git(workspace, "commit", "--quiet", "-m", "test: attributes");
  await fs.unlink(path.join(workspace, "src/ident.txt"));
  await git(workspace, "checkout", "--", "src/ident.txt");
  const adapter = openTestFs(path.join(workspace, ".tent"));
  const read = (file: string) => adapter.readMaterialText("../src/" + file, "index.md");
  await fs.writeFile(path.join(workspace, "src/data.filter"), "changed actual bytes\n");
  await fs.writeFile(path.join(workspace, "src/ident.txt"), "$Id: replaced $\n");
  assert.equal((await git(workspace, "diff", "--name-only")).trim(), "");
  assert.equal(await read("data.filter"), "changed actual bytes\n");
  assert.equal(await read("ident.txt"), "$Id: replaced $\n");
  await git(workspace, "update-index", "--assume-unchanged", "src/a.txt");
  await fs.writeFile(path.join(workspace, "src/a.txt"), "changed while assumed unchanged\n");
  assert.equal(await read("a.txt"), "changed while assumed unchanged\n");
});
async function observeMaterialResource(workspace: string, owner: string, resource: string) {
  return observeResource(workspace, owner, resource);
}

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "directory-material-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await fs.mkdir(path.join(workspace, "src/nested"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src/a.txt"), "first\n");
  await fs.writeFile(path.join(workspace, "src/nested/b.txt"), "second\n");
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n*.tmp\nignored/\n");
  initializeFixtureRepository(workspace);
  await git(workspace, "config", "core.autocrlf", "false");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "--quiet", "-m", "test: directory fixture");
  return workspace;
}

test("directory declarations preserve slash, reject fragments and enforce safe source types", async (t) => {
  const workspace = await fixture(t);
  const locator = materialLocator("../../src/", "Module/Module.md", true);
  assert.equal(isDirectoryMaterial(locator), true);
  assert.equal(localMaterialPath(locator, workspace), path.join(workspace, "src"));
  const data = { resource: "../../src/", sources: [{ resource: "../../src/" }] };
  rewriteMaterialPaths(data, "Module/Module.md", "Parent/Module/Module.md", new Map());
  assert.deepEqual(data, { resource: "../../../src/", sources: [{ resource: "../../../src/" }] });
  assert.throws(() => materialLocator("../src/#heading", "index.md"), /Directory materials/);
  assert.throws(
    () => materialLocator(pathToFileURL(path.join(workspace, "src")).href + "/?query", "index.md"),
    /Directory materials/,
  );
  await assert.rejects(
    observeMaterialResource(workspace, "index.md", "../src/a.txt/"),
    /not a directory|ENOTDIR/,
  );
  await assert.rejects(
    observeMaterialResource(workspace, "index.md", "../src"),
    /not a regular file/,
  );
  const link = path.join(workspace, "src/link");
  await fs.symlink(
    path.join(workspace, "src/nested"),
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await observeMaterialResource(workspace, "index.md", "../src/");
  await observeMaterialResource(workspace, "index.md", "../src/link/");
});

test("directory markers cannot select Node files as Card sources or response evidence", async (t) => {
  const workspace = await fixture(t);
  await scaffoldInWorkspace(workspace, {
    name: "Directory boundaries",
    nodes: [{ id: "node-main", name: "Main", type: "prompt", body: "fact" }],
  });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  await initializeFixtureHistory(path.join(workspace, ".tent"));
  const catalog = await loadNodeCatalog(adapter);
  assert.equal(isCardResponseSource("/cards/card-response.md/", "index.md"), false);
  await createRoleContext(adapter, { roleId: "role-reader", title: "Reader" });
  const card = await createCardDocument(adapter, {
    prompt: "Directory declaration",
    target: "role-reader",
    sources: [{ resource: "../../src/" }],
  });
  assert.deepEqual(
    materialFields(parseFrontmatter(await adapter.readFile(card.path)).data).sources,
    [{ resource: "../../src/" }],
  );
  await assert.rejects(
    createCardDocument(adapter, {
      prompt: "Node declaration",
      target: "role-reader",
      sources: [{ resource: "/Main/Main.md/" }],
    }),
    /must point to Workspace files/,
  );
});
