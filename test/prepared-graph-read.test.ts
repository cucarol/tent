import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  documentHeader,
  loadNodeCatalog,
  readCatalogDocument,
} from "../src/core/graph/node-catalog.js";
import type { ObservationOptions } from "../src/core/store/adapter.js";
import { sqliteContentFingerprint } from "../src/core/store/sqlite-history.js";
import type { NodeFs } from "../src/fs/node-fs.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { readCache } from "../src/fs/prepared-graph.js";
import { findPreparedHookWorkspace } from "../src/fs/hook-material-index.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "prepared-graph-read-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"), { recursive: true });
  await fs.writeFile(path.join(systemRoot, "index.md"), '---\nokf_version: "0.2"\n---\n');
  const node = async (directory: string, id: string, body = "Original body café") => {
    const filename = `${directory}/${path.posix.basename(directory)}.md`;
    const raw = `---\nid: ${id}\ntype: goal\n---\n\n## Résumé\n${body}\n`;
    await fs.mkdir(path.join(systemRoot, directory), { recursive: true });
    await fs.writeFile(path.join(systemRoot, filename), raw);
    return raw;
  };
  const raw = await node("A", "node-a");
  await node("A/Child", "node-child");
  // Keep observations outside the timestamp safety window without real sleeps.
  const now = Date.now() + 10_000;
  t.mock.method(Date, "now", () => now);
  const adapter = openTestFs(systemRoot);
  return {
    root,
    systemRoot,
    adapter,
    node,
    raw,
    filename: path.join(systemRoot, "A/A.md"),
    cacheFile: path.join(systemRoot, ".git/tent-material-cache/stop-material-index.json"),
    prepare: () => loadStopMaterialIndex(systemRoot, root, [], adapter),
  };
}

function sourceOpens(t: TestContext, filename: string) {
  let count = 0;
  const open = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    if (path.resolve(String(args[0])) === path.resolve(filename)) count++;
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return () => count;
}

async function readGraph(adapter: NodeFs, options?: ObservationOptions) {
  return adapter.observationScope(async () => {
    const catalog = await loadNodeCatalog(adapter);
    const documents = [];
    for (const node of catalog.byPath.values()) {
      documents.push(await readCatalogDocument(adapter, node));
    }
    return documents;
  }, options);
}

const sourceDigest = (cached: Record<string, unknown>) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        cached.writtenAtNs,
        cached.directories,
        cached.headers,
        cached.rootMarkerDigest,
        cached.rejectedRootMarkers,
        cached.repository ?? null,
      ]),
    )
    .digest("hex");

test("preparer and both readers reject the two superseded schema 11 shapes", async (t) => {
  const f = await fixture(t);
  const expected = await f.prepare();
  const current = await fs.readFile(f.cacheFile, "utf8");
  assert.equal(JSON.parse(current).schema, 13);
  assert.ok(await readCache(f.cacheFile, f.root));
  assert.ok(await findPreparedHookWorkspace(f.root));
  for (const shape of ["read", "hook"] as const) {
    const old = JSON.parse(current);
    old.schema = 11;
    if (shape === "read") {
      for (const node of old.index.nodes) {
        delete node.ruleNodeIds;
        delete node.headerDigest;
      }
      old.sourceDigest = sourceDigest(old);
    } else {
      for (const [, header] of old.headers) delete header.raw;
      delete old.repository;
      old.sourceDigest = createHash("sha256")
        .update(
          JSON.stringify([
            old.writtenAtNs,
            old.directories,
            old.headers,
            old.rootMarkerDigest,
            old.rejectedRootMarkers,
          ]),
        )
        .digest("hex");
    }
    old.indexDigest = createHash("sha256")
      .update(JSON.stringify([old.rootMarkerDigest, old.rejectedRootMarkers, old.index]))
      .digest("hex");
    await fs.writeFile(f.cacheFile, JSON.stringify(old));
    assert.equal(await readCache(f.cacheFile, f.root), undefined, shape);
    assert.equal(await findPreparedHookWorkspace(f.root), undefined, shape);
    assert.deepEqual(await f.prepare(), expected, shape);
    assert.equal(JSON.parse(await fs.readFile(f.cacheFile, "utf8")).schema, 13, shape);
  }
});

test("state semantics invalidate schema 12 even with unchanged headers and valid digests", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.filename, f.raw.replace("type: goal", "type: goal\nstatus: draft"));
  const expected = await f.prepare();
  assert.ok(expected.nodes.some((node) => node.nodeId === "node-a"));
  const old = JSON.parse(await fs.readFile(f.cacheFile, "utf8"));
  old.schema = 12;
  // Previous semantics excluded draft Nodes without changing their observed headers.
  old.index.nodes = old.index.nodes.filter((node: { nodeId: string }) => node.nodeId !== "node-a");
  old.indexDigest = createHash("sha256")
    .update(JSON.stringify([old.rootMarkerDigest, old.rejectedRootMarkers, old.index]))
    .digest("hex");
  const oldBytes = JSON.stringify(old);
  await fs.writeFile(f.cacheFile, oldBytes);
  assert.deepEqual(await f.prepare(), expected);
  await fs.writeFile(f.cacheFile, oldBytes);
  assert.equal(await readCache(f.cacheFile, f.root), undefined);
  assert.equal(await findPreparedHookWorkspace(f.root), undefined);
  assert.deepEqual(await f.prepare(), expected);
  assert.equal(JSON.parse(await fs.readFile(f.cacheFile, "utf8")).schema, 13);
  assert.ok(await readCache(f.cacheFile, f.root));
  assert.ok(await findPreparedHookWorkspace(f.root));
});

test("prepared graph reuses full Node bytes without changing catalog documents or fingerprints", async (t) => {
  const f = await fixture(t);
  const expected = await readGraph(f.adapter, { forceContent: true });
  await f.prepare();
  const opens = sourceOpens(t, f.filename);
  const directories = t.mock.method(fs, "readdir");
  syncBuiltinESMExports();
  t.after(() => {
    directories.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual(await readGraph(openTestFs(f.systemRoot)), expected);
  const adapter = openTestFs(f.systemRoot);
  await adapter.observationScope(async () => {
    assert.equal(await adapter.readFile("A/A.md"), f.raw);
    assert.deepEqual(await adapter.readFrontmatterWithFingerprint("A/A.md"), {
      content: documentHeader(f.raw),
      fingerprint: sqliteContentFingerprint(f.raw),
    });
  });
  assert.equal(opens(), 0, "fresh adapters must reuse prepared bodies, not just frontmatter");
  assert.ok(
    directories.mock.calls.every(
      (call) =>
        !["A", "A/Child"].some(
          (directory) =>
            path.resolve(String(call.arguments[0])) === path.join(f.systemRoot, directory),
        ),
    ),
    "unchanged Node directories must reuse their prepared topology",
  );
});

test("prepared Node body and header expire after same-size edits with restored mtime", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const previous = await fs.stat(f.filename);
  const bodyEdit = f.raw.replace("Original body", "Modified body");
  assert.equal(Buffer.byteLength(bodyEdit), Buffer.byteLength(f.raw));
  await fs.writeFile(f.filename, bodyEdit);
  await fs.utimes(f.filename, previous.atime, previous.mtime);
  const documents = await readGraph(openTestFs(f.systemRoot));
  assert.equal(documents.find((node) => node.nodeId === "node-a")?.raw, bodyEdit);
  await f.prepare();
  const headerEdit = bodyEdit.replace("node-a", "node-b");
  await fs.writeFile(f.filename, headerEdit);
  await fs.utimes(f.filename, previous.atime, previous.mtime);
  const changed = await readGraph(openTestFs(f.systemRoot));
  assert.ok(!changed.some((node) => node.nodeId === "node-a"));
  assert.equal(changed.find((node) => node.nodeId === "node-b")?.raw, headerEdit);
});

test("a prepared scope rechecks Node bytes when an external body edit happens inside it", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  await f.adapter.observationScope(async () => {
    assert.equal(await f.adapter.readFile("A/A.md"), f.raw);
    const changed = f.raw.replace("Original body", "Modified body");
    const previous = await fs.stat(f.filename);
    await fs.writeFile(f.filename, changed);
    await fs.utimes(f.filename, previous.atime, previous.mtime);
    assert.equal(await f.adapter.readFile("A/A.md"), changed);
    assert.deepEqual(await f.adapter.readFrontmatterWithFingerprint("A/A.md"), {
      content: documentHeader(changed),
      fingerprint: sqliteContentFingerprint(changed),
    });
  });
});

test("prepared graph topology expires after nested Node addition and removal", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const added = await f.node("A/Added", "node-added", "Newly discovered body");
  const documents = await readGraph(openTestFs(f.systemRoot));
  assert.equal(documents.find((node) => node.nodeId === "node-added")?.raw, added);
  await f.prepare();
  await fs.rm(path.join(f.systemRoot, "A/Child"), { recursive: true });
  const remaining = await readGraph(openTestFs(f.systemRoot));
  assert.ok(!remaining.some((node) => node.nodeId === "node-child"));
  assert.equal(remaining.find((node) => node.nodeId === "node-added")?.raw, added);
});

test("forceContent and writer scopes read source bytes inside a surrounding prepared scope", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const opens = sourceOpens(t, f.filename);
  await f.adapter.observationScope(async () => {
    assert.equal(await f.adapter.readFile("A/A.md"), f.raw);
    assert.equal(opens(), 0);
    await f.adapter.observationScope(
      async () => {
        assert.equal(await f.adapter.readFile("A/A.md"), f.raw);
      },
      { forceContent: true },
    );
    assert.ok(opens() > 0, "forced observations must inspect source bytes");
    const beforeWriter = opens();
    await f.adapter.withLock("mutation.lock", async () => {
      assert.equal(await f.adapter.readFile("A/A.md"), f.raw);
    });
    assert.ok(opens() > beforeWriter, "writer reads must discard prepared body observations");
    const changed = f.raw.replace("Original body", "Modified body");
    await fs.writeFile(f.filename, changed);
    await f.adapter.withLock("mutation.lock", async () => {
      assert.equal(await f.adapter.readFile("A/A.md"), changed);
    });
  });
});

test("writer graph observations do not reenter prepared body reuse", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const opens = sourceOpens(t, f.filename);
  await f.adapter.withLock("mutation.lock", async () => {
    const documents = await readGraph(f.adapter);
    assert.equal(documents.find((node) => node.nodeId === "node-a")?.raw, f.raw);
  });
  assert.ok(opens() > 0, "a writer's nested catalog scope must read current Node bytes");
});

test("missing, obsolete and corrupt prepared caches fall back to current graph documents", async (t) => {
  const f = await fixture(t);
  const expected = await readGraph(f.adapter, { forceContent: true });
  await f.prepare();
  const valid = await fs.readFile(f.cacheFile, "utf8");
  const opens = sourceOpens(t, f.filename);
  const variants: [string, string | undefined][] = [
    ["missing", undefined],
    ["malformed JSON", "broken JSON"],
    ["previous schema", JSON.stringify({ ...JSON.parse(valid), schema: 10 })],
    ["wrong workspace", JSON.stringify({ ...JSON.parse(valid), workspaceRoot: f.systemRoot })],
    ["forged body without matching digest", valid.replace("Original body", "Poisoned body")],
    ["damaged index digest", JSON.stringify({ ...JSON.parse(valid), indexDigest: "broken" })],
    [
      "incomplete topology",
      (() => {
        const cached = JSON.parse(valid);
        cached.headers.pop();
        cached.sourceDigest = sourceDigest(cached);
        return JSON.stringify(cached);
      })(),
    ],
  ];
  for (const [reason, content] of variants) {
    if (content === undefined) await fs.rm(f.cacheFile);
    else await fs.writeFile(f.cacheFile, content);
    const before = opens();
    assert.deepEqual(await readGraph(openTestFs(f.systemRoot)), expected, reason);
    assert.ok(opens() > before, `${reason} must read the actual Node body`);
  }
});

test("prepared records without full raw text and changed root markers fall back to source bytes", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const valid = await fs.readFile(f.cacheFile, "utf8");
  const cached = JSON.parse(valid);
  for (const [, record] of cached.headers) delete record.raw;
  cached.sourceDigest = sourceDigest(cached);
  await fs.writeFile(f.cacheFile, JSON.stringify(cached));
  const opens = sourceOpens(t, f.filename);
  await f.adapter.observationScope(async () => {
    assert.equal(await f.adapter.readFile("A/A.md"), f.raw);
    assert.deepEqual(await f.adapter.readFrontmatterWithFingerprint("A/A.md"), {
      content: documentHeader(f.raw),
      fingerprint: sqliteContentFingerprint(f.raw),
    });
  });
  assert.ok(opens() > 0, "a header-only record cannot stand in for the full body");
  await fs.writeFile(f.cacheFile, valid);
  await fs.writeFile(
    path.join(f.systemRoot, "index.md"),
    '---\nokf_version: "0.2"\ntitle: changed\n---\n',
  );
  const before = opens();
  assert.equal(
    (await readGraph(openTestFs(f.systemRoot))).find((node) => node.nodeId === "node-a")?.raw,
    f.raw,
  );
  assert.ok(opens() > before, "a different root marker invalidates prepared graph reuse");
});
