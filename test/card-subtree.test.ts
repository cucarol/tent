import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { readCardGoalIds, type CardSourceInput } from "../src/core/graph/card-context.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import type { DocumentVersion, GitDocumentHistory } from "../src/core/store/git-history.js";
import { nodeNotePath } from "../src/core/base/paths.js";

// Real live files and deterministic retained versions keep native changes distinct from pins.
async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch/card-sources");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "subtree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disk = new NodeFs(root);
  await disk.mkdir(".git");
  const live = new Map<string, string>(),
    blobs = new Map<string, string>();
  let revision = 0,
    head = "";
  const history = {
    changesInRange: async () => {
      throw new Error("Card source reads must not replay history");
    },
    derived: async () => {
      throw new Error("Card source reads must not build a history cache");
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
  async function capture(changes: Array<{ path: string; raw: string | null }>) {
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
    return raw;
  };
  async function card(id: string, sourcePaths: string[]) {
    const sources = sourcePaths.map((file) => ({
      resource: `/${file}`,
      version: { commit: head, path: file },
    }));
    const input: CardSourceInput = { cardId: id, sources };
    await capture([
      {
        path: `cards/${id}.md`,
        raw: serializeFrontmatter({ id, type: "card", sources }, "task"),
      },
    ]);
    return input;
  }
  const query = async (card: CardSourceInput) =>
    (await readCardGoalIds(adapter, [card])).get(card.cardId)!;
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
    await capture(writes);
    await disk.remove(from);
  }
  return {
    disk,
    adapter,
    node,
    card,
    query,
    move,
  };
}

test("Card sources select explicitly pinned goals once, independently of descendant outputs", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  await f.node("Root/Child", "node-child", "goal");
  await f.node("Root/Child/Old", "node-old", "output");
  const card = await f.card("card-subtree", [
    "Root/Root.md",
    "Root/Child/Child.md",
    "Root/Root.md",
  ]);
  const expected = { goalIds: new Set(["node-root", "node-child"]), diagnostics: [] };
  assert.deepEqual(await f.query(card), expected);
  await f.node("Root/Child/New", "node-new", "output", "result", {
    sources: [{ resource: "/cards/card-subtree.md" }],
  });
  assert.deepEqual(await f.query(card), expected);
});

test("pinned goal identity survives live edits, moves, type changes and deletion without history replay", async (t) => {
  const f = await fixture(t);
  await f.node("A", "node-a", "goal");
  await f.node("A/Child", "node-child", "goal");
  const card = await f.card("card-moves", ["A/A.md", "A/Child/Child.md"]);
  const expected = { goalIds: new Set(["node-a", "node-child"]), diagnostics: [] };
  await f.move("A", "Renamed");
  assert.deepEqual(await f.query(card), expected);
  await f.disk.writeFile(
    "Renamed/Child/Child.md",
    serializeFrontmatter({ id: "node-child", type: "prompt" }, "changed type"),
  );
  assert.deepEqual(await f.query(card), expected);
  await f.disk.remove("Renamed");
  assert.deepEqual(await f.query(card), expected);
});

test("only pinned goal sources supply attribution; prompts, outputs and unpinned addresses do not", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  await f.node("Notes", "node-notes", "prompt");
  await f.node("Root/Result", "node-result", "output");
  const card = await f.card("card-context", ["Notes/Notes.md", "Root/Result/Result.md"]);
  card.sources = [
    ...card.sources,
    { resource: "/Root/Root.md" },
    { resource: "https://example.org/goal" },
  ];
  assert.deepEqual(await f.query(card), { goalIds: new Set(), diagnostics: [] });
});

test("a source keeps the goal type from publication, including after live deprecation", async (t) => {
  const f = await fixture(t);
  await f.node("Goal", "node-goal", "goal");
  await f.node("Notes", "node-notes", "prompt");
  const card = await f.card("card-types", ["Goal/Goal.md", "Notes/Notes.md"]);
  await f.node("Goal", "node-goal", "goal", "obsolete", { status: "deprecated" });
  await f.node("Notes", "node-notes", "goal", "new intent");
  assert.deepEqual(await f.query(card), { goalIds: new Set(["node-goal"]), diagnostics: [] });
});

test("an unavailable pin diagnoses only its Card and cannot break unrelated source attribution", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  const good = await f.card("card-good", ["Root/Root.md"]);
  const bad: CardSourceInput = {
    cardId: "card-bad",
    sources: [
      { resource: "/Root/Root.md", version: { commit: "f".repeat(40), path: "Root/Root.md" } },
    ],
  };
  const results = await readCardGoalIds(f.adapter, [bad, good]);
  assert.deepEqual(results.get(good.cardId), { goalIds: new Set(["node-root"]), diagnostics: [] });
  assert.deepEqual([...results.get(bad.cardId)!.goalIds], []);
  assert.match(
    results.get(bad.cardId)!.diagnostics[0]!,
    /Cannot read Card source.*Missing test version/,
  );
});

test("a pin cannot attribute a goal through a different source address", async (t) => {
  const f = await fixture(t);
  await f.node("Root", "node-root", "goal");
  const card = await f.card("card-mismatch", ["Root/Root.md"]);
  card.sources = card.sources.map((source) => ({ ...source, resource: "/Other/Other.md" }));
  const result = await f.query(card);
  assert.deepEqual([...result.goalIds], []);
  assert.match(result.diagnostics[0]!, /Source address disagrees with its pinned version/);
});
