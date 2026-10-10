import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { readCardProgress, type CardProgressInput } from "../src/core/card-progress.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import type { DocumentVersion, GitDocumentHistory } from "../src/core/git-history.js";
import { nodeNotePath } from "../src/core/paths.js";
import { prepareNodeSyncSave } from "../src/core/node-sync-record.js";
import type { NodeBasisRecord } from "../src/core/node-basis-record.js";

// Real current files/catalog, with a deterministic retained Git lineage for transition cases.
async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch/card-progress");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "subtree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disk = new NodeFs(root);
  await disk.mkdir(".git");
  const live = new Map<string, string>(),
    blobs = new Map<string, string>();
  const records: Record<string, NodeBasisRecord> = {};
  let revision = 0,
    head = "";
  const history = {
    nodeRecords: async () => records,
    changesInRange: async () => {
      throw new Error("Card progress must not replay history");
    },
    derived: async () => {
      throw new Error("Card progress must not build a history cache");
    },
    readVersions: async (versions: readonly DocumentVersion[]) => {
      return versions.map((version) => {
        const raw = blobs.get(`${version.commit}:${version.path}`);
        return raw === undefined
          ? new Error("Missing test version")
          : { version, raw, changedSince: false, frontmatter: parseFrontmatter(raw).data };
      });
    },
  } as unknown as GitDocumentHistory;
  const adapter = new Proxy(disk, {
    get(target, key) {
      if (key === "history") return history;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FsAdapter;
  async function capture(
    changes: Array<{ path: string; raw: string | null }>,
    _operation = "node.write",
  ) {
    head = (++revision).toString(16).padStart(40, "0");
    for (const change of changes) {
      if (change.raw === null) {
        live.delete(change.path);
        await disk.remove(change.path);
      } else {
        live.set(change.path, change.raw);
        await disk.writeFile(change.path, change.raw);
      }
    }
    for (const [file, raw] of live) blobs.set(`${head}:${file}`, raw);
  }
  const node = async (nodePath: string, id: string, type: string, body = "result", fields = {}) => {
    const raw = serializeFrontmatter({ id, type, ...fields }, body);
    await capture([{ path: nodeNotePath(nodePath), raw }]);
    // This helper publishes an authored Node, including its retained basis.
    const prepared = await prepareNodeSyncSave(adapter, nodeNotePath(nodePath), raw, {
      created: true,
    });
    assert.ok(prepared.record);
    records[id] = prepared.record;
    return raw;
  };
  async function card(
    id: string,
    sourcePaths: string[],
    state: "pending" | "consumed" = "consumed",
  ) {
    const sources = sourcePaths.map((file) => ({
      resource: `/${file}`,
      version: { commit: head, path: file },
    }));
    const input: CardProgressInput = { cardId: id, state, sources };
    await capture(
      [
        {
          path: `cards/${id}.md`,
          raw: serializeFrontmatter({ id, type: "card", sources }, "task"),
        },
      ],
      "card.create",
    );
    return input;
  }
  const query = async (card: CardProgressInput) =>
    (await readCardProgress(adapter, [card])).get(card.cardId)!;
  async function move(from: string, to: string) {
    const changes = [...live].filter(([file]) => file.startsWith(from + "/"));
    const writes = changes.flatMap(([file, raw]) => {
      const directory = file.slice(0, file.lastIndexOf("/"));
      const target = to + directory.slice(from.length);
      return [
        { path: file, raw: null },
        { path: nodeNotePath(target), raw },
      ];
    });
    await capture(writes, "node.move");
    await disk.remove(from);
  }
  return {
    disk,
    adapter,
    node,
    card,
    query,
    move,
    capture,
    live,
  };
}

test("Card subtree counts nested resource-less outputs for every referenced ancestor and child goal", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal", "result", { tags: ["direction"] });
  await f.node("Root/Child", "node-child", "goal");
  await f.node("Root/Child/Old", "node-old", "output", "result", { tags: ["analysis"] });
  const card = await f.card("card-subtree", [
    "Root/Root.md",
    "Root/Child/Child.md",
    "Root/Root.md",
  ]);
  assert.deepEqual(await f.query(card), {
    progress: "received-no-output",
    goalCount: 0,
    totalGoalCount: 2,
    outputNodeIds: [],
  });
  await f.node("Root/Child/New", "node-new", "output", "result", {
    tags: ["evidence"],
    sources: [{ resource: "/cards/card-subtree.md" }],
  });
  assert.deepEqual(await f.query(card), {
    progress: "has-output",
    goalCount: 2,
    totalGoalCount: 2,
    outputNodeIds: ["node-new"],
  });
  assert.equal((await f.query({ ...card, state: "pending" })).progress, "pending");
});

test("Card responses ignore unrelated saves and use current active/invalid state without replay", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  const old = await f.node("Root/Out", "node-out", "output");
  const card = await f.card("card-before", ["Root/Root.md"]);
  assert.equal((await f.query(card)).goalCount, 0);
  await f.query(card);
  await f.capture([{ path: "Root/Out/Out.md", raw: old + "\nordinary save" }]);
  assert.equal((await f.query(card)).goalCount, 0);
  const confirmed = serializeFrontmatter(
    {
      id: "node-out",
      type: "output",
      verified: [{ by: "human:cuca", at: "2026-10-05T00:00:01.000Z" }],
      sources: [{ resource: "/cards/card-before.md" }],
    },
    "verified result",
  );
  await f.capture([{ path: "Root/Out/Out.md", raw: confirmed }], "node.write");
  assert.equal((await f.query(card)).goalCount, 1);
  for (const status of ["deprecated", "unsupported"]) {
    await f.disk.writeFile(
      "Root/Out/Out.md",
      serializeFrontmatter(
        {
          id: "node-out",
          type: "output",
          status,
          sources: [{ resource: "/cards/card-before.md" }],
        },
        "dirty current status",
      ),
    );
    assert.equal((await f.query(card)).goalCount, 0);
  }
  await f.disk.writeFile(
    "Root/Out/Out.md",
    serializeFrontmatter(
      { id: "node-out", type: "invalid", sources: [{ resource: "/cards/card-before.md" }] },
      "dirty invalid type",
    ),
  );
  assert.equal((await f.query(card)).goalCount, 0);
  await f.disk.writeFile("Root/Out/Out.md", confirmed);
  assert.equal((await f.query(card)).goalCount, 1);
  await f.disk.remove("Root/Out");
  assert.equal((await f.query(card)).goalCount, 0);
});

test("Card responses follow the current hierarchy while unrelated moves remain uncounted", async (t) => {
  const f = await fixture(t);
  await f.node("A", "node-a", "goal");
  await f.node("B", "node-b", "goal");
  await f.node("A/Child", "node-child", "goal");
  await f.node("A/Child/Out", "node-out", "output");
  const card = await f.card("card-moves", ["A/A.md", "B/B.md", "A/Child/Child.md"]);
  await f.move("A/Child", "B/Child");
  assert.equal((await f.query(card)).goalCount, 0, "movement alone is not a Card response");
  await f.node("B/Child/Out", "node-out", "output", "result", {
    sources: [{ resource: "/cards/card-moves.md" }],
  });
  assert.deepEqual(await f.query(card), {
    progress: "received-no-output",
    goalCount: 2,
    totalGoalCount: 3,
    outputNodeIds: ["node-out"],
  });
  await f.move("B", "Renamed");
  assert.equal(
    (await f.query(card)).goalCount,
    2,
    "renaming a whole subtree preserves stable ancestor membership",
  );
  const current = f.live.get("Renamed/Child/Out/Out.md")!;
  await f.capture([{ path: "Renamed/Child/Out/Out.md", raw: current }], "node.sync-confirm");
  assert.equal(
    (await f.query(card)).goalCount,
    2,
    "confirmation does not change the explicit response relationship",
  );
  await f.move("Renamed/Child/Out", "A/Out");
  assert.deepEqual(await f.query(card), {
    progress: "needs-review",
    goalCount: 0,
    totalGoalCount: 3,
    outputNodeIds: [],
    reviewGoalCount: 1,
    reviewOutputNodeIds: ["node-out"],
  });
  await f.move("A/Out", "Renamed/Child/Out");
  assert.equal((await f.query(card)).goalCount, 2);
  // Current hierarchy determines goal membership even before its next capture.
  await f.disk.move("Renamed/Child/Out", "A/Out");
  assert.equal((await f.query(card)).reviewGoalCount, 1);
});

test("Card subtree retains reception-only spec Cards and requires current goals and active outputs", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  await f.node("Notes", "node-notes", "prompt", "result", { tags: ["spec"] });
  const spec = await f.card("card-spec", ["Notes/Notes.md"]);
  assert.deepEqual(await f.query(spec), {
    progress: null,
    goalCount: 0,
    totalGoalCount: 0,
    outputNodeIds: [],
  });
  const card = await f.card("card-current", ["Root/Root.md"]);
  await f.node("Root/Archived", "node-archived", "output", "old", {
    status: "deprecated",
    sources: [{ resource: "/cards/card-current.md" }],
  });
  assert.equal((await f.query(card)).goalCount, 0);
  await f.node("Root/Current", "node-current", "output", "result", {
    sources: [{ resource: "/cards/card-current.md" }],
  });
  assert.equal((await f.query(card)).goalCount, 1);
  await f.disk.writeFile(
    "Root/Root.md",
    serializeFrontmatter({ id: "node-root", type: "prompt" }, "changed type"),
  );
  assert.equal((await f.query(card)).goalCount, 0);
  await f.disk.remove("Root");
  assert.deepEqual(await f.query(card), {
    progress: "received-no-output",
    goalCount: 0,
    totalGoalCount: 1,
    outputNodeIds: [],
  });
});

test("an unavailable historical pin diagnoses only its Card and cannot break unrelated progress", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  const good = await f.card("card-good", ["Root/Root.md"]);
  const bad: CardProgressInput = {
    cardId: "card-bad",
    state: "consumed",
    sources: [
      {
        resource: "/Root/Root.md",
        version: { commit: "f".repeat(40), path: "Root/Root.md" },
      },
    ],
  };
  await f.capture(
    [
      {
        path: "cards/card-bad.md",
        raw: serializeFrontmatter(
          { id: bad.cardId, type: "card", sources: bad.sources },
          "broken historical pin",
        ),
      },
    ],
    "card.create",
  );
  await f.node("Root/Out", "node-out", "output", "result", {
    sources: [{ resource: "/cards/card-good.md" }],
  });
  assert.equal((await f.query(good)).progress, "has-output");
  const unavailable = await f.query(bad);
  assert.equal(unavailable.progress, null);
  assert.match(unavailable.diagnostic!, /Cannot derive Card progress.*Missing test version/);
  assert.equal((await f.query(good)).progress, "has-output");
});

test("every current output answers its Card, whatever its tags", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  const card = await f.card("card-response", ["Root/Root.md"]);
  await f.node("Root/Note", "node-note", "prompt", "response", {
    tags: ["evidence"],
    sources: [{ resource: "/cards/card-response.md" }],
  });
  assert.equal((await f.query(card)).progress, "received-no-output", "a prompt never answers");
  for (const tags of [["issue"], ["analysis"], [], ["custom"], ["asset"], ["evidence", "ui"]]) {
    await f.node("Root/Out", "node-out", "output", "response", {
      ...(tags.length ? { tags } : {}),
      sources: [{ resource: "/cards/card-response.md" }],
    });
    assert.deepEqual(
      await f.query(card),
      { progress: "has-output", goalCount: 1, totalGoalCount: 1, outputNodeIds: ["node-out"] },
      tags.join(","),
    );
  }
});

test("deprecated source goals leave the Card denominator and no-goal Cards show reception only", async (t) => {
  const f = await fixture(t);
  await f.node("A", "node-a", "goal");
  await f.node("B", "node-b", "goal");
  const card = await f.card("card-deprecatedgoals", ["A/A.md", "B/B.md"]);
  await f.node("A/Result", "node-result", "output", "result", {
    sources: [{ resource: "/cards/card-deprecatedgoals.md" }],
  });
  assert.equal((await f.query(card)).totalGoalCount, 2);
  await f.node("B", "node-b", "goal", "obsolete", { status: "deprecated" });
  assert.deepEqual(await f.query(card), {
    progress: "has-output",
    goalCount: 1,
    totalGoalCount: 1,
    outputNodeIds: ["node-result"],
  });
  await f.node("A", "node-a", "goal", "obsolete", { status: "deprecated" });
  assert.deepEqual(await f.query(card), {
    progress: null,
    goalCount: 0,
    totalGoalCount: 0,
    outputNodeIds: [],
  });
});
