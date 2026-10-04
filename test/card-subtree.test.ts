import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { readCardProgress, type CardProgressInput } from "../src/core/card-progress.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import type {
  DocumentVersion,
  GitDocumentHistory,
  HistoryCommit,
  HistoryChange,
} from "../src/core/git-history.js";
import { nodeNotePath } from "../src/core/paths.js";

// Real current files/catalog, with a deterministic retained Git lineage for transition cases.
async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch/brief-speed");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "subtree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disk = new NodeFs(root);
  await disk.mkdir(".git");
  const live = new Map<string, string>(),
    blobs = new Map<string, string>();
  const events: HistoryCommit[] = [];
  const cache = new Map<string, unknown>();
  let head = "",
    traversals = 0,
    reads = 0,
    builds = 0;
  const history = {
    currentCommit: async () => head,
    changesInRange: async () => {
      traversals++;
      return events;
    },
    readVersions: async (versions: readonly DocumentVersion[]) => {
      reads++;
      return versions.map((version) => {
        const raw = blobs.get(`${version.commit}:${version.path}`);
        return raw === undefined
          ? new Error("Missing test version")
          : { version, raw, changedSince: false, frontmatter: parseFrontmatter(raw).data };
      });
    },
    derived: async <T>(name: string, version: number, compute: () => Promise<T>): Promise<T> => {
      const key = `${head}:${name}:${version}`;
      if (!cache.has(key)) {
        builds++;
        cache.set(key, await compute());
      }
      return cache.get(key) as T;
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
    operation = "node.write",
  ) {
    const parent = head || undefined;
    head = (events.length + 1).toString(16).padStart(40, "0");
    const byId = new Map<string, HistoryChange>();
    for (const change of changes) {
      const previous = live.get(change.path);
      const id = String(parseFrontmatter(change.raw ?? previous!).data.id);
      const entry = byId.get(id) ?? { objectId: id };
      if (previous !== undefined) entry.before = { commit: parent!, path: change.path };
      if (change.raw === null) {
        live.delete(change.path);
        await disk.remove(change.path);
      } else {
        entry.after = { commit: head, path: change.path };
        live.set(change.path, change.raw);
        await disk.writeFile(change.path, change.raw);
      }
      byId.set(id, entry);
    }
    for (const [file, raw] of live) blobs.set(`${head}:${file}`, raw);
    events.push({
      commit: head,
      parent,
      time: "2026-10-05T00:00:00.000Z",
      operation,
      objectIds: [...byId.keys()],
      changes: [...byId.values()],
    });
  }
  const node = async (nodePath: string, id: string, type: string, body = "result", fields = {}) => {
    const raw = serializeFrontmatter({ id, type, ...fields }, body);
    await capture([{ path: nodeNotePath(nodePath), raw }]);
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
    counts: () => ({ traversals, reads, builds }),
  };
}

test("Card subtree counts nested resource-less outputs for every referenced ancestor and child goal", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal-direction");
  await f.node("Root/Child", "node-child", "goal");
  await f.node("Root/Child/Old", "node-old", "output-analysis");
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
  await f.node("Root/Child/New", "node-new", "output-evidence");
  assert.deepEqual(await f.query(card), {
    progress: "has-output",
    goalCount: 2,
    totalGoalCount: 2,
    outputNodeIds: ["node-new"],
  });
  assert.equal((await f.query({ ...card, state: "pending" })).progress, "pending");
});

test("Card subtree cache preserves ordinary-save negatives and checks current active/invalid state on hits", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  const old = await f.node("Root/Out", "node-out", "output");
  const card = await f.card("card-before", ["Root/Root.md"]);
  assert.equal((await f.query(card)).goalCount, 0);
  const cold = f.counts();
  await f.query(card);
  assert.deepEqual(f.counts(), cold, "warm HEAD cannot replay history or read retained blobs");
  await f.capture([{ path: "Root/Out/Out.md", raw: old + "\nordinary save" }]);
  assert.equal((await f.query(card)).goalCount, 0);
  const confirmed = serializeFrontmatter(
    {
      id: "node-out",
      type: "output",
      verified: [{ by: "human:cuca", at: "2026-10-05T00:00:01.000Z" }],
    },
    "verified result",
  );
  await f.capture([{ path: "Root/Out/Out.md", raw: confirmed }], "node.write");
  assert.equal((await f.query(card)).goalCount, 1);
  const warm = f.counts();
  for (const status of ["deprecated", "unsupported"]) {
    await f.disk.writeFile(
      "Root/Out/Out.md",
      serializeFrontmatter({ id: "node-out", type: "output", status }, "dirty current status"),
    );
    assert.equal((await f.query(card)).goalCount, 0);
  }
  await f.disk.writeFile(
    "Root/Out/Out.md",
    serializeFrontmatter({ id: "node-out", type: "invalid" }, "dirty invalid type"),
  );
  assert.equal((await f.query(card)).goalCount, 0);
  await f.disk.writeFile("Root/Out/Out.md", confirmed);
  assert.equal((await f.query(card)).goalCount, 1);
  assert.deepEqual(
    f.counts(),
    warm,
    "dirty current declarations must not use cached progress results",
  );
  await f.disk.remove("Root/Out");
  assert.equal((await f.query(card)).goalCount, 0);
});

test("Card subtree distinguishes new ancestor attachments from preserved child ownership during moves", async (t) => {
  const f = await fixture(t);
  await f.node("A", "node-a", "goal");
  await f.node("B", "node-b", "goal");
  await f.node("A/Child", "node-child", "goal");
  await f.node("A/Child/Out", "node-out", "output");
  const card = await f.card("card-moves", ["A/A.md", "B/B.md", "A/Child/Child.md"]);
  await f.move("A/Child", "B/Child");
  assert.deepEqual(await f.query(card), {
    progress: "received-no-output",
    goalCount: 1,
    totalGoalCount: 3,
    outputNodeIds: ["node-out"],
  });
  await f.move("B", "Renamed");
  assert.equal(
    (await f.query(card)).goalCount,
    1,
    "renaming a whole subtree preserves stable ancestor membership",
  );
  const current = f.live.get("Renamed/Child/Out/Out.md")!;
  await f.capture([{ path: "Renamed/Child/Out/Out.md", raw: current }], "node.sync-confirm");
  assert.equal(
    (await f.query(card)).goalCount,
    2,
    "confirmation qualifies both current ancestor and nested goal",
  );
  await f.move("Renamed/Child/Out", "A/Out");
  assert.deepEqual(await f.query(card), {
    progress: "received-no-output",
    goalCount: 1,
    totalGoalCount: 3,
    outputNodeIds: ["node-out"],
  });
  await f.move("A/Out", "Renamed/Child/Out");
  assert.equal((await f.query(card)).goalCount, 2);
  // A dirty move back cannot reuse a previous relation that left the retained hierarchy.
  await f.disk.move("Renamed/Child/Out", "A/Out");
  assert.equal((await f.query(card)).goalCount, 0);
});

test("Card subtree retains reception-only spec Cards and requires current goals and active outputs", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  await f.node("Notes", "node-notes", "prompt-spec");
  const spec = await f.card("card-spec", ["Notes/Notes.md"]);
  assert.deepEqual(await f.query(spec), {
    progress: null,
    goalCount: 0,
    totalGoalCount: 0,
    outputNodeIds: [],
  });
  const card = await f.card("card-current", ["Root/Root.md"]);
  await f.node("Root/Archived", "node-archived", "output", "old", { status: "deprecated" });
  assert.equal((await f.query(card)).goalCount, 0);
  await f.node("Root/Current", "node-current", "output");
  assert.equal((await f.query(card)).goalCount, 1);
  await f.disk.writeFile(
    "Root/Root.md",
    serializeFrontmatter({ id: "node-root", type: "prompt-spec" }, "changed type"),
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
  await f.node("Root/Out", "node-out", "output");
  assert.equal((await f.query(good)).progress, "has-output");
  const unavailable = await f.query(bad);
  assert.equal(unavailable.progress, null);
  assert.match(unavailable.diagnostic!, /Cannot derive Card progress.*Missing test version/);
  assert.equal((await f.query(good)).progress, "has-output");
});
