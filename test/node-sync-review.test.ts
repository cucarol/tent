import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { observeMaterialResource } from "../src/fs/source-observation.js";
import { GitDocumentHistory } from "../src/core/git-history.js";
import {
  retainedSemanticVersions,
  reinterpretNodeBasisRecords,
} from "../src/core/node-semantic-history.js";
import { historicalNodeCatalog } from "../src/core/node-semantic-history.js";
import {
  nodeMaterialFingerprint,
  prepareNodeSyncSave,
  syncMaterialIdentity,
} from "../src/core/node-sync-record.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import type { NodeBasisRecord } from "../src/core/node-basis-record.js";
import { testScratchRoot } from "./scratch.js";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
async function scratch(t: TestContext) {
  const root = await mkdtemp(path.join(testScratchRoot(), "sync-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("review fix: an external Node URI keeps its semantic version when its consumer moves", async (t) => {
  const root = await scratch(t);
  const filename = path.join(root, "foreign", ".tent", "P", "P.md");
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(
    filename,
    serializeFrontmatter(
      { id: "node-p", type: "prompt", sources: [{ resource: "./ref.md" }] },
      "## Scope\n[ref](./ref.md)\n",
    ),
  );
  for (const suffix of ["", "#Scope"]) {
    const uri = pathToFileURL(filename).href + suffix;
    const before = await observeMaterialResource(root, "G/G.md", uri, path.join(root, "cache"));
    const moved = await observeMaterialResource(
      root,
      "Moved/G/G.md",
      uri,
      path.join(root, "cache"),
    );
    assert.equal(moved.observedVersion, before.observedVersion);
    assert.equal(moved.cacheHit, true);
  }
});

test("review fix: ordinary Markdown with malformed YAML remains observable text", async (t) => {
  const root = await scratch(t);
  const filename = path.join(root, "ordinary.md");
  const raw = "---\r\nlabel: [\r\n---\r\nordinary body\r\n";
  await writeFile(filename, raw);
  const observed = await observeMaterialResource(root, "G/G.md", pathToFileURL(filename).href);
  assert.equal(observed.observedVersion, hash(raw.replace(/\r\n/g, "\n")));
  assert.ok(observed.legacyVersions?.includes(hash(raw)));
});

test("review fix: foreign file URI legacy receipts never borrow same-suffix local Node history", async (t) => {
  const root = await scratch(t);
  const systemRoot = path.join(root, "own", ".tent");
  const history = new GitDocumentHistory(systemRoot);
  const localUri = pathToFileURL(path.join(systemRoot, "P", "P.md")).href;
  const foreignUri = pathToFileURL(path.join(root, "foreign", ".tent", "P", "P.md")).href;
  assert.equal(history.localFileUriDocumentPath(localUri), "P/P.md");
  assert.equal(history.localFileUriDocumentPath(foreignUri), undefined);
  assert.equal(
    history.localFileUriDocumentPath(
      pathToFileURL(path.join(systemRoot + "-other", "P", "P.md")).href,
    ),
    undefined,
  );
  const raw = serializeFrontmatter({ id: "node-p", type: "prompt" }, "local baseline\n");
  const commit = "a".repeat(40),
    version = { commit, path: "P/P.md" };
  const localIdentity = JSON.stringify(["uri", localUri]);
  const foreignIdentity = JSON.stringify(["uri", foreignUri]);
  const record: NodeBasisRecord = {
    materials: [
      { identity: localIdentity, version: hash(raw) },
      { identity: foreignIdentity, version: hash(raw) },
    ],
  };
  t.mock.method(
    history,
    "derived",
    async <T>(
      _name: string,
      _schemaVersion: number,
      compute: (head: string | null) => Promise<T>,
    ) => compute(commit),
  );
  t.mock.method(history, "changesInRange", async () => [
    {
      commit,
      time: "2026-10-06T00:00:00Z",
      objectIds: ["node-p"],
      changes: [{ objectId: "node-p", after: version }],
    },
  ]);
  t.mock.method(history, "nodeRecordEvents", async () => ({
    [commit]: { "node-consumer": record },
  }));
  t.mock.method(history, "readVersions", async () => [{ version, raw, changedSince: false }]);
  const interpreted = reinterpretNodeBasisRecords(
    { "node-consumer": record },
    await retainedSemanticVersions(history),
  )["node-consumer"]!;
  assert.equal(
    interpreted.materials[0]!.fingerprintVersion,
    2,
    "proved local URI can use retained bytes",
  );
  assert.deepEqual(
    interpreted.materials[1],
    record.materials[1],
    "foreign baseline stays unknown despite identical suffix and raw digest",
  );
});

test("review fix: a batch URI confirmation uses final upstream sections and records goal material change", async (t) => {
  const root = await scratch(t),
    systemRoot = path.join(root, ".tent");
  const upstream = serializeFrontmatter(
    { id: "node-p", type: "prompt" },
    "## Scope\nold requirement\n",
  );
  const finalUpstream = upstream.replace("old requirement", "new requirement");
  const resource = pathToFileURL(path.join(systemRoot, "P", "P.md")).href + "#Scope";
  const goal = serializeFrontmatter(
    { id: "node-g", type: "goal", sources: [{ resource }] },
    "goal\n",
  );
  const nodes = historicalNodeCatalog(
    new Map([
      ["node-p", { path: "P", raw: finalUpstream }],
      ["node-g", { path: "G", raw: goal }],
    ]),
  );
  const locator = {
    kind: "path" as const,
    anchor: "bundle" as const,
    target: "P/P.md",
    suffix: "#Scope",
  };
  const previous: NodeBasisRecord = {
    materials: [
      {
        identity: syncMaterialIdentity(resource, "G/G.md", nodes),
        version: nodeMaterialFingerprint(upstream, locator, nodes),
        fingerprintVersion: 2,
      },
    ],
  };
  let diskReads = 0,
    observations = 0;
  const adapter = new NodeFs(systemRoot);
  t.mock.method(adapter, "readFile", async () => {
    diskReads++;
    return upstream;
  });
  t.mock.method(adapter, "observeMaterial", async () => {
    observations++;
    return { systemPath: "P/P.md", observedVersion: hash(upstream) };
  });
  const prepared = await prepareNodeSyncSave(adapter, "G/G.md", goal, {
    confirm: true,
    now: "2026-10-06T00:00:00Z",
    records: { "node-g": previous },
    nodes,
    finalDocuments: new Map([["P/P.md", finalUpstream]]),
  });
  assert.equal(
    prepared.record.materials[0]!.version,
    nodeMaterialFingerprint(finalUpstream, locator, nodes),
  );
  assert.ok(prepared.record.materialsRevision);
  assert.equal(diskReads, 0);
  assert.equal(observations, 0, "planned URI target does not need to exist on disk yet");
});

test("historical root Nodes have no parent and independent outputs have no goal", async () => {
  const { historicalNodeCatalog } = await import("../src/core/node-semantic-history.js");
  const { nearestGoal } = await import("../src/core/node-sync-record.js");
  const catalog = historicalNodeCatalog(
    new Map([
      ["node-root", { path: "Root", raw: "---\nid: node-root\ntype: prompt\n---\ngroup" }],
      ["node-out", { path: "Out", raw: "---\nid: node-out\ntype: output\n---\nresult" }],
      ["node-child", { path: "Root/Child", raw: "---\nid: node-child\ntype: output\n---\nresult" }],
    ]),
  );
  assert.equal(catalog.get("node-root")!.parentNodeId, null);
  assert.equal(catalog.get("node-out")!.parentNodeId, null);
  assert.equal(nearestGoal(catalog.get("node-out")!, catalog), undefined);
  assert.equal(nearestGoal(catalog.get("node-child")!, catalog), undefined);
});
