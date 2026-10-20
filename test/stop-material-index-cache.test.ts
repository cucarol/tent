import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { fileState } from "../src/fs/file-state-cache.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { sameStopMaterialHeader } from "../src/core/return/stop-material-index.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "stop-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"), { recursive: true });
  await fs.writeFile(path.join(systemRoot, "index.md"), '---\nokf_version: "0.2"\n---\n');
  const node = async (directory: string, id: string) => {
    await fs.mkdir(path.join(systemRoot, directory), { recursive: true });
    await fs.writeFile(
      path.join(systemRoot, directory, `${path.posix.basename(directory)}.md`),
      `---\nid: ${id}\ntype: goal\n---\nBody\n`,
    );
  };
  await node("A", "node-a");
  await node("A/Child", "node-child");
  return {
    root,
    systemRoot,
    node,
    cacheFile: path.join(systemRoot, ".git", "tent-material-cache", "stop-material-index.json"),
  };
}

function stableClock(t: TestContext) {
  // Make the observation later than the filesystem's one-second safety window
  // without adding real sleeps to the test suite.
  const now = Date.now() + 10_000;
  t.mock.method(Date, "now", () => now);
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("Stop header equivalence ignores provenance but preserves identity, validity and coverage changes", () => {
  const original = "---\nid: node-a\ntype: goal\ngenerated: {at: old}\n---\n";
  assert.equal(sameStopMaterialHeader(original, original.replace("old", "new")), true);
  for (const replacement of [
    original.replace("node-a", "node-b"),
    original.replace("goal", "output"),
    original.replace("goal", "null"),
    original.replace("type: goal", "type: goal\nstatus: deprecated"),
    original.replace("type: goal", "type: goal\nstale_after: invalid"),
    original.replace("type: goal", "type: goal\nsources: [{resource: ../src/, track: structure}]"),
    original.replace("generated: {at: old}", "generated: {at:"),
  ])
    assert.equal(sameStopMaterialHeader(original, replacement), false);
});

test("Stop updates a generated-only header record while retaining the same projection", async (t) => {
  const { root, systemRoot, cacheFile } = await fixture(t);
  stableClock(t);
  const expected = await loadStopMaterialIndex(systemRoot, root);
  const filename = path.join(systemRoot, "A", "A.md");
  const changed = (await fs.readFile(filename, "utf8")).replace(
    "type: goal",
    "type: goal\ngenerated: {at: new}",
  );
  await fs.writeFile(filename, changed);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.match(
    cached.headers.find(([name]: [string]) => name === "A/A.md")[1].content,
    /generated/,
  );
  assert.equal(cached.indexDigest, digest(expected));
  await fs.writeFile(filename, changed.replace("type: goal", "type: output"));
  assert.equal(
    (await loadStopMaterialIndex(systemRoot, root)).nodes.find((node) => node.nodeId === "node-a")
      ?.type,
    "output",
  );
});

test("Stop binds cached headers to their own observation across requests and processes", async (t) => {
  const { root, systemRoot, cacheFile } = await fixture(t);
  stableClock(t);
  const original = path.join(systemRoot, "A"),
    replacement = path.join(root, "replacement"),
    saved = path.join(root, "saved");
  await fs.mkdir(replacement);
  const filename = path.join(original, "A.md");
  await fs.writeFile(path.join(replacement, "A.md"), "---\nid: node-replaced\ntype: goal\n---\n");
  const before = fileState(await fs.stat(filename, { bigint: true }));
  const other = fileState(await fs.stat(path.join(replacement, "A.md"), { bigint: true }));
  const stat = fs.stat;
  let reads = 0;
  const mocked = t.mock.method(fs, "stat", async (...args: Parameters<typeof stat>) => {
    const result = await stat(...args);
    if (String(args[0]) === filename) {
      reads++;
      if (reads === 1) {
        await fs.rename(original, saved);
        await fs.rename(replacement, original);
      } else if (reads === 3) {
        await fs.rename(original, replacement);
        await fs.rename(saved, original);
      }
    }
    return result;
  });
  syncBuiltinESMExports();
  // Avoid the fixture's child header competing with the intentional directory swap.
  await fs.rm(path.join(original, "Child"), { recursive: true });
  try {
    assert.equal((await loadStopMaterialIndex(systemRoot, root)).nodes[0]?.nodeId, "node-replaced");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(reads, 3);
  assert.notEqual(before.ino, other.ino);
  assert.deepEqual(fileState(await fs.stat(filename, { bigint: true })), before);
  const persisted = await fs.readFile(cacheFile, "utf8");
  // Start both reads from the exact cache produced during the A -> B -> A swap.
  const next = await loadStopMaterialIndex(systemRoot, root);
  await fs.writeFile(cacheFile, persisted);
  const fresh = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { loadStopMaterialIndex } from ${JSON.stringify(new URL("../src/fs/stop-material-index.ts", import.meta.url).href)};
     console.log(JSON.stringify(await loadStopMaterialIndex(process.argv[1], process.argv[2])));`,
        systemRoot,
        root,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.equal(next.nodes[0]?.nodeId, "node-a", "independent request must see restored A");
  assert.equal(fresh.nodes[0]?.nodeId, "node-a", "fresh process must see restored A");
  const header = JSON.parse(persisted).headers.find(([name]: [string]) => name === "A/A.md")[1];
  assert.deepEqual(header.state, other, "B content must carry B's observed identity");
});

test("Stop index persists directory and header hits without enumeration or header reads", async (t) => {
  const { root, systemRoot, cacheFile } = await fixture(t);
  stableClock(t);
  const expected = await loadStopMaterialIndex(systemRoot, root);
  const cached = await fs.readFile(cacheFile, "utf8");
  const directories = t.mock.method(NodeFs.prototype, "listDir");
  const headers = t.mock.method(NodeFs.prototype, "readFrontmatterObservation");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.equal(directories.mock.callCount(), 0);
  assert.equal(headers.mock.callCount(), 0);
  assert.equal(await fs.readFile(cacheFile, "utf8"), cached);
});

test("Stop index reparses only changed header state, including restored mtime and same size", async (t) => {
  const { root, systemRoot, cacheFile } = await fixture(t);
  stableClock(t);
  const original = await loadStopMaterialIndex(systemRoot, root);
  const filename = path.join(systemRoot, "A", "A.md");
  const before = await fs.stat(filename);
  await fs.writeFile(filename, (await fs.readFile(filename, "utf8")).replace("node-a", "node-b"));
  await fs.utimes(filename, before.atime, before.mtime);
  const directories = t.mock.method(NodeFs.prototype, "listDir");
  const headers = t.mock.method(NodeFs.prototype, "readFrontmatterObservation");
  const changed = await loadStopMaterialIndex(systemRoot, root);
  assert.ok(changed.nodes.some((node) => node.nodeId === "node-b"));
  assert.ok(!changed.nodes.some((node) => node.nodeId === "node-a"));
  assert.notDeepEqual(changed, original);
  assert.equal(directories.mock.callCount(), 0);
  assert.deepEqual(
    headers.mock.calls.map((call) => call.arguments[0]),
    ["A/A.md"],
  );
  headers.mock.resetCalls();
  await fs.appendFile(filename, "Body addition");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), changed);
  assert.equal(headers.mock.callCount(), 1);
  const cache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.equal(
    cache.headers.find(([filename]: [string]) => filename === "A/A.md")[1].state.size,
    String((await fs.stat(filename)).size),
  );
  headers.mock.resetCalls();
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), changed);
  assert.equal(headers.mock.callCount(), 0);
});

test("Stop index notices added, renamed and removed directories while reusing unchanged headers", async (t) => {
  const { root, systemRoot, node } = await fixture(t);
  stableClock(t);
  const original = await loadStopMaterialIndex(systemRoot, root);
  await node("A/Added", "node-added");
  const directories = t.mock.method(NodeFs.prototype, "listDir");
  const headers = t.mock.method(NodeFs.prototype, "readFrontmatterObservation");
  const added = await loadStopMaterialIndex(systemRoot, root);
  assert.ok(added.nodes.some((node) => node.nodeId === "node-added"));
  assert.deepEqual(directories.mock.calls.map((call) => call.arguments[0]).sort(), [
    "A",
    "A/Added",
  ]);
  assert.deepEqual(
    headers.mock.calls.map((call) => call.arguments[0]),
    ["A/Added/Added.md"],
  );
  await fs.rename(path.join(systemRoot, "A", "Added"), path.join(systemRoot, "A", "Renamed"));
  await fs.rename(
    path.join(systemRoot, "A", "Renamed", "Added.md"),
    path.join(systemRoot, "A", "Renamed", "Renamed.md"),
  );
  const renamed = await loadStopMaterialIndex(systemRoot, root);
  assert.equal(
    renamed.nodes.find((node) => node.nodeId === "node-added")?.path,
    ".tent/A/Renamed/Renamed.md",
  );
  await fs.rm(path.join(systemRoot, "A", "Renamed"), { recursive: true });
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), original);
  await fs.rm(path.join(systemRoot, "A", "Child", "Child.md"));
  assert.ok(
    !(await loadStopMaterialIndex(systemRoot, root)).nodes.some(
      (node) => node.nodeId === "node-child",
    ),
  );
});

test("Stop index rejects corrupt, obsolete and incomplete cache records and survives deletion", async (t) => {
  const { root, systemRoot, cacheFile } = await fixture(t);
  stableClock(t);
  const expected = await loadStopMaterialIndex(systemRoot, root);
  const valid = await fs.readFile(cacheFile, "utf8");
  const directories = t.mock.method(NodeFs.prototype, "listDir");
  const cases = [
    "broken JSON",
    JSON.stringify({ ...JSON.parse(valid), schema: 3 }),
    JSON.stringify({ ...JSON.parse(valid), schema: 4 }),
    (() => {
      const cached = JSON.parse(valid);
      cached.schema = 5;
      cached.index = { nodes: [] };
      cached.indexDigest = digest(cached.index);
      return JSON.stringify(cached);
    })(),
    JSON.stringify({ ...JSON.parse(valid), index: { nodes: [] } }),
    (() => {
      const cached = JSON.parse(valid);
      cached.headers[0][1].content = "---\nid: node-forged\n---\n";
      return JSON.stringify(cached);
    })(),
    (() => {
      const cached = JSON.parse(valid);
      cached.directories.pop();
      cached.sourceDigest = digest([cached.writtenAtNs, cached.directories, cached.headers]);
      return JSON.stringify(cached);
    })(),
    (() => {
      const cached = JSON.parse(valid);
      cached.directories[0][1].state.mtimeNs = "invalid";
      cached.sourceDigest = digest([cached.writtenAtNs, cached.directories, cached.headers]);
      return JSON.stringify(cached);
    })(),
  ];
  for (const invalid of cases) {
    await fs.writeFile(cacheFile, invalid);
    directories.mock.resetCalls();
    assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
    assert.ok(directories.mock.callCount() > 0);
  }
  await fs.rm(cacheFile);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
});

test("Stop index rechecks racy directory and header timestamps even when their state matches", async (t) => {
  const { root, systemRoot, cacheFile } = await fixture(t);
  const stat = await fs.stat(path.join(systemRoot, "A", "A.md"), { bigint: true });
  t.mock.method(Date, "now", () => Number(stat.mtimeNs / 1_000_000n));
  const expected = await loadStopMaterialIndex(systemRoot, root);
  const directories = t.mock.method(NodeFs.prototype, "listDir");
  const headers = t.mock.method(NodeFs.prototype, "readFrontmatterObservation");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.ok(directories.mock.callCount() > 0);
  assert.equal(headers.mock.callCount(), 2);
  const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  const a = cached.headers.find(([filename]: [string]) => filename === "A/A.md")[1];
  assert.ok(BigInt(a.state.mtimeNs) >= BigInt(cached.writtenAtNs) - 1_000_000_000n);
});

test("Stop index ignores child directory links and preserves a linked system root", async (t) => {
  const { root, systemRoot } = await fixture(t);
  stableClock(t);
  const expected = await loadStopMaterialIndex(systemRoot, root);
  const outside = path.join(root, "Outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "Link.md"), "---\nid: node-linked\ntype: goal\n---\n");
  try {
    await fs.symlink(
      outside,
      path.join(systemRoot, "Link"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM")
      return t.skip("Directory links require filesystem permission");
    throw error;
  }
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  const movedRoot = path.join(root, "system-store");
  await fs.rename(systemRoot, movedRoot);
  await fs.symlink(movedRoot, systemRoot, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
  assert.deepEqual(await loadStopMaterialIndex(systemRoot, root), expected);
});
