import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { observeMaterialResource as observeResource } from "../src/fs/source-observation.js";
import {
  materialLocator,
  isDirectoryMaterial,
  localMaterialPath,
  rewriteMaterialPaths,
  isCardResponseSource,
  materialFields,
} from "../src/core/base/material.js";
import { syncMaterialIdentity } from "../src/core/graph/node-sync-record.js";
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
import { sourceDirectoryPaths } from "../src/fs/directory-observation.js";
import { nodeBasisRecordSchema } from "../src/core/base/node-basis-record.js";
import { prepareNodeSyncSave } from "../src/core/graph/node-sync-record.js";
import { inspectNodeSync } from "../src/core/graph/node-sync.js";

test("old directory manifests and repository locators are opaque extensions", () => {
  for (const directoryFiles of [null, "malformed", [{ path: "../unsafe", version: "bad" }]]) {
    const material = { identity: "coverage", directoryFiles, repository: { blob: "bad" } };
    const record = {
      v: 1,
      materials: [material],
      goals: [
        {
          nodeId: "node-goal",
          version: "a".repeat(64),
          fingerprintVersion: 2,
          materials: [material],
        },
      ],
    };
    assert.deepEqual(nodeBasisRecordSchema.parse(record), record);
  }
  assert.equal(
    nodeBasisRecordSchema.safeParse({
      v: 1,
      materials: [{ identity: "file", version: "bad", fingerprintVersion: 2 }],
    }).success,
    false,
  );
});

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
      const adapter = new NodeFs(path.join(workspace, ".tent"));
      for (const resource of [
        "../src/",
        "../src/no-current-match-*",
        pathToFileURL(path.join(workspace, "src")).href + "/",
        pathToFileURL(path.join(workspace, "src", "a*")).href,
      ]) {
        const observation = await adapter.observeMaterial(resource, "index.md");
        assert.equal(observation.coverage, true);
        assert.equal(observation.observedVersion, undefined);
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

test("directory and prefix declarations have no baselines or sync details, including ancestor goals", async (t) => {
  const workspace = await fixture(t, true);
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Coverage", nodes: [] });
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  await git(path.join(workspace, ".tent"), "init", "--quiet");
  const run = async (command: string, args: string[]) => {
    const result = await runNodeCommand(command, args, { cwd: workspace, json: true });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const goal = (
    await run("create", [
      "Goal",
      "--type",
      "goal",
      "--sources-json",
      JSON.stringify([{ resource: "src/" }, { resource: "src/a*" }]),
    ])
  ).node.nodeId;
  const prompt = (await run("create", ["Rule", "--type", "prompt", "--resource", "src/"])).node
    .nodeId;
  const output = (await run("link-output", [goal, "--resource", "src/"])).nodeId;
  const before = await inspectNodeSync(adapter, output);
  assert.equal(before.state, "synced");
  assert.deepEqual((await inspectNodeSync(adapter, prompt)).materials, []);
  const record = (await adapter.history.nodeRecords())[output]!;
  assert.deepEqual(record.materials, []);
  assert.deepEqual(record.goals![0]!.materials, []);
  await fs.writeFile(path.join(workspace, "src/a.txt"), "changed\n");
  await fs.rename(
    path.join(workspace, "src/nested/b.txt"),
    path.join(workspace, "src/nested/new.txt"),
  );
  await fs.writeFile(path.join(workspace, "src/binary.bin"), Buffer.from([0xff, 0x00]));
  assert.deepEqual(await inspectNodeSync(adapter, output), before);
  assert.equal((await inspectNodeSync(adapter, prompt)).state, "unanchored");
  const node = await readNodeForEdit(adapter, output);
  const goalNode = await readNodeForEdit(adapter, goal);
  const previous = {
    ...record,
    materials: [
      {
        identity: syncMaterialIdentity(
          node.frontmatter.resource as string,
          `${node.path}/${node.name}.md`,
        ),
        version: "a".repeat(64),
        fingerprintVersion: 2 as const,
        directoryFiles: "old malformed manifest",
        repository: "old locator",
      },
    ],
    goals: record.goals!.map((basis) => ({
      ...basis,
      extension: "preserve goal extension",
      materials: materialFields(goalNode.frontmatter).sources!.map((source) => ({
        identity: syncMaterialIdentity(source.resource, `${goalNode.path}/${goalNode.name}.md`),
        version: "a".repeat(64),
        fingerprintVersion: 2 as const,
        directoryFiles: "old malformed manifest",
        repository: "old locator",
      })),
    })),
  };
  const prepared = await prepareNodeSyncSave(adapter, `${node.path}/${node.name}.md`, node.raw, {
    previous,
  });
  assert.deepEqual(prepared.record!.materials, []);
  assert.deepEqual(prepared.record!.goals![0]!.materials, []);
  assert.equal(prepared.record!.goals![0]!.extension, "preserve goal extension");
});

test("coverage address checks preserve missing directory and prefix-parent diagnostics", async (t) => {
  const workspace = await fixture(t, true);
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "Checks",
    nodes: [
      { id: "node-dir", name: "Directory", type: "prompt" },
      { id: "node-prefix", name: "Prefix", type: "prompt" },
    ],
  });
  const adapter = new NodeFs(path.join(workspace, ".tent"));
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

test("structure enumeration excludes tracked and untracked Tent state without ignore rules", async (t) => {
  const workspace = await fixture(t, true);
  await fs.writeFile(path.join(workspace, ".gitignore"), "");
  await fs.mkdir(path.join(workspace, ".tent"));
  await fs.writeFile(path.join(workspace, ".tent/state.ts"), "internal state");
  await git(workspace, "add", "-f", ".tent/state.ts");
  await fs.writeFile(path.join(workspace, ".tent/untracked.ts"), "internal state");
  for (const trackedOnly of [false, true]) {
    const paths = await sourceDirectoryPaths(workspace, workspace, undefined, trackedOnly);
    assert.ok(paths.some((file) => file.endsWith(path.join("src", "a.txt"))));
    assert.ok(paths.every((file) => !path.relative(workspace, file).startsWith(".tent")));
  }
});

test("standalone structure enumeration skips Tent state before traversing its directory", async (t) => {
  const workspace = await fixture(t);
  await fs.writeFile(path.join(workspace, ".gitignore"), "");
  await fs.writeFile(path.join(workspace, ".tent/internal.ts"), "internal state");
  const original = fs.readdir;
  const mocked = t.mock.method(fs, "readdir", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === path.join(workspace, ".tent"))
      throw new Error("Tent state must be excluded before traversal");
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const files = await sourceDirectoryPaths(workspace, workspace);
    assert.ok(files.every((file) => !path.relative(workspace, file).startsWith(".tent")));
    assert.ok(files.some((file) => file.endsWith(path.join("src", "a.txt"))));
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("file materials observe live bytes despite clean filters, ident and assume-unchanged", async (t) => {
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
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  const read = (file: string) => adapter.observeMaterial(`../src/${file}`, "index.md");
  const filtered = await read("data.filter"),
    ident = await read("ident.txt"),
    ordinary = await read("a.txt");
  await fs.writeFile(path.join(workspace, "src/data.filter"), "changed actual bytes\n");
  await fs.writeFile(path.join(workspace, "src/ident.txt"), "$Id: replaced $\n");
  assert.equal((await git(workspace, "diff", "--name-only")).trim(), "");
  assert.notEqual((await read("data.filter")).observedVersion, filtered.observedVersion);
  assert.notEqual((await read("ident.txt")).observedVersion, ident.observedVersion);
  await git(workspace, "update-index", "--assume-unchanged", "src/a.txt");
  await fs.writeFile(path.join(workspace, "src/a.txt"), "changed while assumed unchanged\n");
  assert.notEqual((await read("a.txt")).observedVersion, ordinary.observedVersion);
});
async function observeMaterialResource(workspace: string, owner: string, resource: string) {
  const gitDir = path.join(workspace, ".tent/.git");
  const existing = await fs.stat(path.join(gitDir, "HEAD")).catch(() => undefined);
  return observeResource(
    workspace,
    owner,
    resource,
    existing ? path.join(gitDir, "tent-material-cache") : undefined,
  );
}

async function fixture(t: TestContext, repository = false) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "directory-material-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
    await git(path.join(workspace, ".tent"), "init", "--quiet");
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

test("directory markers cannot select Node semantic content, pinned Card files or response evidence", async (t) => {
  const workspace = await fixture(t, true);
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "Directory boundaries",
    nodes: [{ id: "node-main", name: "Main", type: "prompt", body: "fact" }],
  });
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  await git(path.join(workspace, ".tent"), "init", "--quiet");
  const catalog = await loadNodeCatalog(adapter);
  assert.notEqual(
    syncMaterialIdentity("/Main/Main.md/", "index.md", catalog.byId),
    "node:node-main",
  );
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
        archived: false,
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
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "Root",
    nodes: [{ id: "node-goal", name: "Goal", type: "goal", body: "Root output" }],
  });
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  await git(path.join(workspace, ".tent"), "init", "--quiet");
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

test("non-Git ignore inheritance, negation, globstar and ignored subtree match Git", async (t) => {
  const workspace = await fixture(t);
  await fs.writeFile(
    path.join(workspace, ".gitignore"),
    "*.tmp\n!keep.tmp\n/cache/\nsrc/**/noise?.txt\n",
  );
  await fs.writeFile(path.join(workspace, "src/.gitignore"), "nested/*.txt\n!nested/b.txt\n");
  await fs.writeFile(path.join(workspace, "src/keep.tmp"), "kept");
  await fs.writeFile(path.join(workspace, "src/drop.tmp"), "ignored");
  await fs.writeFile(path.join(workspace, "src/nested/noise1.txt"), "ignored");
  await fs.mkdir(path.join(workspace, "cache"));
  await fs.writeFile(path.join(workspace, "cache/file"), "ignored");
  const plain = await sourceDirectoryPaths(
    workspace,
    path.join(workspace, "src"),
    path.join(workspace, ".tent/.git/tent-material-cache"),
  );
  const ignored = await sourceDirectoryPaths(
    workspace,
    path.join(workspace, "cache"),
    path.join(workspace, ".tent/.git/tent-material-cache"),
  );
  assert.deepEqual(ignored, []);
  await git(workspace, "init", "--quiet");
  const indexed = await sourceDirectoryPaths(
    workspace,
    path.join(workspace, "src"),
    path.join(workspace, ".tent/.git/tent-material-cache"),
  );
  assert.deepEqual(indexed, plain);
});

test("non-Git escaped patterns, character classes and directory pruning agree with Git", async (t) => {
  const workspace = await fixture(t);
  await fs.writeFile(
    path.join(workspace, ".gitignore"),
    "\\#hash.txt\n\\!bang.txt\nspace\\ .txt\n[ab].tmp\n!b.tmp\n**/drop[0-9].txt\nclass[[:digit:]].txt\n[]a].class\npruned/\n!pruned/keep.txt\nopen/*\n!open/keep/\n",
  );
  for (const filename of [
    "#hash.txt",
    "!bang.txt",
    "space .txt",
    "a.tmp",
    "b.tmp",
    "c.tmp",
    "drop7.txt",
    "dropx.txt",
    "deep/drop2.txt",
    "class4.txt",
    "classx.txt",
    "].class",
    "a.class",
    "b.class",
    "pruned/keep.txt",
    "open/drop/file.txt",
    "open/keep/file.txt",
  ]) {
    const target = path.join(workspace, "src", filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "file\n");
  }
  const plain = await sourceDirectoryPaths(
    workspace,
    path.join(workspace, "src"),
    path.join(workspace, ".tent/.git/tent-material-cache"),
  );
  await git(workspace, "init", "--quiet");
  const indexed = await sourceDirectoryPaths(
    workspace,
    path.join(workspace, "src"),
    path.join(workspace, ".tent/.git/tent-material-cache"),
  );
  assert.deepEqual(indexed, plain);
});
