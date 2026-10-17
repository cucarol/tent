import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  extractRepositoryImports,
  extractRepositoryTestImports,
  type RepositorySource,
} from "../src/core/base/repository-imports.js";
import { readRepositorySources } from "../src/fs/repository-sources.js";
import { testScratchRoot } from "./scratch.js";

const source = (path: string, content = ""): RepositorySource => ({ path, content });
const pairs = (files: RepositorySource[]) =>
  extractRepositoryTestImports(files).edges.map(({ from, to }) => [from, to]);

test("test script imports reuse aliases and literal import forms without following helpers", () => {
  const files = [
    source("tsconfig.json", '{"compilerOptions":{"paths":{"@app/*":["src/*"]}}}'),
    source("src/main.ts", 'import "./value.js";'),
    source("src/value.ts"),
    source("src/indirect.ts"),
    source("tests/helper.ts", 'import "../src/indirect";'),
    source(
      "tests/main.test.ts",
      `
      import type {} from '@app/main';
      export * from '../src/main.js';
      require('../src/value'); require('../src/value'); import('../src/value.js');
      import './helper';
      // import '../src/indirect';
      const text = "import '../src/indirect'";
    `,
    ),
    source("src/colocated.spec.ts", 'import "./main.js";'),
  ];
  const result = extractRepositoryTestImports(files);
  assert.equal(result.scannedFiles, 3);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.edges.map(({ from, to, specifier }) => `${from}|${to}|${specifier}`).sort(),
    [
      "src/colocated.spec.ts|src/main.ts|./main.js",
      "tests/helper.ts|src/indirect.ts|../src/indirect",
      "tests/main.test.ts|src/main.ts|@app/main",
      "tests/main.test.ts|src/main.ts|../src/main.js",
      "tests/main.test.ts|src/value.ts|../src/value",
      "tests/main.test.ts|src/value.ts|../src/value.js",
    ].sort(),
  );
  assert.deepEqual(extractRepositoryTestImports([...files].reverse()), result);
  assert.deepEqual(extractRepositoryImports(files).edges, [
    { from: "src/main.ts", to: "src/value.ts", kind: "file", specifier: "./value.js" },
  ]);
});

test("Rich-style Python tests resolve root packages, members, aliases and relative imports", () => {
  const files = [
    source("rich/__init__.py"),
    source("rich/console.py"),
    source("rich/text.py"),
    source("src/other/value.py"),
    source("lib/legacy/value.py"),
    source("tests/helper.py"),
    source(
      "tests/test_console.py",
      `
from rich.console import Console as ConsoleAlias
from rich import (text as text_alias, console)
import rich.text as text, other.value
import legacy.value
from .helper import fixture
# from rich.missing import ignored
EXAMPLE = "from rich.missing import ignored"
`,
    ),
    source("rich/test_text.py", "from .text import Text\nfrom . import console\n"),
  ];
  const result = extractRepositoryTestImports(files);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    [
      ...new Set(
        result.edges.filter((edge) => edge.from === "tests/test_console.py").map((edge) => edge.to),
      ),
    ].sort(),
    [
      "lib/legacy/value.py",
      "rich/__init__.py",
      "rich/console.py",
      "rich/text.py",
      "src/other/value.py",
    ],
  );
  assert.deepEqual(
    pairs(files).filter(([from]) => from === "rich/test_text.py"),
    [
      ["rich/test_text.py", "rich/__init__.py"],
      ["rich/test_text.py", "rich/console.py"],
      ["rich/test_text.py", "rich/text.py"],
    ],
  );
  assert.deepEqual(extractRepositoryImports(files).edges, []);
});

test("Go test imports retain production package directory targets", () => {
  const result = extractRepositoryTestImports([
    source("go.mod", "module example.test/app"),
    source("store/store.go", "package store"),
    source("store/store_test.go", 'package store_test\nimport "example.test/app/store"'),
    source("tests/main_test.go", 'package tests\nimport "example.test/app/testonly"'),
    source("testonly/only_test.go", "package testonly"),
  ]);
  assert.deepEqual(result.edges, [
    {
      from: "store/store_test.go",
      to: "store",
      kind: "directory",
      specifier: "example.test/app/store",
    },
  ]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.reason, /absent from production/);
});

test("Java and C# test declarations reuse existing explicit type import resolution", () => {
  assert.deepEqual(
    pairs([
      source("src/main/java/app/Thing.java", "package app; public class Thing {}"),
      source("src/test/java/app/ThingTest.java", "package app; import app.Thing;"),
      source("app/App.csproj", "<Project/>"),
      source("app/Thing.cs", "namespace App; public class Thing {}"),
      source(
        "tests/Tests.csproj",
        '<Project><ItemGroup><ProjectReference Include="../app/App.csproj" /></ItemGroup></Project>',
      ),
      source("tests/Thing.cs", "using Thing = App.Thing;"),
    ]),
    [
      ["src/test/java/app/ThingTest.java", "src/main/java/app/Thing.java"],
      ["tests/Thing.cs", "app/Thing.cs"],
    ],
  );
});

test("C/C++ and PHP tests reuse literal include and PSR-4 evidence", () => {
  assert.deepEqual(
    pairs([
      source("include/value.h"),
      source("tests/value.cpp", '#include "../include/value.h"\n'),
      source("composer.json", '{"autoload":{"psr-4":{"App\\\\":"src/"}}}'),
      source("src/Thing.php", "<?php namespace App; class Thing {}"),
      source("tests/Thing.php", "<?php use App\\Thing;"),
    ]),
    [
      ["tests/Thing.php", "src/Thing.php"],
      ["tests/value.cpp", "include/value.h"],
    ],
  );
});

test("Rust conventional integration tests and dev path dependencies use existing module resolution", () => {
  const files = [
    source(
      "Cargo.toml",
      '[package]\nname="app"\nedition="2021"\n[dev-dependencies]\nhelper={path="helper"}\n[[test]]\nname="custom"\npath="tests/custom/entry.rs"',
    ),
    source("src/lib.rs", "pub mod value; #[cfg(test)] mod unit;"),
    source("src/value.rs", "pub struct Value;"),
    source("src/unit.rs", "use crate::value::Value;"),
    source("helper/Cargo.toml", '[package]\nname="helper"\nedition="2021"'),
    source("helper/src/lib.rs", "pub struct Helper;"),
    source("tests/value.rs", "use app::value::Value; #[test] fn check() { use helper::Helper; }"),
    source("tests/nested/main.rs", "use app::value::Value;"),
    source("tests/custom/entry.rs", "use app::value::Value;"),
  ];
  const result = extractRepositoryTestImports(files);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.edges.map(({ from, to }) => [from, to]),
    [
      ["tests/custom/entry.rs", "src/value.rs"],
      ["tests/nested/main.rs", "src/value.rs"],
      ["tests/value.rs", "helper/src/lib.rs"],
      ["tests/value.rs", "src/value.rs"],
    ],
  );
  assert.deepEqual(extractRepositoryImports(files).edges, [
    { from: "src/lib.rs", to: "src/value.rs", kind: "file", specifier: "mod value" },
  ]);
  assert.deepEqual(extractRepositoryTestImports(files, { rust: false }).edges, []);
});

test("test import issues remain explicit without production importer edges", () => {
  const result = extractRepositoryTestImports([
    source("src/main.ts", 'import "./missing";'),
    source("tests/main.test.ts", 'import "../src/missing";'),
    source("tests/test_main.py", "from ..missing import Item"),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every((issue) => issue.file.startsWith("tests/")));
  assert.equal(result.scannedFiles, 2);
});

test("source reader opts into test bytes and preserves default imports and symlink protection", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "test-import-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await fs.mkdir(path.join(root, "tests"));
  await fs.writeFile(path.join(root, "main.ts"), 'import "./value";');
  await fs.writeFile(path.join(root, "value.ts"), "export {};");
  await fs.writeFile(path.join(root, "tests/main.test.ts"), 'import "../main";');
  const tracked = ["main.ts", "value.ts", "tests/main.test.ts", "README.md"];
  const ordinary = await readRepositorySources(root, tracked);
  const withTests = await readRepositorySources(root, tracked, { includeTests: true });
  assert.deepEqual(ordinary.errors, []);
  assert.deepEqual(withTests.errors, []);
  assert.equal(
    ordinary.files.find((file) => file.path === "tests/main.test.ts")?.content,
    undefined,
  );
  assert.equal(
    withTests.files.find((file) => file.path === "tests/main.test.ts")?.content,
    'import "../main";',
  );
  assert.deepEqual(
    extractRepositoryImports(withTests.files),
    extractRepositoryImports(ordinary.files),
  );
  assert.deepEqual(pairs(withTests.files), [["tests/main.test.ts", "main.ts"]]);
  assert.deepEqual(
    (await readRepositorySources(root, [...tracked, "tests/missing.py"])).errors,
    [],
  );
  assert.equal(
    (await readRepositorySources(root, [...tracked, "tests/missing.py"], { includeTests: true }))
      .errors.length,
    1,
  );
  await fs.rename(path.join(root, "tests"), path.join(root, "original-tests"));
  await fs.symlink(
    path.join(root, "original-tests"),
    path.join(root, "tests"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const blocked = await readRepositorySources(root, tracked, { includeTests: true });
  assert.equal(
    blocked.files.find((file) => file.path === "tests/main.test.ts")?.content,
    undefined,
  );
  assert.match(blocked.errors[0]!.reason, /plain directory/);
  await fs.unlink(path.join(root, "tests"));
});
