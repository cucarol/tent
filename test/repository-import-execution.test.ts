import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  extractRepositoryImports,
  extractRepositoryTestImports,
  type RepositorySource,
} from "../src/core/base/repository-imports.js";

const source = (path: string, content = ""): RepositorySource => ({ path, content });
const execution = (files: RepositorySource[]) =>
  extractRepositoryImports(files).edges.map(({ to, execution }) => [to, execution]);

test("Python keeps type guards, function imports, and eager class bodies as distinct dependency evidence", () => {
  const files = [
    source("pkg/__init__.py"),
    source(
      "pkg/main.py",
      `
from typing import TYPE_CHECKING
import typing as t
from typing_extensions import TYPE_CHECKING as TC
if TYPE_CHECKING:
    from . import guarded
    class OnlyTypes:
        from . import guarded_class
else:
    from . import runtime_else
if (t.TYPE_CHECKING):
    from .qualified import Value
if TC: from . import alias; from . import inline_alias
class Eager:
    from . import class_body
    def method(self):
        from . import method_body
        class Nested:
            from . import nested_class
async def outer():
    from . import async_body
    def inner():
        from . import nested_function
def inline(): from . import inline_function; from . import inline_function_two
from . import after
`,
    ),
    ...[
      "guarded",
      "guarded_class",
      "runtime_else",
      "qualified",
      "alias",
      "inline_alias",
      "class_body",
      "method_body",
      "nested_class",
      "async_body",
      "nested_function",
      "inline_function",
      "inline_function_two",
      "after",
    ].map((name) => source(`pkg/${name}.py`)),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  const byTarget = new Map(
    result.edges
      .filter((edge) => edge.to !== "pkg/__init__.py")
      .map((edge) => [edge.to, edge.execution]),
  );
  for (const name of ["guarded", "guarded_class", "qualified", "alias", "inline_alias"])
    assert.equal(byTarget.get(`pkg/${name}.py`), "type-only", name);
  for (const name of [
    "method_body",
    "nested_class",
    "async_body",
    "nested_function",
    "inline_function",
    "inline_function_two",
  ])
    assert.equal(byTarget.get(`pkg/${name}.py`), "deferred", name);
  for (const name of ["runtime_else", "class_body", "after"])
    assert.equal(byTarget.get(`pkg/${name}.py`), "module-load", name);
  assert.equal(byTarget.size, 14);
  assert.deepEqual(extractRepositoryImports([...files].reverse()), result);
});

test("Python suites handle multiline imports, tabs, comments, strings and ordinary conditional imports", () => {
  assert.deepEqual(
    execution([
      source(
        "main.py",
        `
from typing import (TYPE_CHECKING as TC, Any)
if TC:
\tfrom typed import (
        A,
        B as Bee,
    )
def load(
    option: str = ": import bogus",
):
    """from ignored import X
    import ignored
    """
    # import ignored
    import local as local_alias, other
    from continued import \\
        X
if enabled:
    import conditional
if not TC:
    import negative_guard
if TC or enabled:
    import uncertain_guard
if TC():
    import call_guard
if "TC":
    import string_guard
`,
      ),
      ...[
        "typed",
        "local",
        "other",
        "continued",
        "conditional",
        "negative_guard",
        "uncertain_guard",
        "call_guard",
        "string_guard",
        "ignored",
        "bogus",
      ].map((name) => source(`${name}.py`)),
    ]),
    [
      ["call_guard.py", "module-load"],
      ["conditional.py", "module-load"],
      ["continued.py", "deferred"],
      ["local.py", "deferred"],
      ["negative_guard.py", "module-load"],
      ["other.py", "deferred"],
      ["string_guard.py", "module-load"],
      ["typed.py", "type-only"],
      ["uncertain_guard.py", "module-load"],
    ],
  );
});

test("same Python target retains all observed execution contexts and test imports use the same contract", () => {
  const files = [
    source(
      "main.py",
      `from typing import TYPE_CHECKING
import value
if TYPE_CHECKING:
    import value
def later():
    import value
    import value
`,
    ),
    source("value.py"),
  ];
  assert.deepEqual(execution(files), [
    ["value.py", "deferred"],
    ["value.py", "module-load"],
    ["value.py", "type-only"],
  ]);
  const tests = [source("tests/test_main.py", files[0]!.content), files[1]!];
  assert.deepEqual(
    extractRepositoryTestImports(tests).edges.map((edge) => edge.execution),
    ["deferred", "module-load", "type-only"],
  );
});

test("TypeScript explicit declaration-wide type imports are erased while mixed and inline modifiers retain loading evidence", () => {
  const files = [
    source(
      "main.ts",
      `
import type { A } from './import-type';
export type { A } from './export-type';
export type * from './export-star-type';
import type Alias = require('./require-type');
import { type A } from './inline-type';
export { type A } from './inline-export-type';
import Value, { type A } from './mixed-default';
import { type A, B } from './mixed-named';
export { type A, B } from './mixed-export';
import type from './binding-named-type';
import type, { A } from './binding-named-type-mixed';
import './side-effect';
`,
    ),
    ...[
      "import-type",
      "export-type",
      "export-star-type",
      "require-type",
      "inline-type",
      "inline-export-type",
      "mixed-default",
      "mixed-named",
      "mixed-export",
      "binding-named-type",
      "binding-named-type-mixed",
      "side-effect",
    ].map((name) => source(`${name}.ts`)),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 12);
  for (const edge of result.edges)
    assert.equal(
      edge.execution,
      /^(import-type|export-type|export-star-type|require-type)\.ts$/.test(edge.to)
        ? "type-only"
        : "module-load",
      edge.to,
    );
  for (const code of ["import { type A } from './value';", "export { type A } from './value';"]) {
    const output = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    }).outputText;
    assert.match(output, /(?:import|export) \{\} from ['"]\.\/value['"]/);
  }
  for (const extension of [".d.ts", ".d.mts", ".d.cts"])
    assert.deepEqual(
      execution([
        source(`main${extension}`, "import './value'; export * from './value';"),
        source("value.ts"),
      ]),
      [["value.ts", "type-only"]],
    );
});

test("script literal dynamic loads at module scope differ from function, method and arrow bodies", () => {
  const files = [
    source(
      "main.ts",
      `
require('./top'); import('./top-dynamic');
if (enabled) { require('./conditional'); }
function load(defaultValue = require('./default')) {
    require('./function');
    return import('./function-dynamic');
}
const arrow = () => require('./arrow')
require('./after-arrow')
const block = async () => { await import('./arrow-block'); };
class Loader { method(): unknown { return require('./method'); } }
const object = { method() { return require('./object-method'); } };
const typedArrow = (value = require('./arrow-default')) => value;
const stringArrow = () => "{" + require('./arrow-string');
`,
    ),
    ...[
      "top",
      "top-dynamic",
      "conditional",
      "default",
      "function",
      "function-dynamic",
      "arrow",
      "after-arrow",
      "arrow-block",
      "method",
      "object-method",
      "arrow-default",
      "arrow-string",
    ].map((name) => source(`${name}.ts`)),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 13);
  for (const edge of result.edges)
    assert.equal(
      edge.execution,
      ["top.ts", "top-dynamic.ts", "conditional.ts", "after-arrow.ts"].includes(edge.to)
        ? "module-load"
        : "deferred",
      edge.to,
    );
});

test("script function contexts survive expression continuation, return annotations and computed methods without capturing eager calls", () => {
  const cases: Array<[string, "deferred" | "module-load"]> = [
    ["const load = () => true &&\n require('./dep');", "deferred"],
    ["const load = () => true\n && require('./dep');", "deferred"],
    ["const load = () => require('./dep') ||\n require('./dep');", "deferred"],
    ["const load = () => count++\n require('./dep');", "module-load"],
    ["const load = () => count--\n require('./dep');", "module-load"],
    ["const load = () => count\n ++require('./dep').value;", "module-load"],
    ["const load = () => count\n --require('./dep').value;", "module-load"],
    ["const load = () => count\n + +require('./dep');", "deferred"],
    ["const load = () => true &&\n ++require('./dep').value;", "deferred"],
    ["const load = () => true && ++\n require('./dep').value;", "deferred"],
    ["const load = () => true && --\n require('./dep').value;", "deferred"],
    ["const load = (value = require('./dep')): unknown => value;", "deferred"],
    ["const load = async (value = require('./dep')): Promise<unknown> => value;", "deferred"],
    ["class Loader { ['load']() { return require('./dep'); } }", "deferred"],
    ["const loader = { ['load']() { return require('./dep'); } };", "deferred"],
    ["api.function(require('./dep'));", "module-load"],
    ["api?.function(require('./dep'));", "module-load"],
    ["Function(require('./dep'));", "module-load"],
    ["const api = { function: require('./dep') };", "module-load"],
    ["for await (const value of values) { require('./dep'); }", "module-load"],
  ];
  for (const [content, expected] of cases) {
    assert.deepEqual(
      execution([source("main.ts", content), source("dep.ts")]),
      [["dep.ts", expected]],
      content,
    );
  }
  assert.deepEqual(
    execution([
      source("main.ts", "class Loader { [require('./name')]() { require('./dep'); } }"),
      source("name.ts"),
      source("dep.ts"),
    ]),
    [
      ["dep.ts", "deferred"],
      ["name.ts", "module-load"],
    ],
  );
});

test("TypeScript postfix non-null assertions preserve arrow boundaries without absorbing prefix or equality expressions", () => {
  const cases: Array<[string, "deferred" | "module-load"]> = [
    ["const load = () => count!\nrequire('./dep');", "module-load"],
    ["const load = () => count!!\nrequire('./dep');", "module-load"],
    ["const load = () => (count)!\nrequire('./dep');", "module-load"],
    ["const load = () => !\nrequire('./dep');", "deferred"],
    ["const load = () => !!\nrequire('./dep');", "deferred"],
    ["const load = () => count\n!require('./dep');", "module-load"],
    ["const load = () => count!\n!require('./dep');", "module-load"],
    ["const load = () => count!\n+ require('./dep');", "deferred"],
    ["const load = () => count!!\n+ require('./dep');", "deferred"],
    ["const load = () => count !=\nrequire('./dep');", "deferred"],
    ["const load = () => count\n!= require('./dep');", "deferred"],
    ["const load = () => count !==\nrequire('./dep');", "deferred"],
    ["const load = () => count\n!== require('./dep');", "deferred"],
  ];
  for (const [content, expected] of cases) {
    const parsed = ts.createSourceFile("main.ts", content, ts.ScriptTarget.Latest, true);
    assert.deepEqual(
      (parsed as typeof parsed & { parseDiagnostics: unknown[] }).parseDiagnostics,
      [],
      content,
    );
    const output = ts.transpileModule(content, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      reportDiagnostics: true,
    });
    assert.deepEqual(output.diagnostics, [], content);
    let calls = 0;
    vm.runInNewContext(
      output.outputText,
      {
        count: 1,
        require: () => {
          calls++;
          return 1;
        },
      },
      { timeout: 1000 },
    );
    assert.equal(calls, expected === "module-load" ? 1 : 0, content);
    assert.deepEqual(
      execution([source("main.ts", content), source("dep.ts")]),
      [["dep.ts", expected]],
      content,
    );
  }
});

test("Python explicit line joining preserves positive guard and function header context", () => {
  for (const newline of ["\n", "\r\n"]) {
    const content = [
      "from typing import TYPE_CHECKING",
      "if \\",
      "    TYPE_CHECKING:",
      "    import typed",
      "def load() \\",
      "    -> None:",
      "    import deferred",
      "import eager",
    ].join(newline);
    assert.deepEqual(
      execution([
        source("main.py", content),
        source("typed.py"),
        source("deferred.py"),
        source("eager.py"),
      ]),
      [
        ["deferred.py", "deferred"],
        ["eager.py", "module-load"],
        ["typed.py", "type-only"],
      ],
    );
  }
});

test("Go package initialization and compile declarations across Rust, Java, C# and C/C++ stay distinct", () => {
  const files = [
    source("go.mod", "module app"),
    source("main.go", 'package main; import "app/value"'),
    source("value/value.go", "package value"),
    source("Cargo.toml", '[package]\nname="app"\nedition="2021"'),
    source("src/lib.rs", "mod value;"),
    source("src/value.rs", "pub struct Value;"),
    source("src/main/java/app/Main.java", "package app; import app.Value;"),
    source("src/main/java/app/Value.java", "package app; public class Value {}"),
    source("app/App.csproj", "<Project/>"),
    source("app/Main.cs", "using V = App.Value;"),
    source("app/Value.cs", "namespace App; public class Value {}"),
    source("main.cpp", '#include "value.h"'),
    source("value.h"),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 5);
  for (const edge of result.edges)
    assert.equal(
      edge.execution,
      edge.from.endsWith(".go") ? "module-load" : "compile-time",
      edge.from,
    );
});

test("PHP namespace aliases are compile declarations while includes retain top-level or function execution", () => {
  const files = [
    source("composer.json", '{"autoload":{"psr-4":{"App\\\\":"src/"}}}'),
    source("src/Value.php", "<?php namespace App; class Value {}"),
    source(
      "main.php",
      `<?php
use App\\Value;
require __DIR__ . '/top.php';
if ($enabled) { include __DIR__ . '/conditional.php'; }
function load() { require_once __DIR__ . '/function.php'; }
class Loader { public function load() { include_once __DIR__ . '/method.php'; } }
$closure = function () use ($enabled) { require __DIR__ . '/closure.php'; };
$arrow = fn() => include __DIR__ . '/arrow.php';
$stringArrow = fn() => "{" . include __DIR__ . '/arrow-string.php';
$array = [1 => include __DIR__ . '/array.php'];
`,
    ),
    ...[
      "top",
      "conditional",
      "function",
      "method",
      "closure",
      "arrow",
      "arrow-string",
      "array",
    ].map((name) => source(`${name}.php`, "<?php")),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 9);
  for (const edge of result.edges)
    assert.equal(
      edge.execution,
      edge.to === "src/Value.php"
        ? "compile-time"
        : ["top.php", "conditional.php", "array.php"].includes(edge.to)
          ? "module-load"
          : "deferred",
      edge.to,
    );
});
