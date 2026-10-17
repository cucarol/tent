import assert from "node:assert/strict";
import test from "node:test";
import {
  checkModuleMap,
  type ModuleMapCommit,
  type ModuleMapInput,
  type ModuleMapNode,
} from "../src/core/check/module-map.js";
import type { RepositoryImport } from "../src/core/base/repository-imports.js";

const node = (id: string, overrides: Partial<ModuleMapNode> = {}): ModuleMapNode => ({
  id,
  path: id,
  name: id,
  body: "",
  materials: [{ path: id, kind: "directory", track: "structure" }],
  ...overrides,
});
const input = (overrides: Partial<ModuleMapInput> = {}): ModuleMapInput => ({
  trackedFiles: ["a/file.ts", "b/file.ts", "other/file.ts"],
  nodes: [node("a"), node("b"), node("other")],
  imports: [],
  commits: [],
  ...overrides,
});
const edge = (from: string, to: string, kind: RepositoryImport["kind"] = "file") => ({
  from,
  to,
  kind,
  specifier: to,
});
const commit = (id: string, files: string[], changedFiles = files.length): ModuleMapCommit => ({
  commit: id,
  files,
  changedFiles,
});
const history = (shared = 5, unrelated = 5) => [
  ...Array.from({ length: shared }, (_, i) => commit(`pair-${i}`, ["a/file.ts", "b/file.ts"])),
  ...Array.from({ length: unrelated }, (_, i) => commit(`other-${i}`, ["other/file.ts"])),
];
const facts = (result: ReturnType<typeof checkModuleMap>, id: string) =>
  result.modules.find((module) => module.id === id)!;

test("module facts expose empty live evidence without copying Node bodies", () => {
  const result = checkModuleMap(input({ nodes: [node("a", { body: "a rule with provenance" })] }));
  assert.deepEqual(facts(result, "a"), {
    id: "a",
    path: "a",
    name: "a",
    files: ["a/file.ts"],
    productionFiles: 1,
    generatedFiles: 0,
    testedBy: [],
    coChanges: [],
  });
});

test("testedBy uses direct production ownership, including barrels, and deduplicates test paths", () => {
  const imports = [
    edge("tests/z.test.ts", "a/file.ts"),
    edge("tests/a.test.ts", "a/file.ts"),
    edge("tests/a.test.ts", "a/index.ts"),
    edge("tests/a.test.ts", "a/file.ts"),
    edge("tests/a.test.ts", "a/child/file.ts"),
    edge("a/child/file.test.ts", "a/child/file.ts"),
    edge("tests/z.test.ts", "tests/a.test.ts"),
    edge("tests/z.test.ts", "a/generated/file.ts"),
    edge("tests/z.test.ts", "a/vendor/file.ts"),
    edge("tests/z.test.ts", "a/readme.md"),
    edge("tests/z.test.ts", "unowned/file.ts"),
    edge("tests/generated/a.test.ts", "a/file.ts"),
    edge("vendor/tests/a.test.ts", "a/file.ts"),
    edge("fixtures/data.json", "a/file.ts"),
    edge(".tent/tests/a.test.ts", "a/file.ts"),
    edge("tests/a.test.ts", ".tent/file.ts"),
    edge("b/file.ts", "a/file.ts"),
  ];
  const result = checkModuleMap(
    input({
      trackedFiles: [...new Set(imports.flatMap(({ from, to }) => [from, to]))],
      nodes: [
        node("a"),
        node("b"),
        node("child", {
          parentId: "a",
          materials: [{ path: "a/child", kind: "directory", track: "structure" }],
        }),
      ],
      imports,
    }),
  );
  assert.deepEqual(facts(result, "a").testedBy, [
    "a/child/file.test.ts",
    "tests/a.test.ts",
    "tests/z.test.ts",
  ]);
  assert.deepEqual(facts(result, "child").testedBy, ["a/child/file.test.ts", "tests/a.test.ts"]);
  assert.deepEqual(facts(result, "b").testedBy, []);
  assert.ok(!result.issues.some(({ code }) => code === "deps.cycle"));
});

test("testedBy resolves Go directory imports through each production file owner", () => {
  const source = input({
    trackedFiles: [
      "a/main.go",
      "pkg/one.go",
      "pkg/two.go",
      "pkg/local_test.go",
      "tests/package_test.go",
      "b/generated/output.go",
    ],
    nodes: [
      node("a", {
        materials: [
          { path: "a", kind: "directory", track: "structure" },
          { path: "pkg/one.go", kind: "file" },
          { path: "pkg/two.go", kind: "file" },
        ],
      }),
      node("b"),
    ],
    imports: [
      edge("tests/package_test.go", "pkg", "directory"),
      edge("pkg/local_test.go", "a", "directory"),
      edge("tests/package_test.go", "b/generated", "directory"),
    ],
  });
  const result = checkModuleMap(source);
  assert.deepEqual(facts(result, "a").testedBy, ["pkg/local_test.go", "tests/package_test.go"]);
  assert.deepEqual(facts(result, "b").testedBy, []);
  for (const split of [false, true]) {
    const nodes = source.nodes.map((module) =>
      module.id === "a"
        ? { ...module, materials: module.materials.filter(({ path }) => path !== "pkg/two.go") }
        : module,
    );
    if (split)
      nodes.push(
        node("split", {
          materials: [{ path: "pkg/two", kind: "prefix", track: "structure" }],
        }),
      );
    const result = checkModuleMap({ ...source, nodes });
    assert.deepEqual(facts(result, "a").testedBy, ["pkg/local_test.go", "tests/package_test.go"]);
    if (split) assert.deepEqual(facts(result, "split").testedBy, ["tests/package_test.go"]);
  }
});

test("Go package test imports cover an empty directory parent and its children without subpackage leakage", () => {
  const result = checkModuleMap(
    input({
      trackedFiles: ["pkg/alpha.go", "pkg/beta.go", "pkg/sub/nested.go", "tests/package_test.go"],
      nodes: [
        node("project", {
          materials: [{ path: ".", kind: "directory", track: "structure" }],
        }),
        node("package", {
          parentId: "project",
          materials: [{ path: "pkg", kind: "directory", track: "structure" }],
        }),
        node("alpha", {
          parentId: "package",
          materials: [{ path: "pkg/alpha", kind: "prefix", track: "structure" }],
        }),
        node("beta", {
          parentId: "package",
          materials: [{ path: "pkg/beta", kind: "prefix", track: "structure" }],
        }),
        node("subpackage", {
          parentId: "package",
          materials: [{ path: "pkg/sub", kind: "directory", track: "structure" }],
        }),
      ],
      imports: [edge("tests/package_test.go", "pkg", "directory")],
    }),
  );
  assert.equal(facts(result, "package").productionFiles, 0);
  for (const id of ["project", "package", "alpha", "beta"])
    assert.deepEqual(facts(result, id).testedBy, ["tests/package_test.go"]);
  assert.deepEqual(facts(result, "subpackage").testedBy, []);
});

test("direct file test imports roll up through nested ancestors without sibling leakage", () => {
  const result = checkModuleMap(
    input({
      trackedFiles: ["app/middle/leaf/file.ts", "app/sibling/file.ts", "tests/leaf.test.ts"],
      nodes: [
        node("app"),
        node("middle", {
          parentId: "app",
          materials: [{ path: "app/middle", kind: "directory", track: "structure" }],
        }),
        node("leaf", {
          parentId: "middle",
          materials: [{ path: "app/middle/leaf", kind: "directory", track: "structure" }],
        }),
        node("sibling", {
          parentId: "app",
          materials: [{ path: "app/sibling", kind: "directory", track: "structure" }],
        }),
      ],
      imports: [edge("tests/leaf.test.ts", "app/middle/leaf/file.ts")],
    }),
  );
  for (const id of ["app", "middle", "leaf"])
    assert.deepEqual(facts(result, id).testedBy, ["tests/leaf.test.ts"]);
  assert.deepEqual(facts(result, "sibling").testedBy, []);
});

test("coChanges retains eligible facts through issue exceptions and reports each module's ratio", () => {
  const commits = [
    ...history(5, 7),
    commit("a-only", ["a/file.ts"]),
    commit("bulk", ["a/file.ts", "b/file.ts"], 51),
    commit("tent-only", [".tent/a.md"]),
  ];
  commits[0]!.files.push("a/file.ts", "a/deleted.ts", ".tent/ignored.md");
  const result = checkModuleMap(
    input({
      commits,
      nodes: [
        node("a", {
          exceptions: [{ code: "history.always-together", targetId: "b" }],
        }),
        node("b"),
        node("other"),
      ],
    }),
  );
  assert.equal(result.historyCommits, 13);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(facts(result, "a").coChanges, [
    { moduleId: "b", sharedCommits: 5, moduleCommits: 6, ratio: 5 / 6 },
  ]);
  assert.deepEqual(facts(result, "b").coChanges, [
    { moduleId: "a", sharedCommits: 5, moduleCommits: 5, ratio: 1 },
  ]);
});

test("coChanges uses shared support, ratio and lift thresholds before recording evidence", () => {
  for (const commits of [
    history(4, 6),
    history(5, 4),
    [...history(5, 8), commit("a-only", ["a/file.ts"]), commit("b-only", ["b/file.ts"])],
  ]) {
    const result = checkModuleMap(input({ commits }));
    assert.deepEqual(facts(result, "a").coChanges, []);
    assert.deepEqual(facts(result, "b").coChanges, []);
  }
});

test("generated pair facts remain available when their generated-apart issue is excepted", () => {
  const result = checkModuleMap(
    input({
      trackedFiles: ["a/file.ts", "b/generated/file.ts", "other/file.ts"],
      commits: history().map((entry) => ({
        ...entry,
        files: entry.files.map((file) => (file === "b/file.ts" ? "b/generated/file.ts" : file)),
      })),
      nodes: [
        node("a"),
        node("b", { exceptions: [{ code: "history.generated-apart", targetId: "a" }] }),
        node("other"),
      ],
    }),
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(facts(result, "a").coChanges, [
    { moduleId: "b", sharedCommits: 5, moduleCommits: 5, ratio: 1 },
  ]);
});

test("ancestor and descendant history is internal, and repeated files cannot form self-pairs", () => {
  const result = checkModuleMap(
    input({
      trackedFiles: ["a/file.ts", "a/child/file.ts", "other/file.ts"],
      nodes: [
        node("a"),
        node("child", {
          parentId: "a",
          materials: [{ path: "a/child", kind: "directory", track: "structure" }],
        }),
        node("other"),
      ],
      commits: history().map((entry) => ({
        ...entry,
        files: entry.files.flatMap((file) =>
          file === "b/file.ts" ? ["a/child/file.ts", "a/child/file.ts"] : [file, file],
        ),
      })),
    }),
  );
  assert.deepEqual(result.issues, []);
  for (const module of result.modules) assert.deepEqual(module.coChanges, []);
});

test("test and cochange facts stay deterministic under reordered and repeated inputs", () => {
  const source = input({
    trackedFiles: ["a/file.ts", "b/file.ts", "c/file.ts", "other/file.ts", "tests/a.test.ts"],
    nodes: [node("a"), node("b", { path: "z" }), node("c", { path: "y" }), node("other")],
    imports: [edge("tests/a.test.ts", "a/file.ts"), edge("tests/a.test.ts", "a/file.ts")],
    commits: history().map((entry) => ({
      ...entry,
      files: entry.files.includes("a/file.ts") ? [...entry.files, "c/file.ts"] : entry.files,
    })),
  });
  const result = checkModuleMap(source);
  assert.deepEqual(
    facts(result, "a").coChanges.map(({ moduleId }) => moduleId),
    ["c", "b"],
  );
  assert.deepEqual(
    checkModuleMap({
      trackedFiles: [...source.trackedFiles].reverse(),
      nodes: [...source.nodes].reverse(),
      imports: [...source.imports].reverse(),
      commits: [...source.commits].reverse().map((entry) => ({
        ...entry,
        files: [...entry.files, ...entry.files].reverse(),
      })),
    }),
    result,
  );
});
