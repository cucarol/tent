import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import type { WorkspaceMap, WorkspaceMapNode } from "../src/core/read/workspace-map.js";
import { buildGraph, mapSnapshot, withMap } from "../src/ui/data/store.js";
import { fileMarkOf, fileOf, infoOf } from "../src/ui/data/files.js";
import { detailLoader } from "../src/ui/data/details.js";
import { setLang, t } from "../src/ui/i18n.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { readWorkspaceMap } from "../src/core/read/workspace-map.js";
import { readWorkspaceRevision } from "../src/core/workspace/workspace-revision.js";
import { testScratchRoot } from "./scratch.js";

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
    resourceKind: null,
    ...extra,
  };
}

const map: WorkspaceMap = {
  workspace: { id: "ws-map", name: "map", revision: "map-r1", generatedAt: "" },
  nodes: [
    mapNode("g", null, "goal", {
      childIds: ["o", "p", "x"],
      tags: ["direction"],
      resourceKind: "file",
    }),
    mapNode("o", "g", "output", { status: "deprecated" }),
    mapNode("p", "g", "prompt", { stale: true, resourceKind: "uri" }),
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
    delete n.resourceKind;
  }
  const merged = withMap(full, map);
  assert.equal(merged.workspace.revision, "full-r9");
  const byId = new Map(merged.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("p")!.stale, true);
  assert.equal(byId.get("x")!.invalidReason, "bad header");
  assert.equal(merged.modules?.edges.length, 1);
  assert.equal(byId.get("g")!.resourceKind, "file");
  assert.equal(byId.get("p")!.resourceKind, "uri");
});

test("fresh Core expiry removes an old snapshot's completion without changing the full revision", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-expiry-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const adapter = new NodeFs(path.join(root, ".tent"));
  await adapter.writeFile(
    "Result/Result.md",
    "---\nid: node-result\ntype: output\nstale_after: 2026-10-27T00:00:00Z\n---\nResult\n",
  );
  const workspace = { id: "ws-expiry", name: "Expiry" };
  const repository = { basis: { head: null }, sources: [] };
  const before = await readWorkspaceMap(
    adapter,
    workspace,
    root,
    repository,
    "2026-10-26T23:59:59Z",
  );
  const revision = await readWorkspaceRevision(adapter);
  const full = mapSnapshot(before);
  full.nodes[0]!.outputAt = "2026-10-26T00:00:00Z";
  const expired = await readWorkspaceMap(
    adapter,
    workspace,
    root,
    repository,
    "2026-10-27T00:00:00Z",
  );
  assert.equal(await readWorkspaceRevision(adapter), revision);
  assert.equal(before.nodes[0]!.stale, false);
  assert.equal(expired.nodes[0]!.stale, true);
  assert.notEqual(before.workspace.revision, expired.workspace.revision);
  assert.equal(withMap(full, expired).nodes[0]!.outputAt, undefined);
  assert.equal(withMap(full, before).nodes[0]!.outputAt, "2026-10-26T00:00:00Z");
});

test("a newer map adds, moves and removes topics before slower document details arrive", () => {
  const full = mapSnapshot(map);
  full.workspace = { ...full.workspace, revision: "full-before" };
  full.nodes.find((n) => n.id === "p")!.body = "retained document details";
  full.paths["roles/role-main.md"] = { kind: "role", id: "role-main" };
  const next = {
    ...map,
    workspace: { ...map.workspace, revision: "map-after" },
    nodes: [
      mapNode("g", null, "goal", { childIds: ["p", "new"] }),
      mapNode("p", "g", "prompt", {
        name: "renamed",
        path: "g/renamed",
        notePath: "g/renamed/renamed.md",
        stale: false,
      }),
      mapNode("new", "g", "prompt"),
    ],
  };
  const merged = withMap(full, next);
  assert.equal(
    merged.workspace.revision,
    "full-before",
    "the retained details still need refreshing",
  );
  assert.deepEqual(
    merged.nodes.map((n) => n.id),
    ["g", "p", "new"],
  );
  const existing = merged.nodes.find((n) => n.id === "p")!;
  assert.equal(existing.name, "renamed");
  assert.equal(existing.body, "retained document details");
  assert.equal(existing.stale, undefined, "the newer header clears an older expiry notice");
  assert.equal(merged.nodes.find((n) => n.id === "new")!.body, "");
  const graph = buildGraph(merged);
  assert.deepEqual(
    graph
      .childrenOf("g")
      .map((n) => n.id)
      .sort(),
    ["new", "p"],
  );
  assert.equal(graph.nodes.has("o"), false);
  assert.equal(graph.refOf("/p/p.md"), null);
  assert.deepEqual(graph.refOf("/g/renamed/renamed.md"), { kind: "node", id: "p" });
  assert.deepEqual(graph.refOf("/roles/role-main.md"), { kind: "role", id: "role-main" });
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
  assert.match(app, /workspaceRefresh\(\{/);
  assert.match(app, /snapshot: api\.snapshot/);
  assert.match(
    app,
    /applyMap: \(next\) => \{\s*(?:\/\/[^\n]*\n\s*)?setFactsEpoch\(\(epoch\) => epoch \+ 1\)/,
  );
  assert.match(app, /factsEpoch=\{factsEpoch\}/);
  assert.match(app, /window\.addEventListener\("focus", refresh\)/);
  // A failed map read is an error; there is no fallback to the old snapshot-only service.
  assert.match(app, /\(e\) => live && setError\(/);
  // Nothing on the map waits for materials to be compared.
  assert.doesNotMatch(app, /\/api\/sync|useSyncFlags/);
  // A deep link to something the map does not hold asks for it.
  assert.match(
    app,
    /if \(!graph\.detailed && id && !graph\.nodes\.has\(id\)\) \{[\s\S]*?return wantDetails\(\);/,
  );
  // An empty link opens nothing, even beside a Node listed under the empty id.
  assert.match(app, /const ref: SnapshotRef \| null = !id\s*\?\s*null/);
  // Evaluate the Reader's actual request condition: Node details and the plain
  // AGENTS.md file have their own readers; Roles and Cards need the snapshot.
  const reader = ts.createSourceFile(
    "Reader.tsx",
    src("../src/ui/panel/Reader.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const component = reader.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "Reader",
  );
  assert.ok(component?.body);
  const calls = component.body.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      return [];
    const call = statement.expression;
    return ts.isIdentifier(call.expression) && call.expression.text === "useWantDetails"
      ? [call]
      : [];
  });
  assert.equal(calls.length, 1, "Reader registers its details need unconditionally");
  assert.equal(calls[0]!.arguments.length, 1);
  const needsDetails = new Function(
    "target",
    "graph",
    `return (${calls[0]!.arguments[0]!.getText(reader)});`,
  );
  for (const [kind, needsSnapshot] of [
    ["node", false],
    ["agents", false],
    ["role", true],
    ["card", true],
  ] as const)
    for (const detailed of [false, true])
      assert.equal(
        needsDetails({ kind }, { detailed }),
        needsSnapshot && !detailed,
        `${kind}, detailed=${detailed}`,
      );
  assert.match(src("../src/ui/panel/Overlays.tsx"), /useWantDetails\(!graph\.detailed\)/);
  assert.match(
    src("../src/ui/shell/Dock.tsx"),
    /useWantDetails\(open && detailsReady && !graph\.detailed\)/,
  );
  const view = src("../src/ui/map/MapView.tsx");
  assert.match(
    view,
    /\.compareOutputs\(toCompare\)[\s\S]*?\}, \[compareKey, graph\.snapshot\.workspace\.revision, factsEpoch\]\);/,
  );
  assert.match(view, /useWantDetails\(!!lensId && !graph\.detailed\)/);
  assert.match(view, /useWantDetails\(time === null && !graph\.detailed && members\.size > 0\)/);
  assert.match(view, /if \(!currentGraph\.detailed\) \{\s*want\(\);/);
  // Module lines come with the map; only reactions wait for the snapshot.
  assert.match(view, /graph\.snapshot\.modules\?\.edges/);
  assert.doesNotMatch(view, /moduleDeps/);
  assert.equal(view.match(/if \(!graph\.detailed\) return out;/g)?.length, 1);
  // Selection reactions say only what Tent holds while their relations arrive.
  assert.doesNotMatch(view, /map-region-none/);
});

test("actual topic measurement keeps map-first file widths when full details arrive", () => {
  const view = readFileSync(new URL("../src/ui/map/MapView.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile(
    "MapView.tsx",
    view,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callback: ts.ArrowFunction | undefined;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText(source) === "measureTopic" &&
      n.initializer &&
      ts.isCallExpression(n.initializer)
    ) {
      const first = n.initializer.arguments[0];
      if (first && ts.isArrowFunction(first)) callback = first;
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  assert.ok(callback, "Exercise the actual MapView measurement callback");
  const javascript = ts.transpileModule(`const measure = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const measure = (snapshot: ReturnType<typeof mapSnapshot>) => {
    const graph = buildGraph(snapshot);
    const env = {
      graph,
      fileMarkOf,
      fileOf,
      infoOf,
      files: {},
      topicScale: 1,
      titleAt: () => ({ px: 15, icon: 18, weight: 600 }),
      textWidth: (text: string) => text.length * 7,
      t,
      sources: null,
      openOutputs: new Set(),
      shown: { kidsOf: graph.childrenOf },
      TOPIC: { centre: 30, first: 24, deeper: 22 },
    };
    return new Function(...Object.keys(env), `${javascript}\nreturn measure;`)(
      ...Object.values(env),
    ) as (id: string, depth: number) => { w: number; h: number };
  };
  const first = mapSnapshot(map);
  const full = structuredClone(first);
  for (const n of full.nodes) delete n.resourceKind;
  full.nodes.find((n) => n.id === "g")!.materials = [
    { kind: "file", resource: "../../a.png", workspacePath: "a.png", field: "resource" },
  ];
  full.nodes.find((n) => n.id === "p")!.materials = [
    {
      kind: "uri",
      resource: "https://example.com/a",
      uri: "https://example.com/a",
      field: "resource",
    },
  ];
  const after = withMap(full, map);
  for (const n of first.nodes)
    assert.deepEqual(measure(first)(n.id, n.depth), measure(after)(n.id, n.depth), n.id);
  const noFile = mapSnapshot({
    ...map,
    nodes: map.nodes.map((n) => ({ ...n, resourceKind: null })),
  });
  assert.equal(
    measure(first)("g", 0).w - measure(noFile)("g", 0).w,
    23,
    "One actual18px file glyph plus5px gap, no extra slot",
  );
  assert.equal(
    measure(first)("p", 1).w,
    measure(noFile)("p", 1).w,
    "URI retains the current map style without a glyph",
  );
  assert.match(view, /const marked = fileMarkOf\(n\) === "file"/);
  assert.match(view, /\{marked && \(/, "Rendering uses the same declared flag as measurement");
  const currentNative = withMap(full, {
    ...map,
    nodes: map.nodes.map((n) => ({ ...n, resourceKind: null })),
  });
  assert.equal(fileMarkOf(currentNative.nodes.find((n) => n.id === "g")!), null);
  assert.deepEqual(
    currentNative.nodes.find((n) => n.id === "g")!.materials,
    full.nodes.find((n) => n.id === "g")!.materials,
    "Header projection does not rewrite retained material details",
  );
});
