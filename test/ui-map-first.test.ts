import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { WorkspaceMap, WorkspaceMapNode } from "../src/core/read/workspace-map.js";
import { buildGraph, mapSnapshot, withMap } from "../src/ui/data/store.js";
import { detailLoader } from "../src/ui/data/details.js";
import { mapFlags } from "../src/ui/data/flags.js";
import { MAP_STALE, summarizeBehind } from "../src/ui/data/reasons.js";
import { setLang, t } from "../src/ui/i18n.js";

function mapNode(
  id: string,
  parentId: string | null,
  type: string,
  extra: Partial<WorkspaceMapNode> = {},
): WorkspaceMapNode {
  return {
    id,
    name: `name ${id}`,
    path: id,
    notePath: `${id}/${id}.md`,
    depth: parentId ? 1 : 0,
    type,
    tags: [],
    status: "stable",
    archived: false,
    parentId,
    childIds: [],
    stale: false,
    invalid: false,
    ...extra,
  };
}

const map: WorkspaceMap = {
  workspace: { id: "ws-map", name: "map", revision: "map-r1", generatedAt: "" },
  nodes: [
    mapNode("g", null, "goal", { childIds: ["o", "p", "x"], tags: ["direction"] }),
    mapNode("o", "g", "output", { status: "deprecated" }),
    mapNode("p", "g", "prompt", { stale: true }),
    mapNode("x", "g", "prompt", { invalid: true, invalidReason: "bad header" }),
  ],
  modules: {
    basis: null,
    modules: [
      { nodeId: "o", files: 2 },
      { nodeId: "p", files: 1 },
    ],
    edges: [{ from: "o", to: "p", imports: 3 }],
    cycles: [],
    uncovered: 0,
    unresolved: 0,
  } as unknown as WorkspaceMap["modules"],
};

test("the first screen is drawn from the map alone, keeping its tree, names and places", () => {
  const snapshot = mapSnapshot(map);
  const graph = buildGraph(snapshot, null, false);
  assert.equal(graph.detailed, false);
  // The map's own revision stands in; it is never the full one.
  assert.equal(snapshot.workspace.revision, "map-r1");
  assert.deepEqual(
    snapshot.nodes.map((n) => [n.id, n.name, n.type, n.parentId, n.status]),
    [
      ["g", "name g", "goal", null, "stable"],
      ["o", "name o", "output", "g", "deprecated"],
      ["p", "name p", "prompt", "g", "stable"],
      ["x", "name x", "prompt", "g", "stable"],
    ],
  );
  assert.deepEqual(graph.nodes.get("g")!.tags, ["direction"]);
  // Siblings still read goal, then prompt, then output.
  assert.deepEqual(
    graph.childrenOf("g").map((n) => n.id),
    ["p", "x", "o"],
  );
  assert.deepEqual(graph.refOf("/g/g.md"), { kind: "node", id: "g" });
  assert.deepEqual(
    graph.ancestors("p").map((n) => n.id),
    ["g"],
  );
});

test("what the map leaves out stays unknown until the snapshot: no text, relations, history, Cards or Roles", () => {
  const snapshot = mapSnapshot(map);
  for (const n of snapshot.nodes) {
    assert.equal(n.body, "");
    assert.deepEqual([n.links, n.materials, n.incoming, n.history], [[], [], [], []]);
  }
  assert.deepEqual([snapshot.roles, snapshot.cards, snapshot.commits], [[], [], []]);
  // A full snapshot is detailed by default.
  assert.equal(buildGraph(snapshot).detailed, true);
});

test("the first screen carries the map's expiry, header diagnosis and module lines", () => {
  const snapshot = mapSnapshot(map);
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("p")!.stale, true);
  assert.equal(byId.get("g")!.stale, undefined);
  assert.deepEqual([byId.get("x")!.invalid, byId.get("x")!.invalidReason], [true, "bad header"]);
  assert.deepEqual(snapshot.modules?.edges, [{ from: "o", to: "p", imports: 3 }]);
  // Before materials are compared, only an explicit expiry marks a Node; nothing claims to be in sync.
  assert.deepEqual(mapFlags(snapshot), { p: { behind: { reasons: [MAP_STALE] } } });
  setLang("en", false);
  assert.equal(
    t.map.invalidWhy("Invalid frontmatter: bad\nline 4"),
    "Header unreadable: Invalid frontmatter: bad",
  );
  setLang("zh", false);
});

test("the full snapshot keeps what only the map carries", () => {
  const full = {
    ...mapSnapshot({ ...map, modules: undefined as unknown as WorkspaceMap["modules"] }),
    workspace: { ...map.workspace, revision: "full-r9" },
  };
  for (const n of full.nodes) {
    delete n.stale;
    delete n.invalid;
    delete n.invalidReason;
  }
  const merged = withMap(full, map);
  assert.equal(merged.workspace.revision, "full-r9");
  const byId = new Map(merged.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("p")!.stale, true);
  assert.equal(byId.get("x")!.invalidReason, "bad header");
  assert.equal(merged.modules?.edges.length, 1);
});

test("an expiry without a date reads as expired", () => {
  assert.equal(summarizeBehind([MAP_STALE]).stale, "");
  assert.equal(summarizeBehind(["Content is stale on or after 2026-10-01"]).stale, "2026-10-01");
  assert.equal(summarizeBehind(["Material a.md changed"]).stale, null);
  setLang("zh", false);
  assert.equal(t.map.behindWhy([MAP_STALE]), "落后：内容已到期");
  setLang("en", false);
  assert.match(t.map.behindWhy([MAP_STALE]), /expired/);
  setLang("zh", false);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("details are read only when asked, once for every ask while on their way", async () => {
  const reads: ReturnType<typeof deferred<string>>[] = [];
  const applied: string[] = [];
  const loader = detailLoader(
    () => {
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    (v) => applied.push(v),
    () => assert.fail("no failure"),
  );
  loader.retry();
  assert.equal(reads.length, 0, "focus before any ask reads nothing");
  loader.want();
  loader.want();
  loader.retry();
  assert.equal(reads.length, 1);
  reads[0]!.resolve("full");
  await tick();
  assert.deepEqual(applied, ["full"]);
  loader.want();
  loader.retry();
  assert.equal(reads.length, 1, "after the details are in, asking reads nothing");
});

test("a failed read is told once and the next ask or focus tries again", async () => {
  const reads: ReturnType<typeof deferred<string>>[] = [];
  const applied: string[] = [];
  const failed: unknown[] = [];
  const loader = detailLoader(
    () => {
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    (v) => applied.push(v),
    (e) => failed.push(e),
  );
  loader.want();
  reads[0]!.reject(new Error("down"));
  await tick();
  assert.equal(failed.length, 1);
  assert.deepEqual(applied, []);
  loader.retry();
  assert.equal(reads.length, 2, "focus retries after a failure");
  reads[1]!.reject(new Error("still down"));
  await tick();
  loader.want();
  assert.equal(reads.length, 3, "a later ask retries too");
  reads[2]!.resolve("full");
  await tick();
  assert.deepEqual(applied, ["full"]);
  assert.equal(failed.length, 2);
});

test("a stopped loader applies nothing and reads no more", async () => {
  const d = deferred<string>();
  let reads = 0;
  const applied: string[] = [];
  const loader = detailLoader(
    () => (reads++, d.promise),
    (v) => applied.push(v),
    () => {},
  );
  loader.want();
  loader.stop();
  d.resolve("late");
  await tick();
  loader.want();
  loader.retry();
  assert.deepEqual([reads, applied], [1, []]);
});

test("the page reads the map first and the snapshot only where a view needs it", () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const app = src("../src/ui/App.tsx");
  assert.match(app, /loadMap\(\)\.then\(/);
  // No unconditional snapshot read after the first paint.
  assert.doesNotMatch(app, /requestAnimationFrame/);
  assert.equal(app.match(/loadSnapshot/g)?.length, 2, "imported once, handed to the loader once");
  assert.match(app, /detailLoader\(\s*loadSnapshot,/);
  assert.match(app, /window\.addEventListener\("focus", retry\)/);
  // A failed map read is an error; there is no fallback to the old snapshot-only service.
  assert.match(app, /\(e\) => live && setError\(/);
  // Material comparison waits for the map, and applies at any revision until the snapshot is in.
  assert.match(app, /useSyncFlags\(revision \?\? null, !!map\)/);
  assert.match(app, /flags === UNREAD && snapshot \? mapFlags\(snapshot\) : flags/);
  // A deep link to something the map does not hold asks for it.
  assert.match(
    app,
    /if \(!graph\.detailed && id && !graph\.nodes\.has\(id\)\) return wantDetails\(\);/,
  );
  // An empty link opens nothing, even beside a Node listed under the empty id.
  assert.match(app, /const ref: SnapshotRef | null = !ids*? null/);
  // Each view that shows what the snapshot holds asks for it.
  assert.match(src("../src/ui/panel/Reader.tsx"), /useWantDetails\(!graph\.detailed\)/);
  assert.match(src("../src/ui/panel/Overlays.tsx"), /useWantDetails\(!graph\.detailed\)/);
  assert.match(src("../src/ui/shell/Dock.tsx"), /useWantDetails\(open && !graph\.detailed\)/);
  const view = src("../src/ui/map/MapView.tsx");
  assert.match(view, /useWantDetails\(!!lensId && !graph\.detailed\)/);
  assert.match(view, /useWantDetails\(!graph\.detailed && \[\.\.\.members\.values\(\)\]\.some/);
  assert.match(view, /if \(!graph\.detailed\) \{\s*want\(\);/);
  // Module lines come with the map; only reactions wait for the snapshot.
  assert.match(view, /graph\.snapshot\.modules\?\.edges/);
  assert.doesNotMatch(view, /moduleDeps/);
  assert.equal(view.match(/if \(!graph\.detailed\) return out;/g)?.length, 1);
  // A region says only what Tent holds: nothing while its relations are on their way, nothing for none.
  assert.doesNotMatch(view, /map-region-none/);
});
