import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent, isContentMutable, isUsableNode } from "../src/core/tree.js";
import { archiveNode, restoreNode, NodeLifecycleError } from "../src/core/node-lifecycle.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { loadNodeCatalog, catalogRelations, catalogSummary } from "../src/core/node-catalog.js";
import { liveContextReader } from "../src/core/context-reader-factory.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { contentEtag } from "../src/core/etag.js";
import { git } from "./helpers.js";

const source = { kind: "live" as const, workspaceId: "ws-status" };
for (const action of ["archive", "restore"] as const) {
  test(`${action} reports saved paths and reachable preimages when outer history finalization fails`, async (t) => {
    const { root, adapter, env } = await fixture(t);
    const archived = action === "restore" ? await archiveNode(env, "node-root") : undefined;
    const capture = adapter.history.captureUnlocked.bind(adapter.history);
    let afterCapture = false;
    adapter.history.captureUnlocked = async (changes) => {
      const result = await capture(changes);
      const rootChange = changes.find((c) => c.path === "A/A.md");
      if (
        !afterCapture &&
        changes.length === 3 &&
        rootChange?.raw &&
        (parseFrontmatter(rootChange.raw).data.status === "deprecated") === (action === "archive")
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
      () =>
        action === "archive"
          ? archiveNode(env, "node-root")
          : restoreNode(env, "node-root", archived!.commit!),
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
    await git(root, "fsck", "--no-reflogs");
  });
}
const raw = (id: string, extra = "", body = "fact") =>
  `\uFEFF---\r\nid: ${id}\r\ntype: prompt\r\nextra: {nested: [1, two]} # preserve\r\n${extra}---\r\n${body}`;
async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, "init");
  const adapter = new NodeFs(root);
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
  const saved = await writeNodeDocument(adapter, "node-root", {
    baseEtag: contentEtag(initial),
    frontmatter: { status: "deprecated" },
  });
  const tree = await loadTent(adapter),
    root = tree.byId.get("node-root")!;
  assert.equal(root.status, "deprecated");
  assert.equal(tree.byId.get("node-draft")!.status, "draft");
  assert.equal(isContentMutable(root), true);
  assert.equal(isUsableNode(root), false);
  const edited = await writeNodeDocument(adapter, root.id, {
    baseEtag: saved.etag,
    body: "corrected old explanation",
  });
  assert.equal(parseFrontmatter(edited.raw).data.status, "deprecated");
  const catalog = await loadNodeCatalog(adapter);
  assert.ok(
    catalogRelations(catalog, source, { nodeId: null, direction: "children" }).items.some(
      (n) => n.nodeId === root.id,
    ),
  );
  const reader = await liveContextReader(adapter, source);
  assert.ok(reader.list().items.some((n) => n.nodeId === root.id));
  assert.equal(reader.search({ query: "corrected" }).items.length, 0);
  assert.equal(reader.search({ query: "corrected", includeArchived: true }).items.length, 1);
  await adapter.writeFile(
    "A/A.md",
    edited.raw.replace("status: deprecated", "status: future-state"),
  );
  const unknown = (await loadTent(adapter)).byId.get(root.id)!;
  assert.equal(unknown.status, null);
  assert.equal(unknown.invalid, false);
  const summary = catalogSummary(await loadNodeCatalog(adapter), source, root.id);
  assert.match(summary.statusDiagnostic!, /Unsupported/);
  const current = await adapter.readFile("A/A.md");
  await writeNodeDocument(adapter, root.id, {
    baseEtag: contentEtag(current),
    body: "preserve unknown lifecycle",
  });
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).data.status, "future-state");
  assert.equal((await loadTent(adapter)).byId.get("node-draft")!.status, "draft");
});

test("archive captures only selected preimages and undo restores exact declared statuses", async (t) => {
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
  assert.ok(!(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).includes("Other/"));
  const noOp = await archiveNode(env, "node-root");
  assert.equal(noOp.changed, false);
  assert.equal((await git(root, "rev-parse", "HEAD")).trim(), archived.commit);
  await adapter.writeFile("A/New/New.md", raw("node-new"));
  const restored = await restoreNode(env, "node-root", archived.commit);
  assert.equal(restored.changed, true);
  for (const [file, expected] of [
    ["A/A.md", undefined],
    ["A/B/B.md", "draft"],
    ["A/C/C.md", "deprecated"],
    ["A/D/D.md", "stable"],
    ["A/New/New.md", undefined],
  ] as const) {
    const document = parseFrontmatter(await read(file));
    assert.equal(document.data.status, expected);
    assert.deepEqual(document.data.extra, { nested: [1, "two"] });
    assert.equal(document.body, "fact");
  }
  assert.equal(await read("A/C/C.md"), unchanged);
  await assert.rejects(restoreNode(env, "node-root", archived.commit), /conflicts/);
});

test("archive undo preflights external edits and retained ABA without changing other documents", async (t) => {
  const { adapter, env } = await fixture(t);
  const archived = await archiveNode(env, "node-root");
  assert.ok(archived.commit);
  const rootRaw = await adapter.readFile("A/A.md"),
    childRaw = await adapter.readFile("A/B/B.md");
  await adapter.writeFile("A/B/B.md", childRaw + "external edit");
  await assert.rejects(restoreNode(env, "node-root", archived.commit), (error: unknown) => {
    assert.ok(error instanceof NodeLifecycleError);
    assert.deepEqual(error.details.savedPaths, []);
    assert.deepEqual(error.details.conflicts, ["A/B/B.md"]);
    return true;
  });
  assert.equal(await adapter.readFile("A/A.md"), rootRaw);
  await adapter.writeFile("A/B/B.md", childRaw);
  const changed = await writeNodeDocument(adapter, "node-root", {
    baseEtag: contentEtag(rootRaw),
    frontmatter: { status: "stable" },
  });
  await writeNodeDocument(adapter, "node-root", { baseEtag: changed.etag, raw: rootRaw });
  assert.equal(await adapter.readFile("A/A.md"), rootRaw);
  await assert.rejects(restoreNode(env, "node-root", archived.commit), /conflicts/);
  const ordinary = await writeNodeDocument(adapter, "node-root", {
    baseEtag: contentEtag(rootRaw),
    body: "new body",
  });
  assert.ok(ordinary.version);
  await assert.rejects(
    restoreNode(env, "node-root", ordinary.version.commit),
    /pure status archive/,
  );
  await assert.rejects(restoreNode(env, "node-root", "f".repeat(40)), /Git/);
});

test("archive errors expose finite partial writes and reachable preimages; no false success", async (t) => {
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
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).data.status, "deprecated");
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
  adapter.history.captureUnlocked = async (changes) => {
    if (
      changes.length === 3 &&
      changes.every((c) => c.raw !== null && parseFrontmatter(c.raw).data.status === "deprecated")
    ) {
      throw new Error("injected publication failure");
    }
    return capture(changes);
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
  assert.equal(parseFrontmatter(await adapter.readFile("A/A.md")).data.status, "deprecated");
});
