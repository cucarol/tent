import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  GitDocumentHistory,
  type HistoryCommit,
  type DocumentVersion,
} from "../src/core/git-history.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { materialContent } from "../src/core/material-section.js";
import { nodeMaterialFingerprint, nodeSemanticFingerprint } from "../src/core/node-sync-record.js";
import {
  historicalFingerprintReader,
  historicalFrontmatterReader,
  historicalNodeCatalog,
  retainedSemanticVersions,
} from "../src/core/node-semantic-history.js";
import { latestGoalAheadTimes } from "../src/core/node-ahead-history.js";
import type { NodeBasisRecord } from "../src/core/node-basis-record.js";

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const note = (id: string, type: string, body: string, metadata = {}) =>
  serializeFrontmatter({ id, type, ...metadata }, body);
const catalog = (rows: [string, string, string][]) =>
  historicalNodeCatalog(new Map(rows.map(([id, path, raw]) => [id, { path, raw }])));

test("history memo preserves the document directory for slash headings and follows referenced identity changes", () => {
  const raw = note("node-p", "prompt", "## A/B\n[ref](./Ref/Ref.md)\n");
  const ref = note("node-r", "prompt", "ref\n");
  const rows: [string, string, string][] = [
    ["node-p", "P", raw],
    ["node-r", "P/Ref", ref],
  ];
  const locator = {
    kind: "path" as const,
    anchor: "bundle" as const,
    target: "P/P.md",
    suffix: "#A/B",
  };
  const memo = historicalFingerprintReader<string>(historicalFrontmatterReader());
  const version = (nodes: ReturnType<typeof catalog>) =>
    memo(
      raw,
      locator.target,
      nodes,
      () => nodeMaterialFingerprint(raw, locator, nodes),
      locator.suffix,
    );
  const original = catalog(rows);
  assert.equal(version(original), nodeMaterialFingerprint(raw, locator, original));
  const unrelated = catalog([
    ...rows,
    ["node-other", "Other", note("node-other", "prompt", "other")],
  ]);
  assert.equal(version(unrelated), version(original));
  const replaced = catalog([rows[0]!, ["node-new", "P/Ref", note("node-new", "prompt", "ref")]]);
  assert.notEqual(version(replaced), version(original));
  assert.equal(version(replaced), nodeMaterialFingerprint(raw, locator, replaced));
});

test("history memo respects first matching path and independent section variants", () => {
  const raw = note("node-p", "prompt", "## One\n[ref](./Ref/Ref.md)\n## Two\nsecond\n");
  const nodes = catalog([
    ["node-p", "P", raw],
    ["node-first", "P/Ref", "first"],
    ["node-second", "P/Ref", "second"],
  ]);
  const memo = historicalFingerprintReader<string>(historicalFrontmatterReader());
  const version = (suffix: string) => {
    const locator = { kind: "path" as const, anchor: "bundle" as const, target: "P/P.md", suffix };
    return memo(
      raw,
      locator.target,
      nodes,
      () => nodeMaterialFingerprint(raw, locator, nodes),
      suffix,
    );
  };
  assert.notEqual(version("#One"), version("#Two"));
  const expected = nodeMaterialFingerprint(
    raw,
    { kind: "path", anchor: "bundle", target: "P/P.md", suffix: "#One" },
    nodes,
  );
  assert.equal(version("#One"), expected);
  const withoutFirst = catalog([
    ["node-p", "P", raw],
    ["node-second", "P/Ref", "second"],
  ]);
  assert.notEqual(
    expected,
    nodeMaterialFingerprint(
      raw,
      { kind: "path", anchor: "bundle", target: "P/P.md", suffix: "#One" },
      withoutFirst,
    ),
  );
});

test("legacy replay never borrows bytes acquired later, including unavailable sections", async (t) => {
  const initial = note("node-p", "prompt", "## A/B\nold\n");
  const later = note("node-p", "prompt", "## A/B\nlater\n");
  const locator = {
    kind: "path" as const,
    anchor: "bundle" as const,
    target: "P/P.md",
    suffix: "#A/B",
  };
  const old = digest(materialContent(initial, locator));
  const tooLate = digest(materialContent(later, locator));
  const record: NodeBasisRecord = {
    materials: [
      { identity: "node:node-p#A/B", version: old },
      { identity: JSON.stringify(["path", "P/P.md", "#A/B"]), version: tooLate },
      { identity: "node:node-p#Absent", version: digest("missing") },
    ],
  };
  const history = new GitDocumentHistory("unused");
  const commits = ["a", "b"].map((x) => x.repeat(40));
  t.mock.method(
    history,
    "derived",
    async <T>(_n: string, _v: number, compute: (head: string | null) => Promise<T>) =>
      compute(commits[1]!),
  );
  t.mock.method(history, "changesInRange", async () =>
    commits.map((commit, i) => ({
      commit,
      time: String(i),
      objectIds: ["node-p"],
      changes: [{ objectId: "node-p", after: { commit, path: "P/P.md" } }],
    })),
  );
  t.mock.method(history, "nodeRecordEvents", async () => ({
    [commits[0]!]: { "node-consumer": record },
  }));
  t.mock.method(history, "readVersions", async (versions: readonly DocumentVersion[]) =>
    versions.map((version) => ({
      version,
      raw: version.commit === commits[0] ? initial : later,
      changedSince: false,
    })),
  );
  const index = await retainedSemanticVersions(history);
  assert.equal(
    index.materials["node:node-p#A/B"]?.[old],
    nodeMaterialFingerprint(initial, locator, catalog([["node-p", "P", initial]])),
  );
  assert.equal(index.materials[JSON.stringify(["path", "P/P.md", "#A/B"])], undefined);
  assert.equal(index.materials["node:node-p#Absent"], undefined);
});

test("ahead replay keeps nearest goal ownership, metadata-stable times, and the latest transition", async (t) => {
  const rows: [string, string, string][] = [
    ["node-g", "G", note("node-g", "goal", "outer\n")],
    ["node-n", "G/N", note("node-n", "goal", "inner\n")],
    ["node-o", "G/N/O", note("node-o", "output", "output\n")],
  ];
  const nodes = catalog(rows);
  const initialParsed = parseFrontmatter(rows[1]![2]);
  const fingerprint = nodeSemanticFingerprint(
    initialParsed.data,
    initialParsed.body,
    "G/N/N.md",
    nodes,
  );
  const initial: NodeBasisRecord = {
    materials: [],
    goal: { nodeId: "node-n", version: fingerprint, fingerprintVersion: 2 },
  };
  const changed = note("node-n", "goal", "changed\n");
  const metadata = note("node-n", "goal-direction", "changed\n", { tags: ["metadata"] });
  const changedParsed = parseFrontmatter(changed);
  const current = nodeSemanticFingerprint(
    changedParsed.data,
    changedParsed.body,
    "G/N/N.md",
    nodes,
  );
  const events: HistoryCommit[] = Array.from({ length: 5 }, (_, i) => ({
    commit: String(i).repeat(40),
    time: `time-${i}`,
    objectIds: [],
    changes: [],
  }));
  events[0]!.changes = rows.map(([id, path]) => ({
    objectId: id,
    after: { commit: events[0]!.commit, path: `${path}/${path.split("/").at(-1)}.md` },
  }));
  for (const i of [1, 2, 4])
    events[i]!.changes = [
      { objectId: "node-n", after: { commit: events[i]!.commit, path: "G/N/N.md" } },
    ];
  const versions = new Map(
    rows.map(([, path, raw]) => [`${events[0]!.commit}:${path}/${path.split("/").at(-1)}.md`, raw]),
  );
  versions.set(`${events[1]!.commit}:G/N/N.md`, changed);
  versions.set(`${events[2]!.commit}:G/N/N.md`, metadata);
  versions.set(`${events[4]!.commit}:G/N/N.md`, note("node-n", "goal", "latest\n"));
  const history = new GitDocumentHistory("unused");
  const confirmedCommit = events[3]!.commit;
  t.mock.method(
    history,
    "derived",
    async <T>(_n: string, _v: number, compute: (head: string | null) => Promise<T>) =>
      compute(events.at(-1)!.commit),
  );
  t.mock.method(history, "changesInRange", async () => events);
  t.mock.method(history, "nodeRecordEvents", async () => ({
    [events[0]!.commit]: { "node-o": initial },
    [confirmedCommit]: { "node-o": { ...initial, goal: { ...initial.goal!, version: current } } },
  }));
  t.mock.method(history, "readVersions", async (requested: readonly DocumentVersion[]) =>
    requested.map((version) => ({
      version,
      raw: versions.get(`${version.commit}:${version.path}`)!,
      changedSince: false,
    })),
  );
  const times = await latestGoalAheadTimes(history);
  assert.deepEqual(times, { "node-n": "time-4" });
  events.splice(3);
  assert.deepEqual(await latestGoalAheadTimes(history), { "node-n": "time-1" });
});
