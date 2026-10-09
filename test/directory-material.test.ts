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
} from "../src/core/material.js";
import { syncMaterialIdentity } from "../src/core/node-sync-record.js";
import { loadNodeCatalog } from "../src/core/node-catalog.js";
import { ContextReader } from "../src/core/context-reader.js";
import { contentEtag } from "../src/core/etag.js";
import { serializeFrontmatter, parseFrontmatter } from "../src/core/frontmatter.js";
import { createCardDocument, verifyCardSourceVersion } from "../src/core/card-document.js";
import { workspaceMaterialFields, linkOutputResource } from "../src/cli/material-input.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { checkGraph } from "../src/core/graph-check.js";
import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { runWorkspaceCommand } from "../src/cli/workspace-commands.js";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { directoryFingerprint } from "../src/core/directory-material.js";
import { nodeBasisRecordSchema } from "../src/core/node-basis-record.js";

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

test("retained directory manifests validate ordered membership and its content digest", () => {
  const directoryFiles = [{ path: "a.txt", version: "a".repeat(64) }];
  const material = {
    identity: "path:../src/",
    fingerprintVersion: 2,
    version: directoryFingerprint(directoryFiles),
    directoryFiles,
  };
  assert.equal(
    directoryFingerprint([{ version: directoryFiles[0]!.version, path: "a.txt" }]),
    material.version,
  );
  assert.equal(nodeBasisRecordSchema.safeParse({ v: 1, materials: [material] }).success, true);
  assert.equal(
    nodeBasisRecordSchema.safeParse({ v: 1, materials: [{ ...material, version: "b".repeat(64) }] })
      .success,
    false,
  );
  assert.equal(
    nodeBasisRecordSchema.safeParse({
      v: 1,
      materials: [{ ...material, directoryFiles: [...directoryFiles, ...directoryFiles] }],
    }).success,
    false,
  );
  const unsorted = [{ path: "z.txt", version: "a".repeat(64) }, ...directoryFiles];
  assert.equal(
    nodeBasisRecordSchema.safeParse({
      v: 1,
      materials: [
        { ...material, version: directoryFingerprint(unsorted), directoryFiles: unsorted },
      ],
    }).success,
    false,
  );
  assert.equal(
    nodeBasisRecordSchema.safeParse({
      v: 1,
      materials: [],
      goals: [
        {
          nodeId: "node-goal",
          version: "a".repeat(64),
          fingerprintVersion: 2,
          materials: [{ ...material, version: "b".repeat(64) }],
        },
      ],
    }).success,
    false,
  );
});

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

test("standalone reads require trustworthy ignore interpretation and never initialize Tent Git", async (t) => {
  const workspace = await fixture(t);
  const gitDir = path.join(workspace, ".tent/.git");
  await fs.rm(gitDir, { recursive: true });
  const read = () => observeResource(workspace, "index.md", "../src/");
  await assert.rejects(read, { message: "缺少可信的忽略规则解释" });
  await fs.unlink(path.join(workspace, ".gitignore"));
  const ruleFree = await read();
  assert.deepEqual(
    ruleFree.directoryFiles!.map((file) => file.path),
    ["a.txt", "nested/b.txt"],
  );
  await fs.mkdir(path.join(workspace, "src/nested/empty"));
  assert.equal((await read()).observedVersion, ruleFree.observedVersion);
  await fs.writeFile(path.join(workspace, "src/nested/.gitignore"), "*.txt\n");
  await assert.rejects(read, { message: "缺少可信的忽略规则解释" });
  await assert.rejects(fs.stat(gitDir), { code: "ENOENT" });
});

for (const repository of [false, true])
  test(`directory caches are disposable and write failures preserve authority (${repository ? "Git" : "non-Git"})`, async (t) => {
    const workspace = await fixture(t, repository);
    const tent = path.join(workspace, ".tent");
    if (repository) {
      await fs.mkdir(tent);
      await git(tent, "init", "--quiet");
    }
    const cacheDir = path.join(tent, ".git/tent-material-cache");
    async function authority() {
      const files: Array<{ path: string; hash: string }> = [];
      async function walk(folder: string) {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          const filename = path.join(folder, entry.name);
          if (filename === cacheDir) continue;
          if (entry.isDirectory()) await walk(filename);
          else if (entry.isFile())
            files.push({
              path: path.relative(workspace, filename),
              hash: createHash("sha256")
                .update(await fs.readFile(filename))
                .digest("hex"),
            });
        }
      }
      await walk(workspace);
      return files.sort((a, b) => a.path.localeCompare(b.path));
    }
    const read = () => new NodeFs(tent, "cli", "inspect").observeMaterial("../src/", "index.md");
    const comparable = (value: Awaited<ReturnType<typeof read>>) => ({
      canonicalPath: value.canonicalPath,
      version: value.observedVersion,
      files: value.directoryFiles,
      blobs: value.blobs,
    });
    const originalAuthority = await authority();
    const original = await read();
    assert.deepEqual(await authority(), originalAuthority);
    assert.deepEqual(comparable(await read()), comparable(original));
    await fs.rm(cacheDir, { recursive: true, force: true });
    const rebuilt = await read();
    assert.deepEqual(comparable(rebuilt), comparable(original));
    assert.deepEqual(await authority(), originalAuthority);
    await fs.rm(cacheDir, { recursive: true, force: true });
    const underCache = (filename: unknown) => {
      const resolved = path.resolve(String(filename));
      return resolved === cacheDir || resolved.startsWith(cacheDir + path.sep);
    };
    const mocks = (["readFile", "mkdir", "writeFile", "rename", "rm"] as const).map((name) => {
      const actual = fs[name] as (...args: unknown[]) => unknown;
      return t.mock.method(fs, name, ((...args: unknown[]) =>
        underCache(args[0])
          ? Promise.reject(Object.assign(new Error("Read-only cache fixture"), { code: "EACCES" }))
          : actual(...args)) as (typeof fs)[typeof name]);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(comparable(await read()), comparable(original));
      assert.deepEqual(await authority(), originalAuthority);
      await assert.rejects(fs.stat(cacheDir), { code: "ENOENT" });
    } finally {
      for (const mocked of mocks) mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });

for (const repository of [false, true])
  test(`directory fingerprints track exact normalized file membership (${repository ? "Git" : "non-Git"})`, async (t) => {
    const workspace = await fixture(t, repository);
    const adapter = new NodeFs(path.join(workspace, ".tent"));
    const observe = () => adapter.observeMaterial("../../src/", "Module/Module.md");
    const original = await observe();
    assert.deepEqual(
      original.directoryFiles!.map((file) => file.path),
      ["a.txt", "nested/b.txt"],
    );
    await fs.writeFile(path.join(workspace, "src/a.txt"), "first\r\n");
    assert.equal((await observe()).observedVersion, original.observedVersion);
    if (repository) {
      await git(workspace, "add", "src/a.txt");
      assert.equal((await observe()).observedVersion, original.observedVersion);
    }
    await fs.writeFile(path.join(workspace, "src/noise.tmp"), "ignored\n");
    await fs.mkdir(path.join(workspace, "src/ignored"));
    await fs.writeFile(path.join(workspace, "src/ignored/data.txt"), "ignored\n");
    await fs.mkdir(path.join(workspace, "src/empty"));
    assert.equal((await observe()).observedVersion, original.observedVersion);
    await fs.writeFile(path.join(workspace, "src/new.txt"), "added\n");
    const added = await observe();
    assert.notEqual(added.observedVersion, original.observedVersion);
    await fs.unlink(path.join(workspace, "src/new.txt"));
    assert.equal((await observe()).observedVersion, original.observedVersion);
    await fs.rename(
      path.join(workspace, "src/nested/b.txt"),
      path.join(workspace, "src/nested/renamed.txt"),
    );
    const renamed = await observe();
    assert.notEqual(renamed.observedVersion, original.observedVersion);
    await fs.writeFile(path.join(workspace, "src/nested/renamed.txt"), "modified\n");
    const changed = await observe();
    assert.notEqual(changed.observedVersion, renamed.observedVersion);
    if (repository) {
      await git(workspace, "add", ".");
      assert.equal((await observe()).observedVersion, changed.observedVersion);
    }
    await fs.unlink(path.join(workspace, "src/a.txt"));
    assert.notEqual((await observe()).observedVersion, changed.observedVersion);
    const empty = await adapter.observeMaterial("../../src/empty/", "Module/Module.md");
    await fs.mkdir(path.join(workspace, "src/empty/nested"));
    assert.equal(
      (await adapter.observeMaterial("../../src/empty/", "Module/Module.md")).observedVersion,
      empty.observedVersion,
    );
    const uri = pathToFileURL(path.join(workspace, "src/empty")).href + "/";
    assert.equal(
      (await adapter.observeMaterial(uri, "Module/Module.md")).observedVersion,
      empty.observedVersion,
    );
  });

test("Git excludes ignored tracked files and Git metadata and counts binary bytes", async (t) => {
  const workspace = await fixture(t, true);
  await fs.writeFile(path.join(workspace, "src/forced.tmp"), "tracked but ignored\n");
  await git(workspace, "add", "-f", "src/forced.tmp");
  const read = () => observeMaterialResource(workspace, "index.md", "../src/");
  const baseline = await read();
  await fs.writeFile(
    path.join(workspace, "src/Node.md"),
    serializeFrontmatter(
      { id: "node-member", type: "prompt", description: "first" },
      "unchanged body\n",
    ),
  );
  const nodeBytes = await read();
  await fs.writeFile(
    path.join(workspace, "src/Node.md"),
    serializeFrontmatter(
      { id: "node-member", type: "prompt", description: "second" },
      "unchanged body\n",
    ),
  );
  assert.notEqual((await read()).observedVersion, nodeBytes.observedVersion);
  await fs.unlink(path.join(workspace, "src/Node.md"));
  await fs.writeFile(path.join(workspace, "src/forced.tmp"), "changed ignored\n");
  assert.equal((await read()).observedVersion, baseline.observedVersion);
  await fs.writeFile(path.join(workspace, "src/binary.bin"), Buffer.from([0, 13, 10, 255]));
  await git(workspace, "add", "src/binary.bin");
  const binary = await read();
  await fs.writeFile(path.join(workspace, "src/binary.bin"), Buffer.from([0, 10, 255]));
  assert.notEqual((await read()).observedVersion, binary.observedVersion);
  const root = await observeMaterialResource(workspace, "index.md", "../");
  assert.ok(
    root.directoryFiles &&
      !root.directoryFiles.some((file) => file.path.split("/").includes(".git")),
  );
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
  const plain = await observeMaterialResource(workspace, "index.md", "../src/");
  const ignored = await observeMaterialResource(workspace, "index.md", "../cache/");
  assert.deepEqual(ignored.directoryFiles, []);
  await git(workspace, "init", "--quiet");
  const indexed = await observeMaterialResource(workspace, "index.md", "../src/");
  assert.deepEqual(indexed.directoryFiles, plain.directoryFiles);
  assert.equal(indexed.observedVersion, plain.observedVersion);
});

test("non-Git ignore authority excludes caller Git state and Tent excludes without writing its index or HEAD", async (t) => {
  const workspace = await fixture(t);
  const tent = path.join(workspace, ".tent"),
    gitDir = path.join(tent, ".git");
  await fs.writeFile(path.join(tent, "marker.txt"), "Tent index member\n");
  await git(tent, "add", "marker.txt");
  await fs.writeFile(path.join(gitDir, "info/exclude"), "src/**\n*.txt\n");
  const beforeIndex = await fs.readFile(path.join(gitDir, "index")),
    beforeHead = await fs.readFile(path.join(gitDir, "HEAD"));
  const beforeEntries = await fs.readdir(gitDir);
  const pollution = {
    GIT_DIR: path.join(workspace, "absent-git"),
    GIT_WORK_TREE: path.join(workspace, "absent-tree"),
    GIT_INDEX_FILE: path.join(gitDir, "index"),
    GIT_OPTIONAL_LOCKS: "1",
  };
  const previous = Object.fromEntries(Object.keys(pollution).map((key) => [key, process.env[key]]));
  let result;
  try {
    Object.assign(process.env, pollution);
    result = await new NodeFs(tent, "cli", "inspect").observeMaterial("../src/", "index.md");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(
    result!.directoryFiles!.map((file) => file.path),
    ["a.txt", "nested/b.txt"],
  );
  assert.deepEqual(await fs.readFile(path.join(gitDir, "index")), beforeIndex);
  assert.deepEqual(await fs.readFile(path.join(gitDir, "HEAD")), beforeHead);
  assert.deepEqual(
    (await fs.readdir(gitDir)).filter((name) => name !== "tent-material-cache"),
    beforeEntries,
  );
});

test("a Git traversal warning cannot become a successfully observed empty directory", async (t) => {
  const workspace = await fixture(t, true);
  const execute = childProcess.execFile;
  const warning = "warning: could not open directory 'src/': Permission denied\n";
  const mocked = t.mock.method(childProcess, "execFile", (...args: Parameters<typeof execute>) =>
    execute(args[0], args[1], args[2], (error, stdout, stderr) =>
      args[3]?.(error, stdout, args[1]?.includes("ls-files") ? Buffer.from(warning) : stderr),
    ),
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    observeMaterialResource(workspace, "index.md", "../src/"),
    /Permission denied/,
  );
});

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
  await assert.rejects(observeMaterialResource(workspace, "index.md", "../src/"), /Symbolic links/);
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
  const result = await runNodeCommand(
    "create",
    ["Invalid directory", "--type", "prompt", "--resource", ".tent/Main/Main.md/"],
    { cwd: workspace, json: true },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const checked = await runNodeCommand("check", [JSON.parse(result.stdout).node.nodeId], {
    cwd: workspace,
    json: true,
  });
  const material = JSON.parse(checked.stdout).materials[0];
  assert.equal(material.currentVersion, undefined);
  assert.match(material.reason, /not a directory|ENOTDIR/);
  assert.equal(isCardResponseSource("/cards/card-response.md/", "index.md"), false);
  const card = await createCardDocument(adapter, {
    prompt: "Directory declaration",
    sources: [{ resource: "/Main/Main.md/" }],
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
  const plain = await observeMaterialResource(workspace, "index.md", "../src/");
  await git(workspace, "init", "--quiet");
  const indexed = await observeMaterialResource(workspace, "index.md", "../src/");
  assert.deepEqual(indexed.directoryFiles, plain.directoryFiles);
  assert.equal(indexed.observedVersion, plain.observedVersion);
});

test("Git clean filters and ident expansion observe live bytes even when status is unchanged", async (t) => {
  const workspace = await fixture(t, true);
  await fs.writeFile(
    path.join(workspace, ".gitattributes"),
    "src/*.filter filter=ignore\nsrc/ident.txt ident\n",
  );
  await git(workspace, "config", "filter.ignore.clean", "echo constant");
  await fs.writeFile(path.join(workspace, "src/data.filter"), "actual bytes\n");
  await fs.writeFile(path.join(workspace, "src/ident.txt"), "$Id$\n");
  await git(workspace, "add", ".gitattributes", "src");
  await git(workspace, "commit", "--quiet", "-m", "test: attributes");
  await fs.unlink(path.join(workspace, "src/ident.txt"));
  await git(workspace, "checkout", "--", "src/ident.txt");
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  const read = () => adapter.observeMaterial("../src/", "index.md");
  const baseline = await read();
  const rawIdent = await fs.readFile(path.join(workspace, "src/ident.txt"), "utf8");
  assert.match(rawIdent, /\$Id: [a-f0-9]+ \$/);
  await fs.writeFile(path.join(workspace, "src/data.filter"), "new actual bytes\n");
  assert.equal((await git(workspace, "diff", "--name-only")).trim(), "");
  assert.notEqual((await read()).observedVersion, baseline.observedVersion);
  await fs.writeFile(path.join(workspace, "src/data.filter"), "actual bytes\n");
  assert.equal((await read()).observedVersion, baseline.observedVersion);
  await fs.writeFile(path.join(workspace, "src/ident.txt"), "$Id: replaced $\n");
  assert.equal((await git(workspace, "diff", "--name-only")).trim(), "");
  assert.notEqual((await read()).observedVersion, baseline.observedVersion);
});

test("Git object reuse skips unchanged live reads and still sees assume-unchanged and encoded files", async (t) => {
  const workspace = await fixture(t, true);
  const root = path.join(workspace, ".tent");
  await fs.mkdir(root, { recursive: true });
  await git(root, "init", "--quiet");
  const read = () => new NodeFs(root, "cli", "inspect").observeMaterial("../src/", "index.md");
  const baseline = await read();
  const original = fs.open,
    opened: string[] = [];
  const mocked = t.mock.method(fs, "open", (...args: Parameters<typeof original>) => {
    opened.push(String(args[0]));
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const cached = await read();
  assert.equal(cached.observedVersion, baseline.observedVersion);
  assert.equal(cached.cacheHit, true);
  assert.equal(opened.length, 0);
  await git(workspace, "update-index", "--assume-unchanged", "src/a.txt");
  await fs.writeFile(path.join(workspace, "src/a.txt"), "changed while assumed unchanged\n");
  assert.notEqual((await read()).observedVersion, baseline.observedVersion);
  assert.ok(opened.some((filename) => filename.endsWith(path.join("src", "a.txt"))));
  await fs.writeFile(
    path.join(workspace, ".gitattributes"),
    "src/encoded.txt working-tree-encoding=UTF-16\n",
  );
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from("encoded\n", "utf16le")]);
  await fs.writeFile(path.join(workspace, "src/encoded.txt"), bytes);
  await git(workspace, "add", ".gitattributes", "src/encoded.txt");
  const encoded = await read();
  assert.equal(
    encoded.directoryFiles!.find((file) => file.path === "encoded.txt")!.version,
    createHash("sha256").update(bytes).digest("hex"),
  );
});

async function directoryAuthority(workspace: string) {
  const files: Array<{ path: string; hash: string }> = [];
  const cacheDir = path.join(workspace, ".tent/.git/tent-material-cache");
  async function walk(folder: string) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (filename === cacheDir) continue;
      if (
        folder === path.join(workspace, ".tent/.git") &&
        (entry.name === "tent-history-index.json" || /^tent-derived-.*\.json$/.test(entry.name))
      )
        continue;
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile())
        files.push({
          path: path.relative(workspace, filename),
          hash: createHash("sha256")
            .update(await fs.readFile(filename))
            .digest("hex"),
        });
    }
  }
  await walk(workspace);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

test("mtime-only and changed file observation never execute a writing Git clean filter", async (t) => {
  const workspace = await fixture(t, true);
  const helper = path.join(workspace, "identity-filter.cjs");
  const marker = path.join(workspace, "filter-ran.txt");
  await fs.writeFile(
    helper,
    "require('node:fs').appendFileSync('filter-ran.txt','called\\n');process.stdin.pipe(process.stdout);\n",
  );
  await fs.appendFile(path.join(workspace, ".gitignore"), "filter-ran.txt\n");
  await fs.writeFile(path.join(workspace, ".gitattributes"), "src/*.txt filter=identity\n");
  await git(workspace, "config", "filter.identity.clean", `node "${helper.replaceAll("\\", "/")}"`);
  await git(workspace, "add", ".");
  await git(workspace, "add", "--renormalize", "src");
  await git(workspace, "commit", "--quiet", "-m", "test: writing filter");
  await fs.unlink(marker);
  const file = path.join(workspace, "src/a.txt");
  await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
  const read = () => observeResource(workspace, "index.md", "../src/");
  for (const bytes of [undefined, "changed live bytes\r\n"]) {
    if (bytes) await fs.writeFile(file, bytes);
    const before = await directoryAuthority(workspace);
    const observed = await read();
    assert.equal(
      observed.directoryFiles!.find((member) => member.path === "a.txt")!.version,
      createHash("sha256")
        .update((await fs.readFile(file, "utf8")).replace(/\r\n?/g, "\n"))
        .digest("hex"),
    );
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    assert.deepEqual(await directoryAuthority(workspace), before);
  }
});

test("index stat permits cold Git object reuse without reading unchanged working bytes", async (t) => {
  const workspace = await fixture(t, true);
  const file = path.join(workspace, "src/a.txt");
  const initial = await fs.stat(file);
  const open = fs.open;
  const opened: string[] = [];
  const mocked = t.mock.method(fs, "open", (...args: Parameters<typeof open>) => {
    opened.push(String(args[0]));
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const observed = await observeResource(workspace, "index.md", "../src/");
  assert.equal(observed.directoryFiles!.length, 2);
  assert.equal(opened.length, 0);
  assert.equal(
    observed.directoryFiles![0]!.version,
    createHash("sha256").update("first\n").digest("hex"),
  );
  await fs.writeFile(file, "other\n");
  await fs.utimes(file, initial.atime, initial.mtime);
  const edited = await observeResource(workspace, "index.md", "../src/");
  assert.equal(
    edited.directoryFiles![0]!.version,
    createHash("sha256").update("other\n").digest("hex"),
  );
  assert.ok(opened.includes(file));
});

test("promisor missing blobs use working bytes without fetching and unreadable or racing members are unavailable", async (t) => {
  const origin = await fixture(t, true);
  const target = path.join(origin, "target");
  await git(origin, "clone", "--quiet", "--no-hardlinks", origin, target);
  await git(target, "config", "remote.origin.promisor", "true");
  await git(target, "config", "remote.origin.partialclonefilter", "blob:none");
  // Any attempted upload-pack would create a marker even if it ultimately fails.
  const upload = path.join(origin, "upload-pack.cjs");
  const marker = path.join(target, "fetch-ran.txt");
  await fs.writeFile(
    upload,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'fetch');process.exit(1);\n`,
  );
  await git(target, "config", "remote.origin.uploadpack", `node "${upload.replaceAll("\\", "/")}"`);
  const blob = (await git(target, "rev-parse", "HEAD:src/a.txt")).trim();
  await scaffoldInWorkspace(new NodeFs(target), { name: "Partial" });
  const tent = path.join(target, ".tent");
  await git(tent, "init", "--quiet");
  const globals = { cwd: target, json: true };
  const created = await runNodeCommand(
    "create",
    ["Partial", "--type", "goal", "--resource", "src/"],
    globals,
  );
  assert.equal(created.exitCode, 0, created.stderr);
  const id = JSON.parse(created.stdout).node.nodeId;
  await fs.unlink(path.join(target, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  const cacheDir = path.join(tent, ".git/tent-material-cache");
  await fs.rm(cacheDir, { recursive: true, force: true });
  const before = await directoryAuthority(target);
  const read = () => observeResource(target, "index.md", "../src/");
  const observed = await read();
  assert.equal(
    observed.directoryFiles![0]!.version,
    createHash("sha256").update("first\n").digest("hex"),
  );
  assert.deepEqual(await directoryAuthority(target), before);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  const file = path.join(target, "src/a.txt");
  const open = fs.open;
  const unavailable = async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    const check = await runNodeCommand("check", [id], globals);
    assert.equal(check.exitCode, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).materials[0].state, "unavailable");
  };
  const denied = t.mock.method(fs, "open", (...args: Parameters<typeof open>) =>
    String(args[0]) === file
      ? Promise.reject(
          Object.assign(new Error("Unreadable live partial-clone member"), { code: "EACCES" }),
        )
      : open(...args),
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(read, { code: "EACCES" });
    await unavailable();
    assert.deepEqual(await directoryAuthority(target), before);
  } finally {
    denied.mock.restore();
    syncBuiltinESMExports();
  }
  let mutation = 0;
  const racing = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === file)
      await fs.utimes(file, new Date(), new Date(Date.now() + 20_000 + mutation++ * 1000));
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await unavailable();
  } finally {
    racing.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  await fs.unlink(file);
  const deleted = await read();
  assert.deepEqual(
    deleted.directoryFiles!.map((member) => member.path),
    ["nested/b.txt"],
  );
  const check = await runNodeCommand("check", [id], globals);
  assert.equal(check.exitCode, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout).materials[0].changedFiles, [
    { path: "a.txt", state: "deleted" },
  ]);
});

test("nested Git directories contribute their files without control metadata", async (t) => {
  const workspace = await fixture(t, true);
  await fs.mkdir(path.join(workspace, "src/repository"));
  await git(path.join(workspace, "src/repository"), "init", "--quiet");
  await fs.writeFile(path.join(workspace, "src/repository/file.txt"), "nested\n");
  await fs.writeFile(path.join(workspace, "src/repository/.gitignore"), "*.ignored\n");
  await fs.writeFile(path.join(workspace, "src/repository/noise.ignored"), "ignored\n");
  const adapter = new NodeFs(path.join(workspace, ".tent"));
  const result = await adapter.observeMaterial("../src/", "index.md");
  assert.deepEqual(
    result.directoryFiles!.map((file) => file.path),
    ["a.txt", "nested/b.txt", "repository/.gitignore", "repository/file.txt"],
  );
  const nested = path.join(workspace, "src/repository");
  await git(nested, "add", ".");
  await git(nested, "commit", "--quiet", "-m", "test: nested repository");
  await git(workspace, "add", "src/repository");
  assert.equal(
    (await adapter.observeMaterial("../src/", "index.md")).observedVersion,
    result.observedVersion,
  );
  const metadata = path.join(nested, ".git");
  assert.equal(path.dirname(metadata), nested);
  await fs.rm(metadata, { recursive: true });
  assert.equal(
    (await adapter.observeMaterial("../src/", "index.md")).observedVersion,
    result.observedVersion,
  );
});

test("Git index types never replace the live file and directory types", async (t) => {
  const workspace = await fixture(t, true);
  const read = () => observeMaterialResource(workspace, "index.md", "../src/");
  await fs.writeFile(path.join(workspace, "src/index-link.txt"), "nested/b.txt\n");
  const oid = await git(workspace, "hash-object", "-w", "src/index-link.txt");
  await git(
    workspace,
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${oid.trim()},src/index-link.txt`,
  );
  assert.ok((await read()).directoryFiles!.some((file) => file.path === "index-link.txt"));
  await fs.unlink(path.join(workspace, "src/index-link.txt"));
  assert.ok(!(await read()).directoryFiles!.some((file) => file.path === "index-link.txt"));
  await fs.unlink(path.join(workspace, "src/a.txt"));
  await fs.mkdir(path.join(workspace, "src/a.txt"));
  await fs.writeFile(path.join(workspace, "src/a.txt/replacement.txt"), "replacement\n");
  assert.deepEqual(
    (await read()).directoryFiles!.map((file) => file.path),
    ["a.txt/replacement.txt", "nested/b.txt"],
  );
  assert.deepEqual(
    (await observeMaterialResource(workspace, "index.md", "../src/a.txt/")).directoryFiles!.map(
      (file) => file.path,
    ),
    ["replacement.txt"],
  );
  await fs.rename(
    path.join(workspace, "src/nested/b.txt"),
    path.join(workspace, "src/nested/B.txt"),
  );
  await fs.rename(path.join(workspace, "src/nested"), path.join(workspace, "src/Nested"));
  assert.deepEqual(
    (await read()).directoryFiles!.map((file) => file.path),
    ["Nested/B.txt", "a.txt/replacement.txt"],
  );
});

test("non-Git working manifests survive fresh adapters and rebuild after signature changes or corrupt cache", async (t) => {
  const workspace = await fixture(t);
  const root = path.join(workspace, ".tent");
  await fs.mkdir(root, { recursive: true });
  await git(root, "init", "--quiet");
  const read = () => new NodeFs(root, "cli", "inspect").observeMaterial("../src/", "index.md");
  const original = await read();
  const open = fs.open,
    opened: string[] = [];
  const mocked = t.mock.method(fs, "open", (...args: Parameters<typeof open>) => {
    opened.push(String(args[0]));
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  assert.equal((await read()).observedVersion, original.observedVersion);
  assert.equal(opened.length, 0);
  await fs.writeFile(path.join(workspace, "src/a.txt"), "first\r\n");
  assert.equal((await read()).observedVersion, original.observedVersion);
  assert.ok(opened.length > 0);
  await fs.writeFile(
    path.join(root, ".git/tent-material-cache/directory-working.json"),
    "malformed json",
  );
  await fs.writeFile(path.join(workspace, "src/a.txt"), "new content\n");
  const changed = await read();
  assert.notEqual(changed.observedVersion, original.observedVersion);
  await fs.unlink(path.join(root, ".git/tent-material-cache/directory-working.json"));
  assert.equal((await read()).observedVersion, changed.observedVersion);
  await fs.rename(
    path.join(workspace, "src/nested/b.txt"),
    path.join(workspace, "src/nested/c.txt"),
  );
  assert.notEqual((await read()).observedVersion, changed.observedVersion);
  await fs.unlink(path.join(workspace, "src/nested/c.txt"));
  const removed = await read();
  assert.deepEqual(
    removed.directoryFiles!.map((file) => file.path),
    ["a.txt"],
  );
});

test("CLI directory resource and sources retain baseline and report at most twenty changed files", async (t) => {
  const workspace = await fixture(t, true);
  await scaffoldInWorkspace(new NodeFs(workspace), { name: "Directory" });
  const root = path.join(workspace, ".tent"),
    adapter = new NodeFs(root);
  await git(root, "init", "--quiet");
  const globals = { cwd: path.join(workspace, "src/nested"), json: true };
  const run = async (sub: string, args: string[]) => {
    const result = await runNodeCommand(sub, args, globals);
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const node = (
    await run("create", [
      "Module",
      "--type",
      "goal",
      "--resource",
      "src/",
      "--sources-json",
      JSON.stringify([{ resource: "src/" }]),
    ])
  ).node;
  const read = await readNodeForEdit(adapter, node.nodeId);
  assert.equal(read.frontmatter.resource, "../../src/");
  assert.deepEqual(read.frontmatter.sources, [{ resource: "../../src/" }]);
  assert.equal((await run("check", [node.nodeId])).state, "ahead");
  const output = await run("link-output", [node.nodeId, "--resource", "src/a.txt"]);
  assert.equal((await run("check", [node.nodeId])).state, "synced");
  await fs.rename(
    path.join(workspace, "src/nested/b.txt"),
    path.join(workspace, "src/nested/c.txt"),
  );
  await fs.writeFile(path.join(workspace, "src/a.txt"), "changed\n");
  let check = await run("check", [node.nodeId]);
  for (const material of check.materials)
    assert.deepEqual(material.changedFiles, [
      { path: "a.txt", state: "modified" },
      { path: "nested/b.txt", state: "deleted" },
      { path: "nested/c.txt", state: "added" },
    ]);
  const outputCheck = await run("check", [output.nodeId]);
  assert.equal(outputCheck.state, "behind");
  assert.deepEqual(
    outputCheck.materials.find(
      (material: { goalId?: string; changedFiles?: unknown }) =>
        material.goalId === node.nodeId && material.changedFiles,
    )?.changedFiles,
    check.materials[0].changedFiles,
  );
  for (let index = 0; index < 25; index++)
    await fs.writeFile(
      path.join(workspace, `src/new-${String(index).padStart(2, "0")}.txt`),
      "new\n",
    );
  check = await run("check", [node.nodeId]);
  assert.equal(check.state, "behind");
  for (const material of check.materials) {
    assert.equal(material.changedFiles.length, 20);
    assert.equal(material.changedFilesOverflow, 8);
  }
  await writeNodeDocument(adapter, node.nodeId, {
    baseEtag: read.etag,
    body: "Updated description\n",
  });
  assert.equal((await run("check", [node.nodeId])).state, "behind");
  const current = await readNodeForEdit(adapter, node.nodeId);
  await run("confirm", [node.nodeId, "--base-etag", current.etag]);
  check = await run("check", [node.nodeId]);
  assert.equal(check.state, "ahead");
  assert.ok(check.materials.every((material: { state: string }) => material.state === "current"));
  assert.ok(
    check.materials.every(
      (material: { changedFiles?: unknown }) => material.changedFiles === undefined,
    ),
  );
  const retainedOutput = await run("check", [output.nodeId]);
  assert.equal(retainedOutput.state, "behind");
  assert.equal(
    retainedOutput.materials.find(
      (material: { changedFilesOverflow?: number }) => material.changedFilesOverflow,
    )?.changedFilesOverflow,
    8,
  );
  await run("confirm", [
    output.nodeId,
    "--base-etag",
    (await readNodeForEdit(adapter, output.nodeId)).etag,
  ]);
  assert.equal((await run("check", [output.nodeId])).state, "synced");
  assert.equal((await run("check", [node.nodeId])).state, "synced");
  const graph = await checkGraph(adapter, workspace, async (filename, directory) =>
    fs
      .stat(filename)
      .then((info) => (directory ? info.isDirectory() : info.isFile()))
      .catch(() => false),
  );
  assert.deepEqual(graph.issues, []);
  const workspaceCheck = await runWorkspaceCommand("check", [], globals);
  assert.equal(workspaceCheck.exitCode, 0, workspaceCheck.stderr);
  assert.deepEqual(JSON.parse(workspaceCheck.stdout).issues, []);
  await adapter.writeFile(
    "Bare/Bare.md",
    serializeFrontmatter(
      { id: "node-bare", type: "prompt", sources: [{ resource: "src/" }] },
      "Bare directory source\n",
    ),
  );
  const bareCheck = await runWorkspaceCommand("check", [], globals);
  const bareIssue = JSON.parse(bareCheck.stdout).issues.find(
    (issue: { kind: string }) => issue.kind === "unanchored-material-file",
  );
  assert.equal(bareIssue.kind, "unanchored-material-file");
  assert.equal(bareIssue.suggestion, "../../src/");
  assert.match(bareIssue.reason, /existing directory/);
  await fs.rm(path.join(workspace, "src"), { recursive: true });
  assert.equal((await run("check", [node.nodeId])).materials[0].state, "unavailable");
});
