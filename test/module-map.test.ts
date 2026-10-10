import assert from "node:assert/strict";
import test from "node:test";
import { checkModuleMap, type ModuleMapInput, type ModuleMapNode } from "../src/core/module-map.js";
import type { RepositoryImport } from "../src/core/repository-imports.js";
import type { ScanCommit } from "../src/core/workspace-scan.js";
import { materialCoverageContains } from "../src/core/material-coverage.js";

const node = (id: string, overrides: Partial<ModuleMapNode> = {}): ModuleMapNode => ({
  id,
  path: id,
  name: id,
  body: "",
  materials: [{ path: id, kind: "directory", track: "structure" }],
  ...overrides,
  ...(overrides.materials
    ? {
        materials: overrides.materials.map((material) =>
          material.kind === "file" ? material : { ...material, track: "structure" as const },
        ),
      }
    : {}),
});
const files = (directory: string, count: number, prefix = "file-") =>
  Array.from({ length: count }, (_, i) => `${directory}/${prefix}${i}.ts`);
const input = (
  trackedFiles: string[],
  nodes: ModuleMapNode[],
  overrides: Partial<ModuleMapInput> = {},
): ModuleMapInput => ({
  trackedFiles,
  nodes,
  imports: [],
  commits: [],
  ...overrides,
});
const imports = (from: string, to: string, count: number, kind: "file" | "directory" = "file") =>
  Array.from({ length: count }, (_, i): RepositoryImport => ({
    from: `${from}/file-${i}.ts`,
    to: kind === "file" ? `${to}/file-0.ts` : to,
    kind,
    specifier: to,
  }));
const commit = (id: string, files: string[], changedFiles = files.length): ScanCommit => ({
  commit: id,
  files,
  changedFiles,
});
const history = (shared = 5, unrelated = 5): ScanCommit[] => [
  ...Array.from({ length: shared }, (_, i) => commit(`pair-${i}`, ["a/file.ts", "b/file.ts"])),
  ...Array.from({ length: unrelated }, (_, i) => commit(`other-${i}`, ["other/file.ts"])),
];
const codes = (result: ReturnType<typeof checkModuleMap>) =>
  result.issues.map((issue) => issue.code);
const coverageOnly = (trackedFiles: string[]) =>
  node("setup", { materials: trackedFiles.map((path) => ({ path, kind: "file" })) });

test("coverage includes file-only Nodes, while module membership uses the most specific material", () => {
  const tracked = [
    "package.json",
    "src/main.ts",
    "src/card-one.ts",
    "src/card-nested/a.ts",
    "src/cardinality.ts",
    "src/special.ts",
    "docs/a.md",
    "docs/b.md",
  ];
  const result = checkModuleMap(
    input(tracked, [
      node("root", { materials: [{ path: "src", kind: "directory" }] }),
      node("cards", {
        materials: [
          { path: "src/card-", kind: "prefix" },
          { path: "src/special.ts", kind: "file" },
        ],
      }),
      node("setup", { body: "map.uncovered", materials: [{ path: "package.json", kind: "file" }] }),
    ]),
  );
  assert.deepEqual(
    result.modules.map(({ id, files }) => ({ id, files })),
    [
      { id: "cards", files: ["src/card-nested/a.ts", "src/card-one.ts", "src/special.ts"] },
      { id: "root", files: ["src/cardinality.ts", "src/main.ts"] },
    ],
  );
  assert.deepEqual(result.issues, [
    {
      code: "map.uncovered",
      object: "docs",
      facts: { directory: "docs", count: 2, files: ["docs/a.md", "docs/b.md"] },
      fix: "Assign the listed files to a Node's file, directory or prefix materials.",
    },
  ]);
});

test("equal materials choose deterministically and a clean map has no findings", () => {
  const tracked = ["a/file.ts", "package.json"];
  const nodes = [
    node("z", { materials: [{ path: "a", kind: "directory" }] }),
    node("a"),
    coverageOnly(["package.json"]),
  ];
  const result = checkModuleMap(input(tracked, nodes));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.modules.find(({ id }) => id === "a")!.files, ["a/file.ts"]);
  assert.deepEqual(result.modules.find(({ id }) => id === "z")!.files, []);
  assert.deepEqual(checkModuleMap(input([...tracked].reverse(), [...nodes].reverse())), result);
});

test("only structure-tracked directories or prefixes define modules; ordinary and file materials still cover", () => {
  const tracked = ["old/a.ts", "tracked/a.ts", "single.ts"];
  const result = checkModuleMap(
    input(tracked, [
      { ...node("old"), materials: [{ path: "old", kind: "directory" }] },
      {
        ...node("tracked"),
        materials: [{ path: "tracked", kind: "directory", track: "structure" }],
      },
      { ...node("single"), materials: [{ path: "single.ts", kind: "file" }] },
    ]),
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.modules.map(({ id }) => id),
    ["tracked"],
  );
});

test("directory and prefix membership use the shared coverage authority", () => {
  const candidates = [
    "src/a.ts",
    "src/nested/a.ts",
    "src-other/a.ts",
    "src",
    "src/../a.ts",
    "/src/a.ts",
    "src\\a.ts",
  ];
  for (const kind of ["directory", "prefix"] as const) {
    const material = {
      path: kind === "directory" ? "src" : "src/",
      kind,
      track: "structure" as const,
    };
    const result = checkModuleMap(input(candidates, [{ ...node("src"), materials: [material] }]));
    assert.deepEqual(
      result.modules[0]!.files,
      candidates.filter((file) => materialCoverageContains({ kind, prefix: "src/" }, file)).sort(),
    );
  }
});

test("shared platform comparison matches file, prefix and package-directory materials while retaining Git paths", () => {
  const tracked = [
    ...files("src", 3, "card-"),
    "src/card-nested/a.ts",
    "src/tools/file.ts",
    ...files("lib/b", 3),
    "package.json",
  ];
  const nodes = [
    node("cards", {
      materials: [
        { path: "SRC/Card-", kind: "prefix" },
        { path: "SRC/Tools", kind: "directory" },
      ],
    }),
    node("b", { materials: [{ path: "LIB/B", kind: "directory" }] }),
    coverageOnly(["PACKAGE.JSON"]),
  ];
  const edges = [
    ...imports("src", "LIB/B", 3, "directory").map((edge, i) => ({
      ...edge,
      from: `src/card-${i}.ts`,
    })),
    ...imports("lib/b", "SRC/Tools", 3, "directory"),
  ];
  const result = checkModuleMap(input(tracked, nodes, { imports: edges }));
  if (process.platform !== "win32") {
    assert.ok(codes(result).every((code) => code === "map.uncovered"));
    return;
  }
  assert.deepEqual(codes(result), ["deps.cycle"]);
  assert.deepEqual(result.unassignedImports, []);
  assert.deepEqual(result.modules.find(({ id }) => id === "cards")!.files, [
    "src/card-0.ts",
    "src/card-1.ts",
    "src/card-2.ts",
    "src/card-nested/a.ts",
    "src/tools/file.ts",
  ]);
  const prefixOnly = nodes.map((n) =>
    n.id === "b"
      ? {
          ...n,
          materials: [
            { path: "LIB/B/file-", kind: "prefix" as const, track: "structure" as const },
          ],
        }
      : n,
  );
  const unresolved = checkModuleMap(input(tracked, prefixOnly, { imports: edges }));
  assert.equal(unresolved.unassignedImports.length, 3);
  assert.deepEqual(
    checkModuleMap(
      input([...tracked].reverse(), [...nodes].reverse(), {
        imports: [...edges].reverse(),
      }),
    ),
    result,
  );
});

test("size excludes generated, tests and vendor code and requires two groups of at least three", () => {
  const handwritten = [...files("large", 10, "alpha-"), ...files("large", 10, "beta-")];
  const excluded = [
    ...files("large/generated", 20),
    ...files("large/test", 20),
    ...files("large/vendor", 20),
    ...files("large/third_party", 20),
  ];
  const result = checkModuleMap(input([...handwritten, ...excluded], [node("large")]));
  assert.deepEqual(codes(result), ["module.oversized"]);
  assert.equal(result.modules[0]!.productionFiles, 20);
  assert.deepEqual(result.issues[0]!.facts.groups, [
    { path: "large/alpha-", files: 10 },
    { path: "large/beta-", files: 10 },
  ]);
  assert.deepEqual(codes(checkModuleMap(input(handwritten.slice(1), [node("large")]))), []);
  assert.deepEqual(codes(checkModuleMap(input(files("large", 30), [node("large")]))), []);
  const smallGroup = [...files("large", 18, "alpha-"), ...files("large", 2, "beta-")];
  assert.deepEqual(codes(checkModuleMap(input(smallGroup, [node("large")]))), []);
});

test("size uses strict share and mathematical sibling median, with oversized taking precedence", () => {
  const big = [...files("a", 11, "alpha-"), ...files("a", 10, "beta-")];
  const others = [...files("b", 6), ...files("c", 8), ...files("filler", 165)];
  const nodes = [node("a"), node("b"), node("c"), coverageOnly(files("filler", 165))];
  assert.deepEqual(codes(checkModuleMap(input([...big, ...others], nodes))), []);
  const skewed = checkModuleMap(input([...big, "a/beta-extra.ts", ...others], nodes));
  assert.deepEqual(codes(skewed), ["module.skewed"]);
  assert.equal(skewed.issues[0]!.facts.siblingMedian, 7);
  const total100 = [
    ...files("a", 10, "alpha-"),
    ...files("a", 10, "beta-"),
    ...files("filler", 80),
  ];
  const shareNodes = [node("a"), coverageOnly(files("filler", 80))];
  assert.deepEqual(codes(checkModuleMap(input(total100, shareNodes))), []);
  assert.deepEqual(codes(checkModuleMap(input([...total100, "a/beta-extra.ts"], shareNodes))), [
    "module.oversized",
  ]);
  assert.deepEqual(codes(checkModuleMap(input(big, [node("a"), node("b")]))), ["module.oversized"]);
});

test("only leaf modules receive size issues, and one size rule in their body suppresses it", () => {
  const tracked = [...files("a", 12, "alpha-"), ...files("a", 12, "beta-"), "a/child/file.ts"];
  assert.deepEqual(
    codes(
      checkModuleMap(
        input(tracked, [
          node("a"),
          node("child", { parentId: "a", materials: [{ path: "a/child", kind: "directory" }] }),
        ]),
      ),
    ),
    [],
  );
  assert.deepEqual(
    codes(
      checkModuleMap(
        input(tracked, [node("a", { body: "An intentional allow:module.oversized core." })]),
      ),
    ),
    [],
  );
  assert.deepEqual(
    codes(checkModuleMap(input(tracked, [node("a", { body: "module.oversizedness" })]))),
    ["module.oversized"],
  );
  for (const body of [
    "必须修复 module.oversized",
    "module.oversized",
    "allow: module.oversized",
    "disallow:module.oversized",
    "allow:module.oversizedness",
  ]) {
    assert.deepEqual(codes(checkModuleMap(input(tracked, [node("a", { body })]))), [
      "module.oversized",
    ]);
  }
});

test("cycles count real imports, ignore tests/barrels and discard weak reverse edges", () => {
  const tracked = [...files("a", 31), ...files("b", 3), "a/index.ts", "b/index.ts", "a/x.test.ts"];
  const edges = [...imports("a", "b", 3), ...imports("b", "a", 3)];
  const result = checkModuleMap(
    input(tracked, [node("a"), node("b")], { imports: [...edges, edges[0]!] }),
  );
  assert.deepEqual(codes(result), ["deps.cycle"]);
  assert.deepEqual(result.issues[0]!.facts, {
    nodeIds: ["a", "b"],
    forwardImports: 3,
    reverseImports: 3,
  });
  assert.deepEqual(
    codes(
      checkModuleMap(
        input(tracked, [node("a"), node("b")], {
          imports: [
            ...imports("a", "b", 3),
            ...imports("b", "a", 2),
            { from: "b/index.ts", to: "a/file-0.ts", kind: "file", specifier: "a" },
            { from: "b/file-0.ts", to: "a/index.ts", kind: "file", specifier: "a" },
            { from: "b/file-0.ts", to: "a/x.test.ts", kind: "file", specifier: "a" },
            { from: "a/x.test.ts", to: "b/file-0.ts", kind: "file", specifier: "b" },
          ],
        }),
      ),
    ),
    [],
  );
  assert.deepEqual(
    codes(
      checkModuleMap(
        input(tracked, [node("a"), node("b")], {
          imports: [...imports("a", "b", 31), ...imports("b", "a", 3)],
        }),
      ),
    ),
    [],
  );
  assert.deepEqual(
    codes(
      checkModuleMap(
        input(tracked, [node("a"), node("b")], {
          imports: [...imports("a", "b", 30), ...imports("b", "a", 3)],
        }),
      ),
    ),
    ["deps.cycle"],
  );
});

test("package directory targets retain their directory and diagnose ambiguous membership", () => {
  const tracked = [...files("pkg/a", 3), ...files("pkg/b", 3)];
  const edges = [
    ...imports("pkg/a", "pkg/b", 3, "directory"),
    ...imports("pkg/b", "pkg/a", 3, "directory"),
  ];
  const nodes = [
    node("a", { materials: [{ path: "pkg/a", kind: "directory" }] }),
    node("b", { materials: [{ path: "pkg/b", kind: "directory" }] }),
  ];
  const result = checkModuleMap(input(tracked, nodes, { imports: edges }));
  assert.deepEqual(codes(result), ["deps.cycle"]);
  assert.deepEqual(result.unassignedImports, []);
  const prefixes = nodes.map((n) => ({
    ...n,
    materials: [
      { path: `pkg/${n.id}/file-`, kind: "prefix" as const, track: "structure" as const },
    ],
  }));
  const unassigned = checkModuleMap(input(tracked, prefixes, { imports: edges }));
  assert.deepEqual(unassigned.issues, []);
  assert.equal(unassigned.unassignedImports.length, 6);
  assert.match(unassigned.unassignedImports[0]!.reason, /no directory material owner/);
  const filesOnlyTarget = checkModuleMap(
    input(tracked, [nodes[0]!, coverageOnly(files("pkg/b", 3))], { imports: edges }),
  );
  assert.deepEqual(filesOnlyTarget.issues, []);
  assert.deepEqual(filesOnlyTarget.unassignedImports, []);
});

test("a Go package whose production files share one module has that owner even through attached files", () => {
  const tracked = [
    "cmd/main.go",
    "server/server.go",
    "server/cors.go",
    "server/server_test.go",
    "other/file.go",
  ];
  const nodes = [
    node("server", {
      materials: [
        { path: "cmd", kind: "directory" },
        { path: "server/server.go", kind: "file" },
        { path: "server/cors.go", kind: "file" },
      ],
    }),
    coverageOnly(["server/server_test.go", "other/file.go"]),
  ];
  const edges: RepositoryImport[] = [
    { from: "cmd/main.go", to: "server", kind: "directory", specifier: "example/server" },
  ];
  const result = checkModuleMap(input(tracked, nodes, { imports: edges }));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.unassignedImports, []);
  const partial = nodes.map((n) =>
    n.id === "server"
      ? { ...n, materials: n.materials.filter((m) => m.path !== "server/cors.go") }
      : n,
  );
  const split = [
    ...partial,
    node("cors", { materials: [{ path: "server/cors", kind: "prefix" }] }),
  ];
  assert.equal(
    checkModuleMap(input(tracked, split, { imports: edges })).unassignedImports.length,
    1,
  );
  assert.equal(
    checkModuleMap(input(tracked, partial, { imports: edges })).unassignedImports.length,
    1,
  );
});

test("cycles between ancestor and descendant modules are internal", () => {
  const tracked = [...files("a", 3), ...files("a/b", 3)];
  const nodes = [
    node("a"),
    node("b", { parentId: "a", materials: [{ path: "a/b", kind: "directory" }] }),
  ];
  assert.deepEqual(
    codes(
      checkModuleMap(
        input(tracked, nodes, {
          imports: [...imports("a", "a/b", 3), ...imports("a/b", "a", 3)],
        }),
      ),
    ),
    [],
  );
});

test("history thresholds use eligible first-parent commits and one touch per module per commit", () => {
  const tracked = ["a/file.ts", "b/file.ts", "other/file.ts"];
  const nodes = [node("a"), node("b"), coverageOnly(["other/file.ts"])];
  const commits = [...history(), commit("bulk", tracked, 51)];
  commits[0]!.files.push("a/file.ts", "a/deleted.ts");
  const result = checkModuleMap(input(tracked, nodes, { commits }));
  assert.deepEqual(codes(result), ["history.always-together"]);
  assert.equal(result.historyCommits, 10);
  assert.equal(result.issues[0]!.facts.lift, 2);
  assert.deepEqual(result.issues[0]!.facts.moduleCommits, [5, 5]);
  assert.deepEqual(codes(checkModuleMap(input(tracked, nodes, { commits: history(4, 6) }))), []);
  assert.deepEqual(codes(checkModuleMap(input(tracked, nodes, { commits: history(5, 4) }))), []);
  const notTogether = [
    ...history(5, 8),
    commit("a-only", ["a/file.ts"]),
    commit("b-only", ["b/file.ts"]),
  ];
  assert.deepEqual(codes(checkModuleMap(input(tracked, nodes, { commits: notTogether }))), []);
});

test("generated-apart requires a strict majority of the module's tracked members", () => {
  const run = (generated: number, handwritten: number) => {
    const tracked = [
      "a/file.ts",
      ...files("b/generated", generated),
      ...files("b", handwritten),
      "other/file.ts",
    ];
    const commits = history().map((c) => ({
      ...c,
      files: c.files.map((f) => (f === "b/file.ts" ? "b/generated/file-0.ts" : f)),
    }));
    return checkModuleMap(
      input(tracked, [node("a"), node("b"), coverageOnly(["other/file.ts"])], { commits }),
    );
  };
  assert.deepEqual(codes(run(2, 2)), ["history.always-together"]);
  assert.deepEqual(codes(run(3, 1)), ["history.generated-apart"]);
});

test("a resolved pair exception on either side suppresses only that pair and rule", () => {
  const tracked = [...files("a", 3), ...files("b", 3), "other/file.ts"];
  const overrides = {
    imports: [...imports("a", "b", 3), ...imports("b", "a", 3)],
    commits: history(),
  };
  const setup = coverageOnly(["other/file.ts"]);
  const noTarget = node("a", { body: "deps.cycle", exceptions: [{ code: "deps.cycle" }] });
  assert.deepEqual(codes(checkModuleMap(input(tracked, [noTarget, node("b"), setup], overrides))), [
    "deps.cycle",
    "history.always-together",
  ]);
  const exception = node("b", { exceptions: [{ code: "deps.cycle", targetId: "a" }] });
  assert.deepEqual(
    codes(checkModuleMap(input(tracked, [node("a"), exception, setup], overrides))),
    ["history.always-together"],
  );
  exception.exceptions = [
    ...exception.exceptions!,
    { code: "history.always-together", targetId: "a" },
  ];
  assert.deepEqual(
    codes(checkModuleMap(input(tracked, [node("a"), exception, setup], overrides))),
    [],
  );
});

test("all returned facts and issues remain stable under reordered repository inputs", () => {
  const tracked = [...files("a", 3), ...files("b", 3), "other/file.ts", "uncovered/file.md"];
  const nodes = [node("b"), node("a"), coverageOnly(["other/file.ts"])];
  const edges = [...imports("a", "b", 3), ...imports("b", "a", 3)];
  const commits = history();
  const result = checkModuleMap(input(tracked, nodes, { imports: edges, commits }));
  const permuted = input([...tracked].reverse(), [...nodes].reverse(), {
    imports: [...edges].reverse(),
    commits: [...commits].reverse().map((c) => ({ ...c, files: [...c.files].reverse() })),
  });
  assert.deepEqual(checkModuleMap(permuted), result);
});
