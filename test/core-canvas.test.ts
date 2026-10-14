import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { withTentMutation } from "../src/core/adapter.js";
import {
  CANVAS_LIMIT,
  CanvasError,
  readCanvasDocument,
  writeCanvasDocument,
} from "../src/core/canvas.js";
import { readDocumentDiff, readDocumentVersion } from "../src/core/document-diff.js";
import { readWorkspaceRevision } from "../src/core/workspace-revision.js";
import { MUTATION_LOCK_PATH } from "../src/core/paths.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeFixtureWorkspace } from "./scratch.js";
import { exportGraph } from "../src/fs/graph-export.js";
import { testScratchRoot } from "./scratch.js";
import { buildSnapshot } from "../src/ui-server/snapshot.js";

const empty = () => ({ version: 1, forms: {}, positions: {}, drawings: [] });
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "canvas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const workspace = path.join(root, "ws");
  await initializeFixtureWorkspace(workspace);
  const systemRoot = path.join(workspace, ".tent");
  return { root, workspace, systemRoot, adapter: new NodeFs(systemRoot, "ui") };
}

test("canvas missing reads are inert; writes preserve UI fields and unavailable Node references", async (t) => {
  const { adapter } = await fixture(t);
  const before = await adapter.history.currentCommit();
  assert.deepEqual(await readCanvasDocument(adapter), { etag: null, canvas: null });
  assert.equal(await adapter.exists("canvas.json"), false);
  assert.equal(await adapter.history.currentCommit(), before);
  const canvas = {
    ...empty(),
    forms: { "node-missing": "box" },
    positions: {
      "node-missing|tree": { "node-gone": [10, -20] },
      "@root": { "node-missing": [0.25, 2] },
    },
    drawings: [
      {
        id: "d1",
        kind: "arrow",
        node: "node-gone",
        to: { node: null, at: [3, 4] },
        custom: { untouched: true },
      },
    ],
  };
  const first = await writeCanvasDocument(adapter, { baseEtag: null, canvas });
  assert.deepEqual(await readCanvasDocument(adapter), { etag: first.etag, canvas });
  assert.equal(first.version?.path, "canvas.json");
  const second = await writeCanvasDocument(adapter, { baseEtag: first.etag, canvas });
  assert.deepEqual(second, first);
  await assert.rejects(
    writeCanvasDocument(adapter, { baseEtag: null, canvas: empty() }),
    (error: unknown) => {
      assert.ok(error instanceof CanvasError);
      assert.equal(error.code, "ETAG_CONFLICT");
      assert.deepEqual(error.details?.current, { etag: first.etag, canvas });
      return true;
    },
  );
});

test("invalid canvas input, corrupt existing files and oversized UTF-8 leave bytes untouched", async (t) => {
  const { adapter } = await fixture(t);
  const first = await writeCanvasDocument(adapter, { baseEtag: null, canvas: empty() });
  const raw = await adapter.readFile("canvas.json");
  for (const canvas of [
    null,
    {},
    { ...empty(), version: 2 },
    { ...empty(), forms: { "node-x": "circle" } },
    { ...empty(), positions: { bad: {} } },
    { ...empty(), positions: { "@root": { "node-x": [1] } } },
    { ...empty(), positions: { "@root": { "node-x": [NaN, 1] } } },
    { ...empty(), drawings: [{ id: "d", kind: "pen" }] },
    { ...empty(), drawings: [{ id: "d", kind: "circle", node: null }] },
    {
      ...empty(),
      drawings: [{ id: "d", kind: "text", node: null, text: "画".repeat(CANVAS_LIMIT / 3) }],
    },
  ]) {
    await assert.rejects(
      async () => writeCanvasDocument(adapter, { baseEtag: first.etag, canvas }),
      { code: "INVALID_INPUT" },
    );
    assert.equal(await adapter.readFile("canvas.json"), raw);
  }
  await assert.rejects(
    async () => writeCanvasDocument(adapter, { baseEtag: undefined, canvas: empty() }),
    { code: "INVALID_INPUT" },
  );
  for (const bad of ["{", '{"version":2}', " ".repeat(CANVAS_LIMIT + 1)]) {
    await adapter.writeFile("canvas.json", bad);
    await assert.rejects(readCanvasDocument(adapter), { code: "INVALID_INPUT" });
    await assert.rejects(writeCanvasDocument(adapter, { baseEtag: first.etag, canvas: empty() }), {
      code: "INVALID_INPUT",
    });
    assert.equal(await adapter.readFile("canvas.json"), bad);
  }
});

test("canvas uses the workspace lock and detects another writer's saved ETag", async (t) => {
  const { adapter, systemRoot } = await fixture(t);
  await adapter.withLock(MUTATION_LOCK_PATH, async () => {
    await assert.rejects(
      writeCanvasDocument(new NodeFs(systemRoot), { baseEtag: null, canvas: empty() }),
      /mutation lock is still busy/,
    );
    assert.equal(await adapter.exists("canvas.json"), false);
  });
  const other = new NodeFs(systemRoot);
  const seen = await readCanvasDocument(other);
  const first = await writeCanvasDocument(adapter, { baseEtag: null, canvas: empty() });
  await assert.rejects(writeCanvasDocument(other, { baseEtag: seen.etag, canvas: empty() }), {
    code: "ETAG_CONFLICT",
  });
  assert.equal((await readCanvasDocument(other)).etag, first.etag);
});

test("a canvas exactly at 5 MiB saves without initializing Git; one more byte is rejected", async (t) => {
  const { root } = await fixture(t);
  const adapter = new NodeFs(path.join(root, "without-git"));
  const drawing = { id: "d", kind: "text", node: null, text: "" };
  const canvas = { ...empty(), drawings: [drawing] };
  drawing.text = "x".repeat(CANVAS_LIMIT - Buffer.byteLength(JSON.stringify(canvas) + "\n"));
  const saved = await writeCanvasDocument(adapter, { baseEtag: null, canvas });
  assert.equal(saved.version, undefined);
  assert.equal(await adapter.exists(".git"), false);
  assert.equal(Buffer.byteLength(await adapter.readFile("canvas.json")), CANVAS_LIMIT);
  assert.equal((await readCanvasDocument(adapter)).etag, saved.etag);
  drawing.text += "x";
  await assert.rejects(async () => writeCanvasDocument(adapter, { baseEtag: saved.etag, canvas }), {
    code: "INVALID_INPUT",
  });
  assert.equal((await readCanvasDocument(adapter)).etag, saved.etag);
});

test("layer forms are lowercase while Node IDs retain their case rules", async (t) => {
  const { root } = await fixture(t);
  const adapter = new NodeFs(path.join(root, "layer-forms"));
  for (const layer of ["node-x|BOX", "node-x|TREE", "node-x|Box", "node-x|tree|extra"]) {
    await assert.rejects(
      async () =>
        writeCanvasDocument(adapter, {
          baseEtag: null,
          canvas: { ...empty(), positions: { [layer]: { "node-y": [1, 2] } } },
        }),
      { code: "INVALID_INPUT" },
    );
    assert.equal(await adapter.exists("canvas.json"), false);
  }
  const canvas = {
    ...empty(),
    positions: { "NODE-X|box": { "NODE-Y": [1, 2] }, "node-x|tree": {} },
  };
  const saved = await writeCanvasDocument(adapter, { baseEtag: null, canvas });
  assert.deepEqual(await readCanvasDocument(adapter), { etag: saved.etag, canvas });
});

test("external corrupt canvas history retains bytes without Node identity in ranges, snapshots or capture", async (t) => {
  const { adapter, systemRoot } = await fixture(t);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)(
        "git",
        [
          "-C",
          systemRoot,
          "-c",
          "user.name=Canvas test",
          "-c",
          "user.email=canvas@example.invalid",
          ...args,
        ],
        { env, windowsHide: true },
      )
    ).stdout.trim();
  const commit = async (file: string, raw: string) => {
    await adapter.writeFile(file, raw);
    await git("add", "--", file);
    await git("commit", "-m", "External editor commit");
    return git("rev-parse", "HEAD");
  };
  const nodeRaw = "---\nid: node-x\ntype: prompt\n---\nOriginal Node\n";
  const nodeCommit = await commit("n/n.md", nodeRaw);
  const corruptCommit = await commit("canvas.json", nodeRaw);
  const all = await adapter.history.changesInRange({ to: corruptCommit });
  assert.deepEqual(
    all.flatMap((event) => event.objectIds),
    ["node-x"],
  );
  assert.deepEqual(all.at(-1)!.changes, [
    { after: { commit: corruptCommit, path: "canvas.json" } },
  ]);
  const changedRaw = nodeRaw + "External canvas edit\n";
  const changedCommit = await commit("canvas.json", changedRaw);
  const range = await adapter.history.changesInRange({ from: corruptCommit, to: changedCommit });
  assert.deepEqual(range[0]!.objectIds, []);
  assert.deepEqual(range[0]!.changes, [
    {
      before: { commit: corruptCommit, path: "canvas.json" },
      after: { commit: changedCommit, path: "canvas.json" },
    },
  ]);
  const version = { commit: changedCommit, path: "canvas.json" };
  assert.equal((await readDocumentVersion(adapter, version)).raw, changedRaw);
  const [read, sharedCanvas, sharedNode] = await adapter.history.readVersions([
    version,
    { commit: corruptCommit, path: "canvas.json" },
    { commit: nodeCommit, path: "n/n.md" },
  ]);
  assert.ok(read && !(read instanceof Error));
  assert.equal(read.frontmatter, undefined);
  assert.ok(sharedCanvas && !(sharedCanvas instanceof Error));
  assert.ok(sharedNode && !(sharedNode instanceof Error));
  assert.equal(sharedCanvas.raw, sharedNode.raw);
  assert.equal(sharedCanvas.frontmatter, undefined);
  assert.equal(sharedNode.frontmatter?.id, "node-x");
  assert.match(
    (
      await readDocumentDiff(adapter, {
        from: { commit: corruptCommit, path: "canvas.json" },
        to: version,
      })
    ).text,
    /External canvas edit/,
  );
  await assert.rejects(readCanvasDocument(adapter), { code: "INVALID_INPUT" });

  // A cache from the old implementation at this exact HEAD must be rebuilt too.
  const oldValue = (await adapter.history.changesInRange({ to: changedCommit })).map((event) => ({
    ...event,
    changes: event.changes.filter(
      (change) => (change.after ?? change.before)?.path !== "canvas.json",
    ),
  }));
  await fs.writeFile(
    path.join(systemRoot, ".git/tent-derived-identity-events.json"),
    JSON.stringify({
      version: 3,
      head: changedCommit,
      value: oldValue,
      digest: createHash("sha256").update(JSON.stringify(oldValue)).digest("hex"),
    }),
  );
  const fresh = new NodeFs(systemRoot);
  assert.deepEqual((await fresh.history.changesInRange()).at(-1)!.changes, range[0]!.changes);
  const snapshot = await buildSnapshot({
    fs: fresh,
    workspace: { id: "ws-canvas", name: "Canvas" },
    revision: "test",
  });
  assert.deepEqual(
    snapshot.nodes.map((node) => node.id),
    ["node-x"],
  );
  const nodeVersions = await fresh.history.nodeVersions("node-x");
  assert.equal(nodeVersions.length, 1);
  assert.equal(nodeVersions[0]!.commit, nodeCommit);
  assert.deepEqual(nodeVersions[0]!.changes, [
    { objectId: "node-x", after: { commit: nodeCommit, path: "n/n.md" } },
  ]);

  // Generic file writes retain malformed preimages without adding Tent-Object trailers.
  for (const raw of [nodeRaw.replace("node-x", "node-forged"), JSON.stringify(empty())]) {
    await withTentMutation(fresh, () => fresh.writeFile("canvas.json", raw), {
      operation: "canvas.write",
    });
    assert.doesNotMatch(await git("log", "-1", "--format=%B"), /^Tent-Object:/m);
    const events = await fresh.history.changesInRange({ from: changedCommit });
    assert.ok(
      events.every(
        (event) =>
          event.objectIds.length === 0 && event.changes.every((change) => !change.objectId),
      ),
    );
  }
  assert.equal(
    (await readDocumentVersion(fresh, { commit: nodeCommit, path: "n/n.md" })).raw,
    nodeRaw,
  );
});

test("canvas participates in revision, history, diff, external preimage capture and complete export", async (t) => {
  const { adapter, workspace, systemRoot } = await fixture(t);
  const initialRevision = await readWorkspaceRevision(adapter);
  const first = await writeCanvasDocument(adapter, { baseEtag: null, canvas: empty() });
  const firstRaw = await adapter.readFile("canvas.json");
  const savedRevision = await readWorkspaceRevision(adapter);
  assert.notEqual(savedRevision, initialRevision);
  const external = JSON.stringify({ ...empty(), forms: { "node-absent": "tree" } });
  await adapter.writeFile("canvas.json", external);
  assert.notEqual(await readWorkspaceRevision(adapter), savedRevision);
  const second = await writeCanvasDocument(adapter, {
    baseEtag: (await readCanvasDocument(adapter)).etag,
    canvas: empty(),
  });
  assert.equal((await readDocumentVersion(adapter, first.version)).raw, firstRaw);
  const changes = await adapter.history.changesInRange({ from: first.version!.commit });
  assert.deepEqual(
    changes.map((c) => c.operation),
    ["document.external-capture", "canvas.write"],
  );
  assert.ok(changes.every((c) => c.changes.some((change) => change.after?.path === "canvas.json")));
  const externalVersion = changes[0]!.changes[0]!.after!;
  assert.equal((await readDocumentVersion(adapter, externalVersion)).raw, external);
  assert.match(
    (await readDocumentDiff(adapter, { from: externalVersion, to: second.version })).text,
    /node-absent/,
  );
  assert.ok(changes.every((c) => c.objectIds.length === 0));
  const destination = path.join(workspace, ".scratch", "export");
  await exportGraph(
    { workspaceRoot: workspace, systemRoot, workspaceId: "ws-canvas", env: { fs: adapter } },
    { outputDir: destination },
  );
  assert.equal(await fs.readFile(path.join(destination, ".tent", "canvas.json"), "utf8"), firstRaw);
  await adapter.remove("canvas.json");
  assert.deepEqual(await readCanvasDocument(adapter), { etag: null, canvas: null });
  assert.equal((await readDocumentVersion(adapter, first.version)).raw, firstRaw);
});
