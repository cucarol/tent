import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteDocumentHistory } from "../src/core/store/sqlite-history.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadStopMaterialIndex } from "../src/fs/stop-material-index.js";
import { sectionFingerprints, sectionKey } from "../src/core/return/section-fingerprint.js";
import { changedSections, replaceRecord } from "../src/fs/section-fingerprints.js";
import { saveTurnDirty, saveTurnRecord, readTurnRecord } from "../src/fs/turn-review-state.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";
import { initializeGitIgnoreContext } from "../src/fs/git-ignore-context.js";

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
    "---\nid: node-alpha\ntype: prompt\nverified: {by: human:cuca}\nsources: [{resource: '../../guide.md#Rules'}]\n---\nDurable rules\n";
  const captured = await history.captureUnlocked([{ path: "Alpha/Alpha.md", raw }]);
  await history.close();
  await initializeGitIgnoreContext(root);
  await fs.mkdir(path.join(root, "Alpha"));
  await fs.writeFile(path.join(root, "Alpha/Alpha.md"), raw);
  await fs.writeFile(path.join(root, "index.md"), '---\nokf_version: "0.2"\n---\n');
  const guide = "# Rules\nOriginal section\n";
  await fs.writeFile(path.join(workspace, "guide.md"), guide);
  await replaceRecord(root, "guide.md", [
    { heading: "Rules", ...sectionFingerprints(guide, [{ heading: "Rules" }]).get("Rules")! },
  ]);
  const turn = {
    turnId: "turn-before",
    checkout: workspace,
    baseline: { startedAt: 123, head: null },
  };
  await saveTurnRecord(root, "codex", "session", "turn-before", turn);
  await saveTurnDirty(root, "codex", "session", workspace, ["guide.md"]);
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

test("record migration clears the managed observation cache, preserves Hook baselines and cold rebuilds the current graph", async (t) => {
  const f = await fixture(t);
  const baseline = await files(path.join(f.root, "temp"));
  const ignored = await files(path.join(f.root, ".git/ignore-context"));
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
  assert.deepEqual(await files(path.join(f.root, ".git/ignore-context")), ignored);
  assert.deepEqual(await fs.readFile(path.join(f.root, "Alpha/Alpha.md")), live);
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/keep.txt")), keep);
  assert.deepEqual(await readTurnRecord(f.root, "codex", "session", "turn-before"), f.turn);

  const adapter = new NodeFs(f.root);
  try {
    const index = await loadStopMaterialIndex(f.root, f.workspace, [], adapter);
    assert.deepEqual(
      index.nodes.map((node) => node.nodeId),
      ["node-alpha"],
    );
    assert.ok(
      index.nodes[0].materialFiles.some(
        (file) => file.path === "guide.md" && file.heading === "Rules",
      ),
    );
    assert.equal(await adapter.history.read(f.version), f.raw);
    assert.equal((await adapter.history.nodeVersions("node-alpha")).length, 1);
  } finally {
    await adapter.close();
  }
  const prepared = JSON.parse(
    await fs.readFile(path.join(f.cache, "stop-material-index.json"), "utf8"),
  );
  assert.equal(prepared.schema, 14);
  assert.ok(prepared.repository, "cold rebuild retains current prepared repository facts");
  assert.equal("materials" in prepared.repository.value, false);
  assert.equal("structureTexts" in prepared.repository.value, false);
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

  // The preserved SessionStart baseline still detects a later section edit.
  await fs.writeFile(path.join(f.workspace, "guide.md"), "# Rules\nChanged section\n");
  const section = { path: "guide.md", heading: "Rules" };
  assert.equal(
    (
      await changedSections(
        f.root,
        f.workspace,
        new Map([[sectionKey(section.path, section.heading), section]]),
      )
    ).size,
    1,
  );
});

test("a failed copied-database migration preserves old observation caches and Hook baselines", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.filename);
  db.exec("DROP TABLE unportable_records");
  db.close();
  const before = await files(f.root);
  await assert.rejects(removeNodeRecordsHistory(f.workspace), /no such table: unportable_records/);
  assert.deepEqual(await files(f.root), before);
});
