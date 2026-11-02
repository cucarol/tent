import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
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
import { ContextReader } from "../src/core/graph/context-reader.js";
import { contentEtag } from "../src/core/base/etag.js";
import { serializeFrontmatter, parseFrontmatter } from "../src/core/base/frontmatter.js";
import { createCardDocument, verifyCardSourceVersion } from "../src/core/graph/card-document.js";
import { workspaceMaterialFields, linkOutputResource } from "../src/cli/material-input.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";

for (const repository of [false, true])
  test(`directory and prefix coverage only inspect their address (${repository ? "Git" : "non-Git"})`, async (t) => {
    const workspace = await fixture(t, repository);
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
      ]) {
        const observation = await adapter.observeMaterial(resource, "index.md");
        assert.equal(observation.coverage, true);

        assert.equal("directoryFiles" in observation, false);
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
  const workspace = await fixture(t, true);
  await scaffoldInWorkspace(openTestFs(workspace), {
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
  const workspace = await fixture(t, true);
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

async function fixture(t: TestContext, repository = false) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "directory-material-"));
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await fs.mkdir(path.join(workspace, "src/nested"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src/a.txt"), "first\n");
  await fs.writeFile(path.join(workspace, "src/nested/b.txt"), "second\n");
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n*.tmp\nignored/\n");
  if (repository) {
    await git(workspace, "init", "--quiet", "--initial-branch=main");
    await git(workspace, "config", "core.autocrlf", "false");
    await git(workspace, "add", ".");
    await git(workspace, "commit", "--quiet", "-m", "test: directory fixture");
  } else {
    await fs.mkdir(path.join(workspace, ".tent"));
    await initializeFixtureHistory(path.join(workspace, ".tent"));
    // Fixtures must stay in project .scratch, which itself belongs to the outer
    // Git worktree. Hide only that ancestor's Git marker to exercise a genuinely
    // absent discovery boundary; fixture-local repositories remain discoverable.
    const original = fs.lstat;
    const mocked = t.mock.method(fs, "lstat", (...args: Parameters<typeof original>) => {
      const filename = String(args[0]);
      if (path.basename(filename) === ".git" && !filename.startsWith(workspace + path.sep))
        return Promise.reject(
          Object.assign(new Error("No ancestor Git in this fixture"), { code: "ENOENT" }),
        );
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
  }
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
  assert.equal((await observeMaterialResource(workspace, "index.md", "../src/")).coverage, true);
  await assert.rejects(
    observeMaterialResource(workspace, "index.md", "../src/link/"),
    /Symbolic links/,
  );
});

test("directory markers cannot select pinned Card files or response evidence", async (t) => {
  const workspace = await fixture(t, true);
  await scaffoldInWorkspace(openTestFs(workspace), {
    name: "Directory boundaries",
    nodes: [{ id: "node-main", name: "Main", type: "prompt", body: "fact" }],
  });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  await initializeFixtureHistory(path.join(workspace, ".tent"));
  const catalog = await loadNodeCatalog(adapter);
  assert.equal(isCardResponseSource("/cards/card-response.md/", "index.md"), false);
  const card = await createCardDocument(adapter, {
    prompt: "Directory declaration",
    sources: [{ resource: "../../src/" }],
  });
  assert.equal(
    materialFields(parseFrontmatter(await adapter.readFile(card.path)).data).sources![0]!.version,
    undefined,
  );
  const pinned = await createCardDocument(adapter, {
    prompt: "Node declaration",
    sources: [{ resource: "/Main/Main.md" }],
  });
  await assert.rejects(
    verifyCardSourceVersion(adapter, pinned.path, {
      ...materialFields(parseFrontmatter(await adapter.readFile(pinned.path)).data).sources![0]!,
      resource: "/Main/Main.md/",
    }),
    /must address/,
  );
  const raw = serializeFrontmatter(
    { id: "node-main", type: "prompt", resource: "/Main/Main.md/" },
    "fact",
  );
  const reader = new ContextReader(
    { kind: "live", workspaceId: "directory" },
    [
      {
        nodeId: "node-main",
        name: "Main",
        path: "Main",
        type: "prompt",
        raw,
        etag: contentEtag(raw),
        parentNodeId: null,
        childNodeIds: [],
        status: "stable",
        invalid: false,
      },
    ],
    ["node-main"],
  );
  assert.equal(
    reader.relations({ nodeId: "node-main", direction: "outgoing" }).items[0]!.target,
    undefined,
  );
});

test("CLI Workspace-root directory declarations and link-output retain the root address", async (t) => {
  const workspace = await fixture(t, true);
  await scaffoldInWorkspace(openTestFs(workspace), {
    name: "Root",
    nodes: [{ id: "node-goal", name: "Goal", type: "goal", body: "Root output" }],
  });
  const adapter = openTestFs(path.join(workspace, ".tent"));
  await initializeFixtureHistory(path.join(workspace, ".tent"));
  assert.equal(
    (await workspaceMaterialFields({ resource: "/" }, "index.md", workspace)).resource,
    "../",
  );
  assert.equal(linkOutputResource("../"), "./");
  assert.equal(
    (await workspaceMaterialFields({ resource: ".tent/" }, "index.md", workspace)).resource,
    "./",
  );
  const result = await runNodeCommand("link-output", ["node-goal", "--resource", "/"], {
    cwd: workspace,
    json: true,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const node = await readNodeForEdit(adapter, JSON.parse(result.stdout).nodeId);
  assert.equal(node.name, "Output");
  assert.equal(
    localMaterialPath(
      materialLocator(node.frontmatter.resource as string, `${node.path}/${node.name}.md`),
      workspace,
    ),
    workspace,
  );
  const prefix = await runNodeCommand(
    "link-output",
    ["node-goal", "--resource", "src/no-current-match-*", "--name", "Prefix"],
    {
      cwd: workspace,
      json: true,
    },
  );
  assert.equal(prefix.exitCode, 0, prefix.stderr);
  const missing = await runNodeCommand(
    "link-output",
    ["node-goal", "--resource", "missing/a-*", "--name", "Missing"],
    {
      cwd: workspace,
      json: true,
    },
  );
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /not found/);
});
