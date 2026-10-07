import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  GitDocumentHistory,
  type HistoryCommit,
  type DocumentVersion,
} from "../src/core/git-history.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { nodeMaterialFingerprint, nodeSemanticFingerprint } from "../src/core/node-sync-record.js";
import {
  historicalFingerprintReader,
  historicalFrontmatterReader,
  historicalNodeCatalog,
} from "../src/core/node-semantic-history.js";
import { latestGoalAheadTimes } from "../src/core/node-ahead-history.js";
import type { NodeBasisRecord } from "../src/core/node-basis-record.js";

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const note = (id: string, type: string, body: string, metadata = {}) =>
  serializeFrontmatter({ id, type, ...metadata }, body);
const catalog = (rows: [string, string, string][]) =>
  historicalNodeCatalog(new Map(rows.map(([id, path, raw]) => [id, { path, raw }])));

for (const unreadable of ["missing-section", "deleted", "invalid", "older-readable"] as const) {
  for (const changedReceipt of [false, true]) {
    for (const independent of [false, true]) {
      test(`newer receipt ${unreadable}/${changedReceipt ? "changed" : "unchanged"}/${independent ? "independent" : "single"} requires proof of false`, async (t) => {
        const material = (body: string) => note("node-u", "prompt", `## Plan\n\n${body}\n`);
        const goal = note("node-g", "goal", "requirement A\n", { resource: "/U/U.md#Plan" });
        const rows: [string, string, string][] = [
          ["node-u", "U", material("A")],
          ["node-g", "G", goal],
          ["node-o", "G/O", note("node-o", "output-evidence", "implementation\n")],
        ];
        if (independent)
          rows.push(["node-s", "G/S", note("node-s", "output-evidence", "sibling\n")]);
        const nodes = catalog(rows);
        const goalVersion = (raw: string) => {
          const parsed = parseFrontmatter(raw);
          return nodeSemanticFingerprint(parsed.data, parsed.body, "G/G.md", nodes);
        };
        const record = (version: string, body = goal): NodeBasisRecord => ({
          v: 1,
          materials: [],
          goals: [
            {
              nodeId: "node-g",
              version: goalVersion(body),
              fingerprintVersion: 2,
              materials: [
                {
                  identity: "node:node-u#Plan",
                  version: nodeMaterialFingerprint(
                    material(version),
                    { kind: "path", anchor: "bundle", target: "U/U.md", suffix: "#Plan" },
                    nodes,
                  ),
                  fingerprintVersion: 2,
                },
              ],
            },
          ],
        });
        const initial = record("A");
        const confirmed = changedReceipt ? "B" : "A";
        const changedGoal = independent
          ? note("node-g", "goal", "requirement B\n", { resource: "/U/U.md#Plan" })
          : goal;
        const events: HistoryCommit[] = Array.from({ length: 6 }, (_, i) => ({
          commit: String(i).repeat(40),
          time: `time-${i}`,
          objectIds: [],
          changes: [],
          acknowledgedOutputIds: [],
        }));
        const versions = new Map<string, string>();
        const add = (i: number, id: string, path: string, raw: string | null) => {
          events[i]!.changes.push({
            objectId: id,
            ...(raw === null
              ? { before: { commit: events[0]!.commit, path } }
              : { after: { commit: events[i]!.commit, path } }),
          });
          if (raw !== null) versions.set(`${events[i]!.commit}:${path}`, raw);
        };
        for (const [id, path, raw] of rows) add(0, id, `${path}/${path.split("/").at(-1)}.md`, raw);
        if (independent) add(1, "node-g", "G/G.md", changedGoal);
        if (unreadable !== "older-readable")
          add(
            1,
            "node-u",
            "U/U.md",
            unreadable === "deleted"
              ? null
              : unreadable === "invalid"
                ? "---\nid: [\n---\ninvalid\n"
                : material("A").replace("## Plan", "## Missing"),
          );
        events[2]!.acknowledgedOutputIds = ["node-o"];
        add(3, "node-u", "U/U.md", material("C"));
        add(4, "node-u", "U/U.md", material(confirmed));
        add(4, "node-g", "G/G.md", changedGoal);
        if (independent) events[4]!.acknowledgedOutputIds = ["node-s"];
        add(5, "node-u", "U/U.md", material("D"));
        const records = {
          [events[0]!.commit]: { "node-o": initial, ...(independent ? { "node-s": initial } : {}) },
          [events[2]!.commit]: { "node-o": record(confirmed, changedGoal) },
          ...(independent
            ? { [events[4]!.commit]: { "node-s": record(confirmed, changedGoal) } }
            : {}),
        };
        const history = new GitDocumentHistory("unused");
        t.mock.method(
          history,
          "derived",
          async <T>(_n: string, _v: number, compute: (head: string | null) => Promise<T>) =>
            compute(events.at(-1)!.commit),
        );
        t.mock.method(history, "changesInRange", async () => events);
        t.mock.method(history, "nodeRecordEvents", async () => records);
        t.mock.method(history, "readVersions", async (requested: readonly DocumentVersion[]) =>
          requested.map((version) => ({
            version,
            raw: versions.get(`${version.commit}:${version.path}`)!,
            changedSince: false,
          })),
        );
        const tail = events.splice(4);
        const times = await latestGoalAheadTimes(history);
        assert.equal(
          times["node-g"],
          independent ? "time-1" : changedReceipt ? "time-3" : undefined,
        );
        events.push(...tail);
        assert.equal(
          (await latestGoalAheadTimes(history))["node-g"],
          "time-5",
          "new retained matching bytes prove false, then changed bytes prove a new start",
        );
      });
    }
  }
}

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

test("ahead replay keeps metadata-stable times and the latest implementation transition", async (t) => {
  const rows: [string, string, string][] = [
    ["node-g", "G", note("node-g", "goal", "outer\n")],
    ["node-n", "G/N", note("node-n", "goal", "inner\n")],
    ["node-o", "G/N/O", note("node-o", "output-evidence", "output\n")],
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
    v: 1,
    materials: [],
    goals: [{ nodeId: "node-n", version: fingerprint, fingerprintVersion: 2, materials: [] }],
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
    [confirmedCommit]: {
      "node-o": { ...initial, goals: [{ ...initial.goals![0]!, version: current }] },
    },
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
