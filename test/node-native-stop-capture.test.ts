import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { initializeFixtureWorkspace } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";

const scratch = fileURLToPath(new URL("../.scratch/converge-stop1103/native/", import.meta.url));
const rawNode = (id: string, body = "Native body") =>
  `---\nid: ${id}\ntype: prompt\ndescription: Native Node\nprovenance: [keep, {from: native}]\n---\n${body}\n`;

async function fixture(t: TestContext) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "case-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
  );
  await initializeFixtureWorkspace(root);
  const systemRoot = path.join(root, ".tent");
  const adapter = openTestFs(systemRoot);
  async function write(file: string, raw: string) {
    await fs.mkdir(path.dirname(path.join(systemRoot, file)), { recursive: true });
    await fs.writeFile(path.join(systemRoot, file), raw);
  }
  return { root, systemRoot, adapter, write };
}

test("first native Node creation becomes exact readable history without rewriting its bytes", async (t) => {
  const f = await fixture(t);
  const raw = rawNode("node-native");
  await f.write("New Node/New Node.md", raw);
  await f.write("roles/role-untouched.md", "Native Role bytes");
  await f.write("cards/card-untouched.md", "Native Card bytes");
  const observed = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(observed.changedNodePaths, ["New Node/New Node.md"]);
  assert.deepEqual(observed.invalidNodes, []);
  assert.equal(observed.catalog?.byId.get("node-native")?.nodeId, "node-native");
  const head = await f.adapter.history.currentCommit();
  assert.ok(head);
  assert.equal(await f.adapter.history.read({ commit: head, path: "New Node/New Node.md" }), raw);
  assert.equal(await f.adapter.readFile("New Node/New Node.md"), raw);
  assert.deepEqual(await f.adapter.history.retainedPaths(), ["New Node/New Node.md"]);
  assert.equal(await f.adapter.readFile("roles/role-untouched.md"), "Native Role bytes");
  assert.equal(await f.adapter.readFile("cards/card-untouched.md"), "Native Card bytes");
});

test("two new Nodes share one event and native edit plus deletion share the next event", async (t) => {
  const f = await fixture(t);
  const first = rawNode("node-first"),
    second = rawNode("node-second");
  await f.write("First/First.md", first);
  await f.write("Second/Second.md", second);
  const added = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(added.changedNodePaths, ["First/First.md", "Second/Second.md"]);
  assert.equal((await f.adapter.history.changesInRange()).length, 1);
  const before = (await f.adapter.history.currentCommit())!;
  const edited = first + "\nEdited with native tools.\n";
  await f.write("First/First.md", edited);
  await fs.rm(path.join(f.systemRoot, "Second"), { recursive: true });
  const observed = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(observed.changedNodePaths, ["First/First.md", "Second/Second.md"]);
  const head = (await f.adapter.history.currentCommit())!;
  assert.equal((await f.adapter.history.changesInRange({ from: before })).length, 1);
  assert.equal(await f.adapter.history.read({ commit: head, path: "First/First.md" }), edited);
  assert.equal(await f.adapter.history.read({ commit: before, path: "Second/Second.md" }), second);
  await assert.rejects(
    f.adapter.history.read({ commit: head, path: "Second/Second.md" }),
    /absent/,
  );
  assert.deepEqual(await f.adapter.history.retainedPaths(), ["First/First.md"]);
});

test("native move records actual delete and add paths in one event without changing content", async (t) => {
  const f = await fixture(t);
  const raw = rawNode("node-moved");
  await f.write("Before/Before.md", raw);
  await captureNativeNodeEdits(f.adapter);
  const before = (await f.adapter.history.currentCommit())!;
  await fs.rename(path.join(f.systemRoot, "Before"), path.join(f.systemRoot, "After"));
  await fs.rename(
    path.join(f.systemRoot, "After/Before.md"),
    path.join(f.systemRoot, "After/After.md"),
  );
  const observed = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(observed.changedNodePaths, ["After/After.md", "Before/Before.md"]);
  assert.deepEqual(observed.invalidNodes, []);
  const head = (await f.adapter.history.currentCommit())!;
  assert.equal((await f.adapter.history.changesInRange({ from: before })).length, 1);
  assert.deepEqual(
    (await f.adapter.history.commitChanges(head)).changes.sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    [
      { path: "After/After.md", before: null, after: raw },
      { path: "Before/Before.md", before: raw, after: null },
    ],
  );
  assert.equal(await f.adapter.readFile("After/After.md"), raw);
});

for (const [label, change, reason] of [
  ["id", (raw: string) => raw.replace("node-native", "wrong-id"), /Invalid Node id/],
  ["type", (raw: string) => raw.replace("type: prompt", "type: unknown"), /type/i],
  [
    "description",
    (raw: string) => raw.replace("description: Native Node", "description: 12"),
    /description must be a string/,
  ],
  [
    "retired field",
    (raw: string) => raw.replace("type: prompt", "type: prompt\nsync: old"),
    /Node field sync is retired/,
  ],
  ["YAML", (raw: string) => raw.replace("type: prompt", "type: ["), /frontmatter/i],
] as const) {
  test(`invalid native new ${label} stays unretained and keeps its original bytes`, async (t) => {
    const f = await fixture(t);
    const raw = change(rawNode("node-native"));
    await f.write("Invalid/Invalid.md", raw);
    const before = await f.adapter.history.currentCommit();
    const observed = await captureNativeNodeEdits(f.adapter);
    assert.deepEqual(observed.changedNodePaths, ["Invalid/Invalid.md"]);
    assert.equal(observed.invalidNodes.length, 1);
    assert.match(observed.invalidNodes[0]!.reason, reason);
    assert.equal(await f.adapter.history.currentCommit(), before);
    assert.deepEqual(await f.adapter.history.retainedPaths(), []);
    assert.equal(await f.adapter.readFile("Invalid/Invalid.md"), raw);
  });
}

for (const [label, change, reason] of [
  ["id change", (raw: string) => raw.replace("node-native", "node-renamed"), /id cannot change/],
  ["type", (raw: string) => raw.replace("type: prompt", "type: unknown"), /type/i],
  [
    "description",
    (raw: string) => raw.replace("description: Native Node", "description: 12"),
    /description must be a string/,
  ],
] as const) {
  test(`invalid existing native ${label} preserves the retained version and reports its path`, async (t) => {
    const f = await fixture(t);
    const original = rawNode("node-native");
    await f.write("Existing/Existing.md", original);
    await captureNativeNodeEdits(f.adapter);
    const before = (await f.adapter.history.currentCommit())!;
    const raw = change(original);
    await f.write("Existing/Existing.md", raw);
    const observed = await captureNativeNodeEdits(f.adapter);
    assert.deepEqual(observed.changedNodePaths, ["Existing/Existing.md"]);
    assert.equal(observed.invalidNodes.length, 1);
    assert.match(observed.invalidNodes[0]!.reason, reason);
    assert.equal(await f.adapter.history.currentCommit(), before);
    assert.equal(
      await f.adapter.history.read({ commit: before, path: "Existing/Existing.md" }),
      original,
    );
    assert.equal(await f.adapter.readFile("Existing/Existing.md"), raw);
  });
}

test("duplicate native IDs never enter history", async (t) => {
  const f = await fixture(t);
  const raw = rawNode("node-duplicate");
  await f.write("Original/Original.md", raw);
  await captureNativeNodeEdits(f.adapter);
  const before = await f.adapter.history.currentCommit();
  await f.write("Duplicate/Duplicate.md", raw);
  const observed = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(observed.changedNodePaths, ["Duplicate/Duplicate.md"]);
  assert.equal(observed.invalidNodes.length, 2);
  assert.ok(observed.invalidNodes.every((node) => /Duplicate id/.test(node.reason)));
  assert.equal(await f.adapter.history.currentCommit(), before);
  assert.deepEqual(await f.adapter.history.retainedPaths(), ["Original/Original.md"]);
});

test("invalid native move rejects both paths while independent valid Node creation is captured", async (t) => {
  const f = await fixture(t);
  const raw = rawNode("node-moving");
  await f.write("Before/Before.md", raw);
  await captureNativeNodeEdits(f.adapter);
  await fs.rm(path.join(f.systemRoot, "Before"), { recursive: true });
  const invalid = raw.replace("type: prompt", "type: unknown");
  await f.write("After/After.md", invalid);
  const valid = rawNode("node-independent");
  await f.write("Independent/Independent.md", valid);
  const observed = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(observed.changedNodePaths, [
    "After/After.md",
    "Before/Before.md",
    "Independent/Independent.md",
  ]);
  assert.equal(observed.invalidNodes.length, 1);
  const head = (await f.adapter.history.currentCommit())!;
  assert.equal(await f.adapter.history.read({ commit: head, path: "Before/Before.md" }), raw);
  assert.equal(
    await f.adapter.history.read({ commit: head, path: "Independent/Independent.md" }),
    valid,
  );
  assert.deepEqual(await f.adapter.history.retainedPaths(), [
    "Before/Before.md",
    "Independent/Independent.md",
  ]);
  assert.equal(await f.adapter.readFile("After/After.md"), invalid);
});

test("unchanged native capture takes no mutation lock and writes no history or Node files", async (t) => {
  const f = await fixture(t);
  await f.write("Stable/Stable.md", rawNode("node-stable"));
  await captureNativeNodeEdits(f.adapter);
  const before = await f.adapter.history.currentCommit();
  t.mock.method(f.adapter, "withLock", () => {
    throw new Error("Unexpected mutation lock");
  });
  t.mock.method(f.adapter.history, "captureUnlocked", () => {
    throw new Error("Unexpected history write");
  });
  t.mock.method(f.adapter, "writeFile", () => {
    throw new Error("Unexpected Node write");
  });
  const observed = await captureNativeNodeEdits(f.adapter);
  assert.deepEqual(observed.changedNodePaths, []);
  assert.deepEqual(observed.invalidNodes, []);
  assert.equal(await f.adapter.history.currentCommit(), before);
});

for (const failure of ["capture", "deleted history read"] as const) {
  test(`native capture propagates original ${failure} errors`, async (t) => {
    const f = await fixture(t);
    const raw = rawNode("node-error");
    await f.write("Node/Node.md", raw);
    await captureNativeNodeEdits(f.adapter);
    const before = await f.adapter.history.currentCommit();
    const error = Object.assign(new Error("Controlled original storage failure"), {
      code: "EACCES",
    });
    if (failure === "capture") {
      await f.write("Node/Node.md", raw + "\nEdit");
      t.mock.method(f.adapter.history, "captureUnlocked", async () => {
        throw error;
      });
    } else {
      await fs.rm(path.join(f.systemRoot, "Node"), { recursive: true });
      t.mock.method(f.adapter.history, "readVersions", async () => [error]);
    }
    await assert.rejects(captureNativeNodeEdits(f.adapter), (caught) => caught === error);
    assert.equal(await f.adapter.history.currentCommit(), before);
  });
}

for (const marker of ["node-move.pending.json", "delete.pending.json"]) {
  test(`unsettled ${marker} rejects capture before a new Node enters history`, async (t) => {
    const f = await fixture(t);
    const raw = rawNode("node-newpending");
    await f.write("New/New.md", raw);
    await f.write(marker, "Unsettled recovery record");
    const head = await f.adapter.history.currentCommit();
    const capture = t.mock.method(f.adapter.history, "captureUnlocked", async () => {
      throw new Error("Must not capture before recovery");
    });
    await assert.rejects(captureNativeNodeEdits(f.adapter), SyntaxError);
    assert.equal(capture.mock.callCount(), 0);
    assert.equal(await f.adapter.history.currentCommit(), head);
    assert.equal(await f.adapter.readFile(marker), "Unsettled recovery record");
    assert.equal(await f.adapter.readFile("New/New.md"), raw);
  });
}
