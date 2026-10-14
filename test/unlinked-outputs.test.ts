import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import type { FsAdapter } from "../src/core/adapter.js";
import {
  findUnlinkedOutputs,
  inspectCurrentContext,
  type WorkspaceSync,
} from "../src/core/context-brief.js";
import { indexedMaterialCovers } from "../src/core/unlinked-outputs.js";
import type { StopMaterialIndex } from "../src/core/stop-material-index.js";
import type { SessionObservationEvent } from "../src/core/session-observations.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { git } from "./helpers.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadNodeCatalog } from "../src/core/node-catalog.js";
import { buildStopMaterialIndex } from "../src/core/stop-material-index.js";
import {
  sessionObservationEventSchema,
  sessionObservationPath,
} from "../src/core/session-observations.js";

const event = (addresses: string[]): SessionObservationEvent => ({
  schema: 1,
  type: "turn",
  sessionId: "session",
  turnId: "turn",
  observedAt: "2026-10-11T00:00:00Z",
  files: addresses.map((address) => ({
    kind: "written",
    address,
    version: { state: "uncertain", observedAt: "2026-10-11T00:00:00Z", phase: "stop" },
  })),
  signals: [],
  uncertain: false,
});
const sync: WorkspaceSync = {
  invalidNodes: [],
  nodes: [],
  outputNodes: [],
  requirementsWithoutOutputs: [],
  counts: { synced: 0, ahead: 0, behind: 0, unanchored: 0 },
};
const index: StopMaterialIndex = {
  nodes: [
    {
      nodeId: "node-evidence",
      path: ".tent/Evidence/Evidence.md",
      names: ["Evidence"],
      materials: [{ file: "ordinary.md" }, { file: "basis.md" }],
      moduleCoverage: [],
    },
    {
      nodeId: "node-output",
      path: ".tent/Output/Output.md",
      names: ["Output"],
      type: "output",
      materials: [{ file: "result.svg" }],
      moduleCoverage: [],
    },
    {
      nodeId: "node-module",
      path: ".tent/Module/Module.md",
      names: ["Module"],
      materials: [{ coverage: { kind: "directory", prefix: "src/" } }],
      moduleCoverage: [{ kind: "directory", prefix: "src/" }],
    },
  ],
};

test("brief uses ordinary, module and output coverage before one ignore batch", async () => {
  const calls: string[][] = [];
  const adapter = {
    nonignoredFiles: async (addresses: readonly string[]) => {
      calls.push([...addresses]);
      return addresses.filter((address) => address !== "ignored.svg");
    },
  } as FsAdapter;
  const turn = event([
    "ordinary.md",
    "basis.md",
    "src/code.ts",
    "result.svg",
    "ignored.svg",
    "loose.svg",
    "other.svg",
    "loose.svg",
  ]);
  const outputs = await findUnlinkedOutputs(sync, [turn], process.cwd(), index, adapter);
  assert.deepEqual(
    outputs.map((file) => file.address),
    ["loose.svg", "other.svg"],
  );
  assert.deepEqual(calls, [["ignored.svg", "loose.svg", "other.svg"]]);
});

test("brief covered writes need no ignore lookup", async () => {
  const adapter = {
    nonignoredFiles: async () => {
      throw new Error("covered files must not query ignore");
    },
  } as unknown as FsAdapter;
  const turn = event(["ordinary.md", "src/ignored-and-unavailable.ts", "result.svg"]);
  assert.deepEqual(await findUnlinkedOutputs(sync, [turn], process.cwd(), index, adapter), []);
});

test("brief excludes internal files before ignore lookup, including URI aliases and stale index entries", async () => {
  const root = process.cwd();
  const internal = ".tent/attachments/result.svg";
  const uri = pathToFileURL(path.join(root, internal)).href;
  const adapter = {
    nonignoredFiles: async () => {
      throw new Error("internal files are outside the output domain");
    },
  } as unknown as FsAdapter;
  const stale = { nodes: [{ ...index.nodes[0]!, materials: [{ file: internal }] }] };
  assert.equal(indexedMaterialCovers(stale, internal, root), false);
  assert.equal(indexedMaterialCovers(stale, uri, root), false);
  assert.deepEqual(
    await findUnlinkedOutputs(sync, [event([internal, uri])], root, stale, adapter),
    [],
  );
});

async function uriFixture(t: TestContext) {
  const scratch = path.resolve(".scratch/brief-uri-fix");
  await fs.mkdir(scratch, { recursive: true });
  const folder = await fs.mkdtemp(path.join(scratch, "fixture-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const root = path.join(folder, "workspace");
  await fs.mkdir(root);
  await scaffoldInWorkspace(new NodeFs(root), { name: "URI aliases" });
  return { folder, root, adapter: new NodeFs(path.join(root, ".tent")) };
}

test("brief treats Workspace file URI aliases as covered in the complete observation-log context", async (t) => {
  const { root, adapter } = await uriFixture(t);
  await git(root, "init", "--quiet");
  for (const [name, fields] of [
    ["Output", "type: output\nresource: ../../out file.svg\n"],
    ["Section", "type: prompt\nsources:\n  - resource: ../../basis.md#State\n"],
    ["Directory", "type: prompt\nsources:\n  - resource: ../../src/\n    track: structure\n"],
    ["Prefix", "type: prompt\nsources:\n  - resource: ../../asset-*\n    track: structure\n"],
  ]) {
    await adapter.mkdir(name!);
    await adapter.writeFile(
      `${name}/${name}.md`,
      `---\nid: node-${name!.toLowerCase()}\nstatus: stable\n${fields}---\nEvidence\n`,
    );
  }
  await fs.mkdir(path.join(root, "src"));
  const addresses = ["out file.svg", "basis.md", "src/a.ts", "asset-one.svg"];
  for (const filename of [...addresses, "loose.svg"])
    await fs.writeFile(
      path.join(root, filename),
      filename === "basis.md" ? "# State\nBasis\n" : "written",
    );
  const current = buildStopMaterialIndex(await loadNodeCatalog(adapter), root);
  const coveredOnly = {
    nonignoredFiles: async () => {
      throw new Error("covered URI aliases must not query ignore");
    },
  } as unknown as FsAdapter;
  const uris = addresses.map((filename) => pathToFileURL(path.join(root, filename)).href);
  assert.deepEqual(
    await findUnlinkedOutputs(sync, [event(addresses)], root, current, coveredOnly),
    [],
  );
  assert.deepEqual(await findUnlinkedOutputs(sync, [event(uris)], root, current, coveredOnly), []);
  const loose = pathToFileURL(path.join(root, "loose.svg")).href;
  const calls: string[][] = [];
  const nonignored = adapter.nonignoredFiles.bind(adapter);
  t.mock.method(adapter, "nonignoredFiles", async (items: readonly string[]) => {
    calls.push([...items]);
    return nonignored(items);
  });
  const observed = sessionObservationEventSchema.parse(event([...uris, loose, "loose.svg"]));
  const log = path.join(root, ".tent", sessionObservationPath(observed.sessionId));
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, JSON.stringify(observed) + "\n");
  const context = await inspectCurrentContext(adapter, root);
  assert.deepEqual(
    context.unlinkedOutputs.map((file) => file.address),
    [loose],
  );
  assert.deepEqual(calls, [[loose, "loose.svg"]], "only uncovered writes enter the ignore batch");
  assert.deepEqual(
    context.observations.events[0]!.files.map((file) => file.address),
    observed.files.map((file) => file.address),
  );
});

test("brief URI normalization preserves external file, section, directory and prefix scopes", async (t) => {
  const { folder, root, adapter } = await uriFixture(t);
  const external = path.join(folder, "external");
  const uri = (filename: string) => pathToFileURL(path.join(external, filename)).href;
  for (const [name, resource] of [
    ["File", uri("out file.svg")],
    ["Section", uri("basis.md") + "#State"],
    ["Directory", uri("src") + "/"],
    ["Prefix", uri("asset-*")],
  ]) {
    await adapter.mkdir(name!);
    await adapter.writeFile(
      `${name}/${name}.md`,
      `---\nid: node-${name!.toLowerCase()}\ntype: prompt\nstatus: stable\nsources:\n  - resource: ${JSON.stringify(resource)}\n---\nEvidence\n`,
    );
  }
  const current = buildStopMaterialIndex(await loadNodeCatalog(adapter), root);
  for (const filename of ["out file.svg", "basis.md", "src/a.ts", "asset-one.svg"]) {
    assert.equal(indexedMaterialCovers(current, uri(filename), root), true, filename);
    assert.equal(
      indexedMaterialCovers(current, filename, root),
      false,
      "external scope cannot cover an internal relative path",
    );
    assert.equal(
      indexedMaterialCovers(current, pathToFileURL(path.join(root, filename)).href, root),
      false,
      "external scope cannot cover an internal URI alias",
    );
    assert.equal(
      indexedMaterialCovers(
        current,
        pathToFileURL(path.join(folder, "external-other", filename)).href,
        root,
      ),
      false,
      "adjacent external paths are outside the declared scope",
    );
  }
  assert.equal(indexedMaterialCovers(current, uri("src-other/a.ts"), root), false);
  assert.equal(indexedMaterialCovers(current, uri("other-asset.svg"), root), false);
});

test("only current usable output materials suppress brief findings", async (t) => {
  const { root, adapter } = await fixture(t, true);
  for (const [name, status] of [
    ["Live", "stable"],
    ["Draft", "draft"],
    ["Old", "deprecated"],
    ["Unknown", "mystery"],
    ["Invalid", "stable"],
  ]) {
    await adapter.mkdir(name!);
    await adapter.writeFile(
      `${name}/${name}.md`,
      `---\nid: ${name === "Invalid" ? "bad-id" : `node-${name!.toLowerCase()}`}\ntype: output\nstatus: ${status}\nresource: ../../${name!.toLowerCase()}.svg\n---\nEvidence\n`,
    );
  }
  const catalog = await loadNodeCatalog(adapter);
  const current = buildStopMaterialIndex(catalog, root);
  assert.deepEqual(
    new Set(current.nodes.map((node) => node.nodeId)),
    new Set(["node-live", "node-draft"]),
  );
  assert.equal(catalog.tree.byId.get("node-old")!.archived, true);
  assert.equal(catalog.tree.byId.get("node-unknown")!.status, null);
  assert.equal(catalog.tree.byPath.get("Invalid")!.invalid, true);
  // Old sync projections must not add their own output-resource exclusion.
  const withOldOutputs = {
    ...sync,
    outputNodes: [
      { nodeId: "node-old", path: "Old", resource: "../../old.svg" },
      { nodeId: "node-unknown", path: "Unknown", resource: "../../unknown.svg" },
    ],
  };
  for (const filename of ["live.svg", "draft.svg", "old.svg", "unknown.svg", "invalid.svg"]) {
    await fs.writeFile(path.join(root, filename), "written");
    const turn = event([filename]);
    const expected = ["live.svg", "draft.svg"].includes(filename) ? [] : [filename];
    assert.deepEqual(
      (await findUnlinkedOutputs(withOldOutputs, [turn], root, current, adapter)).map(
        (file) => file.address,
      ),
      expected,
    );
  }
});

async function fixture(t: TestContext, projectGit: boolean) {
  const scratch = path.resolve(".scratch/stop-unlinked-definition");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "ignore-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "ignore" });
  if (projectGit) await git(root, "init", "--quiet");
  else {
    const original = fs.lstat;
    const mocked = t.mock.method(fs, "lstat", (...args: Parameters<typeof original>) => {
      const filename = String(args[0]);
      if (path.basename(filename) === ".git" && !filename.startsWith(root + path.sep))
        return Promise.reject(
          Object.assign(new Error("No ancestor Git in fixture"), { code: "ENOENT" }),
        );
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
  }
  return { root, adapter: new NodeFs(path.join(root, ".tent")) };
}

function countIgnoreCommands(t: TestContext) {
  const commands: string[][] = [];
  const original = childProcess.execFile;
  const mocked = t.mock.method(childProcess, "execFile", (...args: Parameters<typeof original>) => {
    if (
      (args[1] as string[]).includes("check-ignore") ||
      (args[1] as string[]).includes("--exclude-per-directory=.gitignore")
    )
      commands.push(args[1] as string[]);
    return Reflect.apply(original, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return commands;
}

test("project ignore batches honor .gitignore, nested negation, info/exclude and tracked ignores", async (t) => {
  const { root, adapter } = await fixture(t, true);
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, ".gitignore"), "*.tmp\ntracked.txt\n");
  await fs.writeFile(path.join(root, "nested/.gitignore"), "!keep.tmp\n");
  await fs.writeFile(path.join(root, ".git/info/exclude"), "excluded.svg\n");
  await fs.writeFile(path.join(root, "tracked.txt"), "tracked");
  await git(root, "add", "-f", "tracked.txt");
  const commands = countIgnoreCommands(t);
  const inputs = [
    "ignored.tmp",
    "nested/keep.tmp",
    "excluded.svg",
    "tracked.txt",
    "loose.svg",
    ...(process.platform === "win32" ? [] : ["line\nbreak.svg"]),
  ];
  for (const filename of inputs) await fs.writeFile(path.join(root, filename), "written");
  assert.deepEqual(await adapter.nonignoredFiles(inputs), [
    "nested/keep.tmp",
    "loose.svg",
    ...(process.platform === "win32" ? [] : ["line\nbreak.svg"]),
  ]);
  assert.equal(commands.length, 1);
  assert.ok(commands[0]!.includes("--no-index"));
  assert.deepEqual(
    await adapter.nonignoredFiles(["loose.svg"]),
    ["loose.svg"],
    "exit 1 with all non-matches is successful",
  );
  assert.equal(commands.length, 2);
});

test("non-Git borrowing uses Workspace rules without Tent private or global exclusions", async (t) => {
  const { root, adapter } = await fixture(t, false);
  const tent = path.join(root, ".tent");
  await git(tent, "init", "--quiet");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.svg\n!keep.svg\n");
  for (const filename of ["ignored.svg", "private.svg", "global.svg", "keep.svg", "loose.svg"])
    await fs.writeFile(path.join(root, filename), "written");
  await fs.writeFile(path.join(tent, ".git/info/exclude"), "private.svg\nkeep.svg\n");
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested/.gitignore"), "*.svg\n");
  await fs.writeFile(path.join(root, "nested/ignored.svg"), "ignored");
  await fs.appendFile(path.join(tent, ".git/info/exclude"), "nested/\n");
  const global = path.join(root, "global-excludes");
  await fs.writeFile(global, "global.svg\n");
  await git(tent, "config", "core.excludesFile", global);
  const beforeHead = await fs.readFile(path.join(tent, ".git/HEAD"), "utf8");
  const commands = countIgnoreCommands(t);
  assert.deepEqual(
    await adapter.nonignoredFiles([
      "ignored.svg",
      "private.svg",
      "global.svg",
      "keep.svg",
      "loose.svg",
    ]),
    ["private.svg", "global.svg", "keep.svg", "loose.svg"],
  );
  assert.equal(commands.length, 1);
  assert.equal(await fs.readFile(path.join(tent, ".git/HEAD"), "utf8"), beforeHead);
  assert.equal(await fs.stat(path.join(tent, ".git/index")).catch(() => undefined), undefined);
  assert.deepEqual(
    await adapter.nonignoredFiles([pathToFileURL(path.resolve(root, "../external.svg")).href]),
    [],
  );
  assert.equal(commands.length, 1, "external paths outside interpreter authority are not queried");
  assert.deepEqual(
    await adapter.nonignoredFiles(["nested/ignored.svg"]),
    [],
    "Tent info/exclude cannot hide a nested Workspace ignore rule",
  );
  assert.deepEqual(
    await adapter.nonignoredFiles(["deleted.svg"]),
    [],
    "missing files are not unlinked outputs",
  );
});

for (const projectGit of [true, false]) {
  test(`deleted writes are quiet in brief (${projectGit ? "project" : "borrowed Tent"} Git)`, async (t) => {
    const { root, adapter } = await fixture(t, projectGit);
    if (!projectGit) await git(path.join(root, ".tent"), "init", "--quiet");
    const filename = path.join(root, "deleted.svg");
    await fs.writeFile(filename, "written");
    const turn = event([pathToFileURL(filename).href]);
    const current: StopMaterialIndex = { nodes: [] };
    assert.equal((await findUnlinkedOutputs(sync, [turn], root, current, adapter)).length, 1);
    await fs.unlink(filename);
    const commands = countIgnoreCommands(t);
    assert.deepEqual(await findUnlinkedOutputs(sync, [turn], root, current, adapter), []);
    assert.equal(commands.length, 0, "deleted files need no ignore lookup");
    await fs.writeFile(path.join(root, "kept.svg"), "written");
    const mixed = event(["deleted.svg", "kept.svg"]);
    assert.deepEqual(await adapter.nonignoredFiles(mixed.files.map((file) => file.address)), [
      "kept.svg",
    ]);
    assert.equal(commands.length, 1, "remaining files share one ignore batch");
  });
}

test("brief unlinked writes are quiet without a trusted ignore interpreter", async (t) => {
  const { root, adapter } = await fixture(t, false);
  await fs.writeFile(path.join(root, "loose.svg"), "written");
  const commands = countIgnoreCommands(t);
  const turn = event(["loose.svg", "src/code.ts"]);
  assert.deepEqual(await adapter.nonignoredFiles(["loose.svg"]), undefined);
  assert.deepEqual(await findUnlinkedOutputs(sync, [turn], root, index, adapter), []);
  assert.equal(commands.length, 0);
  assert.deepEqual(await findUnlinkedOutputs(sync, [turn], root, index, {} as FsAdapter), []);
  await fs.mkdir(path.join(root, ".git"));
  assert.equal(
    await adapter.nonignoredFiles(["loose.svg"]),
    undefined,
    "broken interpreter is never guessed into nonignored files",
  );
});
