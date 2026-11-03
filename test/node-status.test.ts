import { initializeFixtureHistory } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadTent, isContentMutable, isUsableNode } from "../src/core/store/tree.js";
import { archiveNode, NodeLifecycleError } from "../src/core/graph/node-lifecycle.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { documentLifecycle } from "../src/core/base/document-status.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { editNode } from "./node-edit.js";

test("archive reports saved paths and reachable preimages when outer history finalization fails", async (t) => {
  const { root, adapter, env } = await fixture(t);
  const capture = adapter.history.captureUnlocked.bind(adapter.history);
  let afterCapture = false;
  adapter.history.captureUnlocked = async (changes, metadata) => {
    const result = await capture(changes, metadata);
    const rootChange = changes.find((c) => c.path === "A/A.md");
    if (
      !afterCapture &&
      changes.length === 3 &&
      rootChange?.raw &&
      parseFrontmatter(rootChange.raw).data.status === "deprecated"
    ) {
      afterCapture = true;
      await fs.writeFile(
        path.join(root, "A/A.md"),
        rootChange.raw + "\nexternal change after capture",
      );
    }
    return result;
  };
  await assert.rejects(
    () => archiveNode(env, "node-root"),
    (asyncError) => {
      assert.ok(asyncError instanceof NodeLifecycleError);
      assert.deepEqual(asyncError.details.savedPaths.sort(), ["A/A.md", "A/B/B.md", "A/D/D.md"]);
      assert.ok(asyncError.details.beforeCommit);
      assert.match(asyncError.message, /Document changed during save/);
      return true;
    },
  );
  assert.ok(afterCapture);
  assert.match(await adapter.readFile("A/A.md"), /external change after capture/);
  // The explicit preimage is reachable despite the outer failure; current files are not rolled back.
  assert.ok((await adapter.history.changesInRange()).length > 0);
});
const raw = (id: string, extra = "", body = "fact") =>
  `\uFEFF---\r\nid: ${id}\r\ntype: prompt\r\nextra: {nested: [1, two]} # preserve\r\n${extra}---\r\n${body}`;
async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-status-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await initializeFixtureHistory(root);
  const adapter = openTestFs(root);
  const env = { fs: adapter, clock: { now: () => "2026-10-04T00:00:00.000Z" }, tentName: "test" };
  await adapter.writeFile("A/A.md", raw("node-root"));
  await adapter.writeFile("A/B/B.md", raw("node-draft", "status: draft\r\n"));
  await adapter.writeFile("A/C/C.md", raw("node-deprecated", "status: deprecated\r\n"));
  await adapter.writeFile("A/D/D.md", raw("node-stable", "status: stable\r\n"));
  await adapter.writeFile("Other/Other.md", raw("node-other", "", "unobserved body"));
  return { root, adapter, env };
}

test("local status never inherits or freezes edits; unknown status stays visible as a diagnostic", async (t) => {
  const { adapter } = await fixture(t);
  const initial = await adapter.readFile("A/A.md");
  const saved = await editNode(adapter, "node-root", {
    frontmatter: { status: "deprecated" },
  });
  const tree = await loadTent(adapter),
    root = tree.byId.get("node-root")!;
  assert.equal(root.status, "deprecated");
  assert.equal("archived" in root, false);
  assert.equal(isUsableNode(tree.byId.get("node-draft")!), true);
  assert.equal(tree.byId.get("node-draft")!.status, "draft");
  assert.equal(isContentMutable(root), true);
  assert.equal(isUsableNode(root), false);
  const edited = await editNode(adapter, root.id, {
    body: "corrected old explanation",
  });
  assert.equal(parseFrontmatter(edited.raw).data.status, "deprecated");
  const catalog = await loadNodeCatalog(adapter);
  assert.ok(catalog.rootNodeIds.includes(root.id));
  await adapter.writeFile(
    "A/A.md",
    edited.raw.replace("status: deprecated", "status: future-state"),
  );
  const unknown = (await loadTent(adapter)).byId.get(root.id)!;
  assert.equal(unknown.status, null);
  assert.equal(unknown.invalid, false);
  assert.match(
    documentLifecycle(parseFrontmatter(await adapter.readFile("A/A.md")).data).statusDiagnostic!,
    /Unsupported/,
  );
  // An unknown value already retained, as an imported workspace may hold one.
  const current = await adapter.readFile("A/A.md");
  await adapter.history.captureUnlocked([{ path: "A/A.md", raw: current }]);
  await editNode(adapter, root.id, {
    body: "preserve unknown lifecycle",
  });
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).data.status, "future-state");
  assert.equal((await loadTent(adapter)).byId.get("node-draft")!.status, "draft");
});

test("archive captures selected documents in ordinary history and status edits reactivate them", async (t) => {
  const { root, adapter, env } = await fixture(t);
  const unchanged = await adapter.readFile("A/C/C.md");
  const read = adapter.readFile.bind(adapter),
    bodyReads: string[] = [];
  adapter.readFile = async (file) => {
    if (file.endsWith(".md")) bodyReads.push(file);
    return read(file);
  };
  const archived = await archiveNode(env, "node-root");
  assert.ok(archived.changed && archived.commit);
  assert.equal(bodyReads.includes("Other/Other.md"), false);
  assert.deepEqual(archived.paths.sort(), ["A/A.md", "A/B/B.md", "A/D/D.md"]);
  assert.equal(await read("A/C/C.md"), unchanged);
  const changes = await adapter.history.commitChanges(archived.commit);
  assert.equal(changes.changes.length, 3);
  assert.equal(
    parseFrontmatter(changes.changes.find((c) => c.path === "A/B/B.md")!.before!).data.status,
    "draft",
  );
  assert.ok(!(await adapter.history.retainedPaths()).some((file) => file.startsWith("Other/")));
  const noOp = await archiveNode(env, "node-root");
  assert.equal(noOp.changed, false);
  assert.equal(await adapter.history.currentCommit(), archived.commit);
  const before = await adapter.readFile("A/A.md");
  const reactivated = await editNode(adapter, "node-root", {
    frontmatter: { status: "stable" },
  });
  assert.equal(parseFrontmatter(reactivated.raw).data.status, "stable");
  assert.equal(isUsableNode((await loadTent(adapter)).byId.get("node-root")!), true);
  assert.equal(parseFrontmatter(await read("A/B/B.md")).data.status, "deprecated");
  assert.equal(await read("A/C/C.md"), unchanged);
  assert.equal(await adapter.history.read({ commit: archived.commit, path: "A/A.md" }), before);
});

test("archive errors report attempted writes and restore the whole unpublished group", async (t) => {
  const { adapter, env } = await fixture(t);
  const beforeRoot = await adapter.readFile("A/A.md"),
    beforeChild = await adapter.readFile("A/B/B.md");
  const write = adapter.writeFile.bind(adapter);
  adapter.writeFile = async (file, raw) => {
    if (file === "A/B/B.md") throw new Error("injected write failure");
    await write(file, raw);
  };
  await assert.rejects(archiveNode(env, "node-root"), (asyncError) => {
    assert.ok(asyncError instanceof NodeLifecycleError);
    assert.deepEqual(asyncError.details.savedPaths, ["A/A.md"]);
    assert.ok(asyncError.details.beforeCommit);
    return true;
  });
  assert.equal(await adapter.readFile("A/A.md"), beforeRoot);
  assert.equal(await adapter.readFile("A/B/B.md"), beforeChild);
  const captured = await adapter.history.captureUnlocked([]);
  assert.equal(
    await adapter.history.read({ commit: captured.commit!, path: "A/A.md" }),
    beforeRoot,
  );
});

test("unknown lifecycle blocks archive while ordinary mode metadata does not", async (t) => {
  const { adapter, env } = await fixture(t);
  const before = await adapter.readFile("A/A.md");
  await adapter.writeFile("A/B/B.md", raw("node-draft", "status: future-state\r\n"));
  await assert.rejects(archiveNode(env, "node-root"), /Unsupported status/);
  assert.equal(await adapter.readFile("A/A.md"), before);
  await adapter.writeFile("A/B/B.md", raw("node-draft", "status: draft\r\nmode: archived\r\n"));
  const tree = await loadTent(adapter);
  assert.equal(tree.byPath.get("A/B")!.invalid, false);
  await archiveNode(env, "node-root");
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).data.status, "deprecated");
});

test("archive publication failure reports saved files and preserves the reachable preimage", async (t) => {
  const { adapter, env } = await fixture(t);
  const before = await adapter.readFile("A/A.md");
  const capture = adapter.history.captureUnlocked.bind(adapter.history);
  adapter.history.captureUnlocked = async (changes, metadata) => {
    if (
      changes.length === 3 &&
      changes.every((c) => c.raw !== null && parseFrontmatter(c.raw).data.status === "deprecated")
    ) {
      throw new Error("injected publication failure");
    }
    return capture(changes, metadata);
  };
  let beforeCommit: string | undefined;
  await assert.rejects(archiveNode(env, "node-root"), (error) => {
    assert.ok(error instanceof NodeLifecycleError);
    assert.match(error.message, /publication failure/);
    assert.deepEqual(error.details.savedPaths.sort(), ["A/A.md", "A/B/B.md", "A/D/D.md"]);
    beforeCommit = error.details.beforeCommit;
    return true;
  });
  assert.ok(beforeCommit);
  assert.equal(await adapter.history.read({ commit: beforeCommit, path: "A/A.md" }), before);
  assert.equal(await adapter.readFile("A/A.md"), before);
});
