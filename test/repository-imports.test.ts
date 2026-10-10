import assert from "node:assert/strict";
import test from "node:test";
import { extractRepositoryImports, type RepositorySource } from "../src/core/repository-imports.js";
import { repositoryFacts, repositoryDirectoryGraph } from "../src/core/repository-facts.js";

const source = (path: string, content = ""): RepositorySource => ({ path, content });
test("script imports resolve relative paths, export/require/dynamic and scoped TS aliases without comment/string examples", () => {
  const files = [
    source(
      "web/tsconfig.json",
      '{/* config */"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"],"alias":["./src/exact.ts"],},},}',
    ),
    source("tsconfig.json", '{"compilerOptions":{"paths":{"@/*":["./wrong/*"]}}}'),
    source(
      "web/src/entry.ts",
      `
      import type { A } from '@/a';
      export { B } from './b.js';
      const c = require('./c');
      import('./d.mjs');
      import 'alias';
      import './theme.css?raw';
      // import './bad.ts';
      /* require('./bad.ts') */
      const example = "import './bad.ts'";
      const template = \`require('./bad.ts')\`;
      const regex = /import './bad.ts'/;
      import './test/helper.ts';
      import external from 'package';
    `,
    ),
    ...[
      "web/src/a.ts",
      "web/src/b.ts",
      "web/src/c/index.ts",
      "web/src/d.mts",
      "web/src/exact.ts",
      "web/src/theme.css",
      "web/src/bad.ts",
      "web/src/test/helper.ts",
      "wrong/a.ts",
    ].map((file) => source(file)),
    source("web/src/entry.test.ts", "import './bad.ts';"),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.edges.map((edge) => edge.to).sort(), [
    "web/src/a.ts",
    "web/src/b.ts",
    "web/src/c/index.ts",
    "web/src/d.mts",
    "web/src/exact.ts",
    "web/src/theme.css",
  ]);
  assert.ok(result.edges.every((edge) => edge.from === "web/src/entry.ts" && edge.kind === "file"));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(extractRepositoryImports([...files].reverse()), result);
});

test("Go edges retain directory targets, exclude tests, and obey nested module boundaries", () => {
  const result = extractRepositoryImports([
    source("go.mod", "module example.test/main\n"),
    source(
      "cmd/main.go",
      'package main\nimport (\n "example.test/main/store"\n named "example.test/main/core"\n "fmt"\n)\n',
    ),
    source("store/store.go", 'package store\nimport _ "example.test/main/core"'),
    source("core/core.go", 'package core\n// import "example.test/main/store"'),
    source("store/store_test.go", 'package store\nimport "example.test/main/cmd"'),
    source("other/go.mod", "module example.test/other\n"),
    source("other/main.go", "package other\nimport `example.test/other/lib`"),
    source("other/lib/lib.go", "package lib"),
  ]);
  assert.deepEqual(
    result.edges.map(({ from, to, kind }) => ({ from, to, kind })),
    [
      { from: "cmd/main.go", to: "core", kind: "directory" },
      { from: "cmd/main.go", to: "store", kind: "directory" },
      { from: "other/main.go", to: "other/lib", kind: "directory" },
      { from: "store/store.go", to: "core", kind: "directory" },
    ],
  );
  assert.deepEqual(result.issues, []);
});

test("Go local imports require a production Go file in the target package directory", () => {
  for (const target of ["web/view.ts", "web/view.py", "web/view_test.go", "web/view.go"]) {
    const result = extractRepositoryImports([
      source("go.mod", "module example.test/app\n"),
      source("cmd/main.go", 'package main\nimport "example.test/app/web"\n'),
      source(target),
    ]);
    if (target === "web/view.go") {
      assert.deepEqual(result.edges, [
        { from: "cmd/main.go", to: "web", kind: "directory", specifier: "example.test/app/web" },
      ]);
      assert.deepEqual(result.issues, []);
    } else {
      assert.deepEqual(result.edges, [], target);
      assert.deepEqual(result.issues, [
        {
          file: "cmd/main.go",
          specifier: "example.test/app/web",
          reason: "Local Go package is absent from production files",
        },
      ]);
    }
  }
});

test("invalid TypeScript path configuration shapes report issues and preserve other import facts", () => {
  const invalid = [
    null,
    [],
    42,
    { compilerOptions: null },
    { compilerOptions: [] },
    { compilerOptions: 42 },
    { compilerOptions: { baseUrl: 42 } },
    { compilerOptions: { paths: null } },
    { compilerOptions: { paths: [] } },
    { compilerOptions: { paths: 42 } },
    { compilerOptions: { paths: { "@app/*": 42 } } },
    { compilerOptions: { paths: { "@app/*": "src/*" } } },
    { compilerOptions: { paths: { "@app/*": ["src/*", 42] } } },
  ];
  for (const config of invalid) {
    const result = extractRepositoryImports([
      source("tsconfig.json", JSON.stringify(config)),
      source("src/main.ts", 'import "@app/helper"; import "./helper";'),
      source("src/helper.ts"),
    ]);
    assert.deepEqual(result.edges, [
      { from: "src/main.ts", to: "src/helper.ts", kind: "file", specifier: "./helper" },
    ]);
    assert.deepEqual(
      result.issues,
      [{ file: "tsconfig.json", reason: "Invalid TypeScript path configuration" }],
      JSON.stringify(config),
    );
    assert.equal(result.scannedFiles, 2);
  }
});

test("Python imports support src layout, relative modules, from-dot members and comma imports", () => {
  const result = extractRepositoryImports([
    source("src/pkg/__init__.py"),
    source("src/pkg/helper.py"),
    source("src/pkg/other.py"),
    source("src/pkg/sub/__init__.py"),
    source(
      "src/pkg/sub/main.py",
      `from .. import helper\nfrom ..other import Name\nimport pkg.helper, pkg.other as alias\nfrom pkg import (helper, other)\n# from pkg import fake\ntext = """\nfrom pkg import fake\n"""\n`,
    ),
    source("src/pkg/fake.py"),
    source("src/pkg/test_hidden.py", "from pkg import fake"),
  ]);
  assert.deepEqual([...new Set(result.edges.map((edge) => edge.to))].sort(), [
    "src/pkg/__init__.py",
    "src/pkg/helper.py",
    "src/pkg/other.py",
  ]);
  assert.ok(result.edges.every((edge) => edge.from === "src/pkg/sub/main.py"));
});

test("directory graph uses SCC layers and no test-only reverse edges", () => {
  const files = [
    source("src/cli/main.ts", "import '../core/a.js'"),
    source("src/core/a.ts", "import '../markdown/b.js'"),
    source("src/markdown/b.ts", "import '../core/a.js'; import '../base/c.js'"),
    source("src/base/c.ts"),
    source("src/base/c.test.ts", "import '../cli/main.js'"),
  ];
  const graph = repositoryDirectoryGraph(
    extractRepositoryImports(files).edges,
    files.map((file) => file.path),
    2,
  );
  assert.deepEqual(graph.entries, ["src/cli"]);
  assert.deepEqual(graph.cycles, [["src/core", "src/markdown"]]);
  assert.deepEqual(graph.layers, [
    { directory: "src/cli", layer: 0 },
    { directory: "src/core", layer: 1 },
    { directory: "src/markdown", layer: 1 },
    { directory: "src/base", layer: 2 },
  ]);
});

test("repository facts identify guidance, generated trees, flat code and test directories", () => {
  const facts = repositoryFacts([
    source("AGENTS.md"),
    source("nested/CONTRIBUTING.rst"),
    source("server/doc.go"),
    source(".cursor/rules/style.mdc"),
    source("proto/gen/api/code.pb.go"),
    source("web/types/api_pb.ts"),
    ...Array.from({ length: 21 }, (_, i) => source(`src/core/card-${i}.ts`)),
    ...Array.from({ length: 21 }, (_, i) => source(`test/card-${i}.test.ts`)),
  ]);
  assert.deepEqual(facts.guidanceFiles, [
    ".cursor/rules/style.mdc",
    "AGENTS.md",
    "nested/CONTRIBUTING.rst",
    "server/doc.go",
  ]);
  assert.deepEqual(
    facts.generatedDirectories.map((item) => item.directory),
    ["proto/gen", "web/types"],
  );
  assert.deepEqual(
    facts.flatDirectories.map((item) => item.directory),
    ["src/core", "test"],
  );
  assert.deepEqual(facts.flatDirectories[0]!.groups, [{ prefix: "src/core/card-", count: 21 }]);
  assert.equal(facts.imports.scannedFiles, 24);
});
