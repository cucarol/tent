import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteDocumentHistory } from "../src/fs/sqlite-history.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadStopCoverage } from "../src/fs/stop-coverage.js";
import { sectionFingerprints, sectionKey } from "../src/core/return/section-fingerprint.js";
import { changedSections, settleSections } from "../src/fs/section-fingerprints.js";

import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";

const { removeNodeRecordsHistory } = await import(
  new URL("../scripts/one-off/remove-node-records-history.mjs", import.meta.url).href
);

async function files(root: string) {
  const result = new Map();
  for (const relative of await fs.readdir(root, { recursive: true })) {
    const filename = path.join(root, relative);
    const state = await fs.stat(filename, { bigint: true });
    if (state.isFile())
      result.set(relative, {
        bytes: await fs.readFile(filename),
        mtime: state.mtimeNs,
        ctime: state.ctimeNs,
      });
  }
  return result;
}

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "rc-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  initializeFixtureRepository(workspace);
  const root = path.join(workspace, ".tent");
  const history = new SqliteDocumentHistory(root);
  await history.initialize();
  const raw =
    "---\nid: node-alpha\ntype: prompt\nprovenance: {by: human:cuca}\nsources: [{resource: '../../guide.md#Rules'}]\n---\nDurable rules\n";
  const captured = await history.captureUnlocked([{ path: "Alpha/Alpha.md", raw }]);
  await history.close();
  await fs.mkdir(path.join(root, ".git/unrelated-data"));
  await fs.writeFile(path.join(root, ".git/unrelated-data/keep.bin"), "opaque sibling data");
  await fs.mkdir(path.join(root, "Alpha"));
  await fs.writeFile(path.join(root, "Alpha/Alpha.md"), raw);
  await fs.writeFile(path.join(root, "index.md"), '---\nokf_version: "0.2"\n---\n');
  const guide = "# Rules\nOriginal section\n";
  await fs.writeFile(path.join(workspace, "guide.md"), guide);
  const rules = {
    path: "guide.md",
    heading: "Rules",
    ...sectionFingerprints(guide, [{ heading: "Rules" }]).get("Rules")!,
  };
  await settleSections(root, workspace, {
    changed: new Map(),
    observed: new Map([["guide.md#Rules", rules]]),
  });
  const turn = {
    turnId: "turn-before",
    checkout: workspace,
    baseline: { startedAt: 123, head: null },
  };
  await fs.mkdir(path.join(root, "temp/turn-reviews"), { recursive: true });
  await fs.writeFile(path.join(root, "temp/turn-reviews/old-turn.json"), JSON.stringify(turn));
  await fs.writeFile(
    path.join(root, "temp/turn-reviews/old-turn.dirty.json"),
    JSON.stringify({ checkout: workspace, paths: ["guide.md"] }),
  );
  await fs.writeFile(path.join(root, ".git/keep.txt"), "unrelated sibling bytes");
  const filename = path.join(root, ".git/history.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA user_version=1;
    CREATE TABLE records(event INTEGER NOT NULL REFERENCES events(seq),id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(event,id)) STRICT;
    CREATE TABLE unportable_records(id TEXT PRIMARY KEY) STRICT;`);
  db.close();
  const cache = path.join(root, ".git/tent-material-cache");
  await fs.mkdir(path.join(cache, "leftover"), { recursive: true });
  const marker = "retired-node-material-observation";
  await fs.writeFile(
    path.join(cache, "file-state.json"),
    JSON.stringify({
      schema: 2,
      entries: {
        [`material:${JSON.stringify([path.join(workspace, "guide.md"), "structure-source-text-v1"])}`]:
          { value: { observedVersion: marker, text: marker } },
      },
    }),
  );
  await fs.writeFile(
    path.join(cache, "stop-material-index.json"),
    JSON.stringify({
      schema: 13,
      repository: {
        value: {
          materials: [[marker, { observedVersion: marker }]],
          structureTexts: [[marker, marker]],
        },
      },
    }),
  );
  for (const name of [
    "structure-derived.bin",
    "history-index.sqlite",
    "document-headers.bin",
    "semantic-content.bin",
    "markdown-syntax.bin",
    "leftover/structure-derived.bin.pending.tmp",
  ])
    await fs.writeFile(path.join(cache, name), marker);
  return { workspace, root, raw, version: captured.versions[0]!, filename, cache, marker, turn };
}

test("record migration clears managed caches, preserves temp and immutable history, and rebuilds Stop coverage", async (t) => {
  const f = await fixture(t);
  const baseline = await files(path.join(f.root, "temp"));
  const unrelated = await files(path.join(f.root, ".git/unrelated-data"));
  const live = await fs.readFile(path.join(f.root, "Alpha/Alpha.md"));
  const keep = await fs.readFile(path.join(f.root, ".git/keep.txt"));
  assert.deepEqual(await removeNodeRecordsHistory(f.workspace), {
    changed: true,
    metadata: 0,
    trailers: 0,
    records: 0,
    unportableRecords: 0,
  });
  await assert.rejects(fs.access(f.cache), { code: "ENOENT" });
  assert.deepEqual(await files(path.join(f.root, "temp")), baseline);
  assert.deepEqual(await files(path.join(f.root, ".git/unrelated-data")), unrelated);
  assert.deepEqual(await fs.readFile(path.join(f.root, "Alpha/Alpha.md")), live);
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/keep.txt")), keep);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.root, "temp/turn-reviews/old-turn.json"), "utf8")),
    f.turn,
  );

  const adapter = new NodeFs(f.root);
  try {
    const index = await loadStopCoverage(f.root, f.workspace, adapter);
    assert.deepEqual(
      index.nodes.map((node) => node.nodeId),
      ["node-alpha"],
    );
    assert.ok(
      index.nodes[0]!.materials.some(
        (material) =>
          material.kind === "file" && material.path === "guide.md" && material.heading === "Rules",
      ),
    );
    assert.deepEqual(await loadStopCoverage(f.root, f.workspace, adapter), index);
    assert.equal(await adapter.history.currentCommit(), f.version.commit);
    assert.equal(await adapter.history.read(f.version), f.raw);
    const versions = await adapter.history.nodeVersions("node-alpha");
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.commit, f.version.commit);
  } finally {
    await adapter.close();
  }
  const rebuilt = JSON.parse(await fs.readFile(path.join(f.cache, "stop-coverage.json"), "utf8"));
  assert.equal(rebuilt.schema, 1);
  assert.equal(rebuilt.headers.length, 1);
  assert.equal(rebuilt.headers[0][0], "Alpha/Alpha.md");
  assert.equal("repository" in rebuilt, false);
  await assert.rejects(fs.access(path.join(f.cache, "stop-material-index.json")), {
    code: "ENOENT",
  });
  for (const [name, { bytes }] of await files(f.cache)) {
    assert.equal(bytes.includes(Buffer.from(f.marker)), false, name);
    if (name === "file-state.json") {
      const saved = JSON.parse(bytes.toString());
      assert.equal(
        Object.keys(saved.entries).some((key) => key.startsWith("material:")),
        false,
      );
    }
  }
  await assert.rejects(fs.access(path.join(f.cache, "structure-derived.bin")), { code: "ENOENT" });
  assert.deepEqual(await files(path.join(f.root, "temp")), baseline);
  const unchanged = await files(f.root);
  assert.deepEqual(await removeNodeRecordsHistory(f.workspace), {
    changed: false,
    metadata: 0,
    trailers: 0,
    records: 0,
    unportableRecords: 0,
  });
  assert.deepEqual(await files(f.root), unchanged);

  // The preserved section baseline still detects a later Stop section edit.
  await fs.writeFile(path.join(f.workspace, "guide.md"), "# Rules\nChanged section\n");
  const section = { path: "guide.md", heading: "Rules" };
  assert.equal(
    (
      await changedSections(
        f.root,
        f.workspace,
        new Map([[sectionKey(section.path, section.heading), section]]),
      )
    ).changed.size,
    1,
  );
});

test("a failed copied-database migration preserves every cache, temp record and immutable history byte", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.filename);
  db.exec("DROP TABLE unportable_records");
  db.close();
  const before = await files(f.root);
  await assert.rejects(removeNodeRecordsHistory(f.workspace), /no such table: unportable_records/);
  assert.deepEqual(await files(f.root), before);
});
