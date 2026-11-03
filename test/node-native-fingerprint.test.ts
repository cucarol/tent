import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { PropagationMemoryFs } from "./propagation-memory.js";
import { scaffoldTent } from "../src/core/store/scaffold.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "native-fingerprint-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await initializeFixtureWorkspace(root);
  const system = path.join(root, ".tent"),
    adapter = openTestFs(system);
  const paths = Array.from({ length: 8 }, (_, index) => `Node${index}/Node${index}.md`);
  const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
  for (const [index, file] of paths.entries()) {
    const filename = path.join(system, file);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(
      filename,
      `---\nid: node-fingerprint${index}\ntype: prompt\ndescription: Stable facts\n---\nbody ${index}`,
    );
    await fs.utimes(filename, old, old);
  }
  await captureNativeNodeEdits(adapter);
  return { root, system, adapter, paths };
}

function countNodeReads(
  t: TestContext,
  adapter: ReturnType<typeof openTestFs>,
  system: string,
  paths: string[],
) {
  let fullReads = 0;
  const opens = new Map<string, number>();
  const filenames = new Set(paths.map((file) => path.resolve(system, file)));
  const open = fs.open,
    readFile = adapter.readFile.bind(adapter);
  t.mock.method(adapter, "readFile", async (file: string) => {
    if (paths.includes(file)) fullReads++;
    return readFile(file);
  });
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const filename = path.resolve(String(args[0]));
    if (filenames.has(filename) && args[1] === "r")
      opens.set(filename, (opens.get(filename) ?? 0) + 1);
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    snapshot: () => ({
      fullReads,
      opens: [...opens.values()].reduce((sum, count) => sum + count, 0),
    }),
    opens,
  };
}

test("warm unchanged native Nodes use validated fingerprints without full reads; custom adapters retain the direct path", async (t) => {
  const f = await fixture(t);
  const count = countNodeReads(t, f.adapter, f.system, f.paths);
  const before = await f.adapter.history.currentCommit();
  const warm = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(warm.changedNodePaths, []);
  assert.deepEqual(warm.invalidNodes, []);
  const fingerprint = count.snapshot();
  assert.deepEqual(fingerprint, { fullReads: 0, opens: 0 });
  const direct = new Proxy(f.adapter, {
    get(target, key) {
      if (key === "readFrontmatterWithFingerprint") return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fallback = await captureNativeNodeEdits(direct);
  assert.deepEqual(fallback.changedNodePaths, []);
  assert.deepEqual(fallback.invalidNodes, []);
  assert.deepEqual([...fallback.catalog!.byId], [...warm.catalog!.byId]);
  assert.deepEqual(count.snapshot(), { fullReads: 8, opens: 8 });
  assert.equal(await f.adapter.history.currentCommit(), before);
  t.diagnostic(JSON.stringify({ nodes: 8, fingerprint, direct: count.snapshot() }));
});

test("native fingerprint selection captures same-size body changes with restored mtime and later metadata changes", async (t) => {
  const f = await fixture(t);
  const target = f.paths[0]!,
    filename = path.join(f.system, target);
  const original = await fs.readFile(filename, "utf8"),
    state = await fs.stat(filename, { bigint: true });
  const count = countNodeReads(t, f.adapter, f.system, f.paths);
  const changed = original.replace("body 0", "BODY 0");
  await fs.writeFile(filename, changed);
  await fs.utimes(filename, new Date(Number(state.atimeMs)), new Date(Number(state.mtimeMs)));
  const after = await fs.stat(filename, { bigint: true });
  assert.equal(after.size, state.size);
  assert.equal(after.mtimeNs, state.mtimeNs);
  assert.notEqual(after.ctimeNs, state.ctimeNs);
  const body = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(body.changedNodePaths, [target]);
  assert.deepEqual(body.invalidNodes, []);
  const head = (await f.adapter.history.currentCommit())!;
  assert.equal(await f.adapter.history.read({ commit: head, path: target }), changed);
  for (const file of f.paths.slice(1))
    assert.equal(count.opens.get(path.resolve(f.system, file)) ?? 0, 0);
  const metadata = changed.replace("description: Stable facts", "description: Changed facts");
  await fs.writeFile(filename, metadata);
  const saved = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(saved.changedNodePaths, [target]);
  assert.deepEqual(saved.invalidNodes, []);
  assert.equal(
    await f.adapter.history.read({
      commit: (await f.adapter.history.currentCommit())!,
      path: target,
    }),
    metadata,
  );
});

test("native fingerprint optimization preserves Memory adapter capture without a fingerprint getter", async () => {
  const memory = new PropagationMemoryFs();
  await scaffoldTent(memory, { name: "Memory" });
  const raw = "---\nid: node-memory\ntype: prompt\n---\nMemory body";
  await memory.writeFile("Node/Node.md", raw);
  const saved = await captureNativeNodeEdits(memory);
  assert.deepEqual(saved.changedNodePaths, ["Node/Node.md"]);
  const head = (await memory.history.currentCommit())!;
  assert.equal(await memory.history.read({ commit: head, path: "Node/Node.md" }), raw);
  const unchanged = await captureNativeNodeEdits(memory);
  assert.deepEqual(unchanged.changedNodePaths, []);
  assert.deepEqual(unchanged.invalidNodes, []);
});

test("native capture does not promote malformed fingerprint/header observations to full document bytes", async (t) => {
  const f = await fixture(t);
  const target = f.paths[0]!,
    raw = await fs.readFile(path.join(f.system, target), "utf8");
  const observe = f.adapter.readFrontmatterWithFingerprint.bind(f.adapter);
  const original = await observe(target);
  const head = await f.adapter.history.currentCommit();
  for (const observation of [
    { content: raw, fingerprint: original.fingerprint },
    { content: original.content, fingerprint: "invalid fingerprint" },
  ]) {
    const mocked = t.mock.method(f.adapter, "readFrontmatterWithFingerprint", (file: string) =>
      file === target ? Promise.resolve(observation) : observe(file),
    );
    const result = await captureNativeNodeEdits(f.adapter);
    mocked.mock.restore();
    assert.deepEqual(result.invalidNodes, []);
    assert.deepEqual(result.changedNodePaths, []);
    assert.equal(result.catalog?.byId.get("node-fingerprint0")?.header, original.content);
    assert.equal(await f.adapter.history.currentCommit(), head);
  }
});
