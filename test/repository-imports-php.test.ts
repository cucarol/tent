import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  extractRepositoryImports,
  isCodeSource,
  isImportConfig,
  isImportSource,
  type RepositorySource,
} from "../src/core/base/repository-imports.js";
import { extractPhpImports } from "../src/core/base/php-imports.js";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import { readRepositorySources } from "../src/fs/repository-sources.js";
import {
  observeStructureMaterial,
  withStructureSnapshot,
} from "../src/fs/structure-observation.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";

const source = (path: string, content?: string): RepositorySource => ({ path, content });
const config = (autoload: unknown, name = "composer.json") =>
  source(name, JSON.stringify({ autoload }));
const pairs = (result: ReturnType<typeof extractRepositoryImports>) =>
  result.edges.map(({ from, to }) => `${from} -> ${to}`);

test("PHP sources and Composer files share scan and structure classification", () => {
  assert.ok(isCodeSource("src/App.php"));
  assert.ok(isImportSource("src/App.php"));
  assert.ok(isImportConfig("composer.json"));
  assert.ok(isImportConfig("packages/a/composer.json"));
  assert.equal(isImportConfig("notcomposer.json"), false);
  assert.equal(isImportSource("App.php.txt"), false);
});

test("PHP normal, aliased, comma and grouped use declarations map PSR-4 files", () => {
  const files = [
    config({ "psr-4": { "App\\": "src/", "Lib\\": "lib/" } }),
    source(
      "src/Main.php",
      String.raw`<?php
namespace App;
use Lib\First as Alias, \Lib\Second;
use Lib\Group\{Third, Fourth as Four,};
namespace Other {
    USE Lib\Fifth;
}
namespace { use Lib\Sixth; }
`,
    ),
    ...["First", "Second", "Group/Third", "Group/Fourth", "Fifth", "Sixth"].map((name) =>
      source(`lib/${name}.php`, "<?php"),
    ),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.edges.map((edge) => edge.to).sort(), [
    "lib/Fifth.php",
    "lib/First.php",
    "lib/Group/Fourth.php",
    "lib/Group/Third.php",
    "lib/Second.php",
    "lib/Sixth.php",
  ]);
  assert.equal(result.scannedFiles, 7);
  assert.deepEqual(extractRepositoryImports([...files].reverse()), result);
  assert.deepEqual(repositoryFacts(files).imports, result);
});

test("PHP PSR-4 uses longest prefixes, directory order and fallback prefixes", () => {
  const result = extractRepositoryImports([
    config({
      "psr-4": {
        "Lib\\": ["missing/", "lib/", "shadow/"],
        "Lib\\Special\\": "special/",
        "": "fallback/",
      },
    }),
    source(
      "main.php",
      String.raw`<?php use Lib\Thing; use Lib\Special\Thing; use Unknown\Thing; use Lib\Special\Other;`,
    ),
    source("lib/Thing.php", "<?php"),
    source("shadow/Thing.php", "<?php"),
    source("special/Thing.php", "<?php"),
    source("fallback/Unknown/Thing.php", "<?php"),
    source("lib/Special/Other.php", "<?php"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), [
    "main.php -> fallback/Unknown/Thing.php",
    "main.php -> lib/Special/Other.php",
    "main.php -> lib/Thing.php",
    "main.php -> special/Thing.php",
  ]);
});

test("PHP closest Composer scope and Workspace-local parent mapping do not guess unrelated roots", () => {
  const result = extractRepositoryImports([
    config({ "psr-4": { "Lib\\": "root/" } }),
    config({ "psr-4": { "Lib\\": "../../shared/" } }, "packages/local/composer.json"),
    source("packages/local/Main.php", String.raw`<?php use Lib\Thing; use Other\Thing;`),
    source("root/Thing.php", "<?php"),
    source("shared/Thing.php", "<?php"),
    source("other/Thing.php", "<?php"),
    config({ "psr-4": { "Other\\": "./" } }, "other/composer.json"),
  ]);
  assert.deepEqual(pairs(result), ["packages/local/Main.php -> shared/Thing.php"]);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.specifier, "Other\\Thing");
});

test("PHP autoload-dev PSR-4 follows shared production exclusions", () => {
  const result = extractRepositoryImports([
    source(
      "composer.json",
      JSON.stringify({ "autoload-dev": { "psr-4": { "Dev\\": "dev/", "Tests\\": "tests/" } } }),
    ),
    source("main.php", String.raw`<?php use Dev\Tool; use Tests\Only;`),
    source("dev/Tool.php", "<?php"),
    source("tests/Only.php", String.raw`<?php use Dev\Tool;`),
  ]);
  assert.deepEqual(pairs(result), ["main.php -> dev/Tool.php"]);
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.issues.length, 1);
});

test("PHP function, constant, namespace and unknown imports stay diagnostic", () => {
  const result = extractRepositoryImports([
    config({ "psr-4": { "Lib\\": "lib/" } }),
    source(
      "main.php",
      String.raw`<?php
use function Lib\helper as help;
use const Lib\VALUE;
use Lib\{Thing, function helper, const VALUE};
use Lib\SubNamespace;
use External\Absent;
`,
    ),
    source("lib/Thing.php", "<?php"),
    source("lib/helper.php", "<?php"),
    source("lib/VALUE.php", "<?php"),
    source("lib/SubNamespace/Member.php", "<?php"),
  ]);
  assert.deepEqual(pairs(result), ["main.php -> lib/Thing.php"]);
  assert.equal(result.issues.length, 4);
  assert.ok(result.issues.some((issue) => issue.specifier === "function Lib\\helper"));
  const noComposer = extractRepositoryImports([
    source("app.php", String.raw`<?php use Lib\Thing;`),
    source("lib/Thing.php", String.raw`<?php namespace Lib; class Thing {}`),
  ]);
  assert.deepEqual(noComposer.edges, []);
  assert.match(noComposer.issues[0]!.reason, /no local PSR-4/);
});

test("PHP comments, HTML, strings, heredoc, nowdoc and closure capture cannot invent imports", () => {
  const result = extractRepositoryImports([
    config({ "psr-4": { "Lib\\": "lib/" } }),
    source(
      "main.php",
      String.raw`<p>use Lib\Hidden; require 'hidden.php';</p>
<?php
// use Lib\Hidden;
# require 'hidden.php';
/* use Lib\Hidden; require 'hidden.php'; */
$single = 'use Lib\Hidden;';
$double = "use Lib\\Hidden; require 'hidden.php';";
$interpolation = "{$object->method('use Lib\\Hidden;')}";
$nested = "{$object->method("use Lib\Hidden;")}";
$backtick = ` +
        "`" +
        String.raw`use Lib\Hidden;` +
        "`" +
        String.raw`;
$heredoc = <<<TEXT
use Lib\Hidden;
require 'hidden.php';
TEXT;
$nowdoc = <<<'TEXT'
use Lib\Hidden;
TEXT;
$closure = function () use ($value) {};
class Keywords { public function require() {} const INCLUDE = 'ignored'; }
foo(use: 1, include: 2);
use Lib\Visible;
?> use Lib\Hidden; <?php use Lib\Visible;
`,
    ),
    source("lib/Visible.php", "<?php"),
    source("lib/Hidden.php", "<?php"),
    source("hidden.php", "<?php"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), ["main.php -> lib/Visible.php"]);
});

test("PHP trait insertion use is distinguished from namespace imports and remains diagnostic", () => {
  const result = extractRepositoryImports([
    config({ "psr-4": { "Lib\\": "lib/" } }),
    source("main.php", String.raw`<?php use Lib\Visible; class App { use Lib\Hidden; }`),
    source("lib/Visible.php", "<?php"),
    source("lib/Hidden.php", "<?php"),
  ]);
  assert.deepEqual(pairs(result), ["main.php -> lib/Visible.php"]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.reason, /trait insertion/);
});

test("PHP single and double quoted braces do not alter namespace import scope", () => {
  for (const quote of ["'", '"']) {
    for (const brace of ["{", "}"]) {
      const result = extractRepositoryImports([
        config({ "psr-4": { "Lib\\": "lib/" } }),
        source("main.php", `<?php $text = ${quote}${brace}${quote}; use Lib\\Thing;`),
        source("lib/Thing.php", "<?php"),
      ]);
      assert.deepEqual(pairs(result), ["main.php -> lib/Thing.php"], `${quote}${brace}${quote}`);
      assert.deepEqual(result.issues, [], `${quote}${brace}${quote}`);
    }
  }
});

test("PHP quoted braces preserve real namespace/class scopes and trait diagnostics", () => {
  const result = extractRepositoryImports([
    config({ "psr-4": { "Lib\\": "lib/" } }),
    source(
      "main.php",
      String.raw`<?php
namespace App {
    $open = '{'; $close = "}";
    use Lib\Before;
    class App {
        public string $open = "{";
        public string $close = '}';
        use Lib\Hidden;
    }
    use Lib\After;
}
namespace Other { use Lib\Last; }
`,
    ),
    ...["Before", "After", "Hidden", "Last"].map((name) => source(`lib/${name}.php`, "<?php")),
  ]);
  assert.deepEqual(pairs(result), [
    "main.php -> lib/After.php",
    "main.php -> lib/Before.php",
    "main.php -> lib/Last.php",
  ]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.reason, /trait insertion/);
});

test("PHP real unmatched and unclosed braces remain diagnostic beside quoted braces", () => {
  const result = extractRepositoryImports([
    config({ "psr-4": { "Lib\\": "lib/" } }),
    source("unclosed.php", "<?php namespace App { $text = '{'; use Lib\\Thing;"),
    source("unmatched.php", '<?php $text = "}"; }'),
    source("lib/Thing.php", "<?php"),
  ]);
  assert.deepEqual(pairs(result), ["unclosed.php -> lib/Thing.php"]);
  assert.equal(result.issues.length, 2);
  assert.ok(
    result.issues.some(
      (issue) => issue.file === "unclosed.php" && /unclosed body/.test(issue.reason),
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.file === "unmatched.php" && /unmatched closing brace/.test(issue.reason),
    ),
  );
});

test("PHP __DIR__ and dirname(__FILE__) anchor literal suffixes without execution", () => {
  const result = extractRepositoryImports([
    source(
      "app/main.php",
      String.raw`<?php
require __DIR__ . '/../api/a.php';
require_once(__DIR__ . '/local.php');
include dirname(__FILE__) . '/../api/b.php';
include_once (__DIR__ . '/../api/' . 'c.php');
function load() { INCLUDE dirname(__FILE__) . '/../api/d.php'; }
if (false) { require __DIR__ . '/../api/e.php'; }
`,
    ),
    ...["api/a", "api/b", "api/c", "api/d", "api/e", "app/local"].map((name) =>
      source(`${name}.php`, "<?php"),
    ),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.edges.map((edge) => edge.to).sort(), [
    "api/a.php",
    "api/b.php",
    "api/c.php",
    "api/d.php",
    "api/e.php",
    "app/local.php",
  ]);
});

test("PHP static quoted paths decode escapes but interpolations and executable expressions stay uncertain", () => {
  const result = extractRepositoryImports([
    source(
      "app.php",
      String.raw`<?php
require __DIR__ . '/single\'quote.php';
require __DIR__ . "/escaped\$dollar.php";
require __DIR__ . "/$dynamic.php";
include $path;
require get_path();
require __DIR__ . '/ok.php' . $suffix;
require (__DIR__ . '/ok.php') + 1;
require "\x6fk.php";
`,
    ),
    source("single'quote.php", "<?php"),
    source("escaped$dollar.php", "<?php"),
    source("ok.php", "<?php"),
  ]);
  assert.deepEqual(result.edges.map((edge) => edge.to).sort(), [
    "escaped$dollar.php",
    "single'quote.php",
  ]);
  assert.equal(result.issues.length, 1);
  assert.ok(result.issues.every((issue) => /not a supported static path/.test(issue.reason)));
});

test("PHP bare and ./ literals retain both source-directory and Workspace-root candidates", () => {
  for (const specifier of ["includes/x.php", "./includes/x.php"]) {
    const result = extractRepositoryImports([
      source("app/main.php", `<?php require_once '${specifier}';`),
      source("app/includes/x.php", "<?php"),
      source("includes/x.php", "<?php"),
    ]);
    assert.deepEqual(pairs(result), [
      "app/main.php -> app/includes/x.php",
      "app/main.php -> includes/x.php",
    ]);
    assert.equal(result.issues.length, 2);
    for (const edge of result.edges) {
      assert.ok(
        result.issues.some(
          (issue) =>
            issue.specifier === specifier &&
            issue.reason.includes(`candidate ${edge.to}:`) &&
            /runtime include_path and working directory/.test(issue.reason),
        ),
      );
    }
    assert.deepEqual(
      extractRepositoryImports([
        source("includes/x.php", "<?php"),
        source("app/includes/x.php", "<?php"),
        source("app/main.php", `<?php require_once '${specifier}';`),
      ]),
      result,
    );
  }
});

test("PHP literal candidates preserve single-directory matches and diagnose missing targets", () => {
  for (const target of ["app/includes/x.php", "includes/x.php", undefined]) {
    const result = extractRepositoryImports([
      source("app/main.php", "<?php include 'includes/x.php';"),
      ...(target ? [source(target, "<?php")] : []),
      source("unrelated/includes/x.php", "<?php"),
    ]);
    assert.deepEqual(
      result.edges.map((edge) => edge.to),
      target ? [target] : [],
    );
    assert.equal(result.issues.length, 1);
    assert.match(
      result.issues[0]!.reason,
      target ? /candidate .*runtime/ : /no supplied source-directory or Workspace-root candidate/,
    );
  }
});

test("PHP literal candidate normalization and repeated statements follow shared deduplication", () => {
  const result = extractRepositoryImports([
    source(
      "main.php",
      "<?php require './includes/../target.php'; require './includes/../target.php';",
    ),
    source("target.php", "<?php"),
  ]);
  assert.deepEqual(pairs(result), ["main.php -> target.php"]);
  assert.equal(result.issues.length, 1);
});

test("PHP ../ literals keep the local source candidate and discard Workspace escapes", () => {
  const result = extractRepositoryImports([
    source("app/src/main.php", "<?php require '../api.php'; include '../../../outside.php';"),
    source("app/api.php", "<?php"),
    source("api.php", "<?php"),
    source("outside.php", "<?php"),
  ]);
  assert.deepEqual(pairs(result), ["app/src/main.php -> app/api.php"]);
  assert.equal(result.issues.length, 2);
  assert.ok(
    result.issues.some(
      (issue) => issue.specifier === "../../../outside.php" && /no supplied/.test(issue.reason),
    ),
  );
});

test("PHP dynamic paths and unsupported anchor variants never contribute a static prefix", () => {
  const expressions = [
    "$path",
    "get_path()",
    "'includes/' . 'x.php'",
    "'includes/x.php' . $suffix",
    "__DIR__ . '/includes/x.php' . $suffix",
    "dirname(__FILE__) . '/includes/x.php' . extension()",
    "dirname(__DIR__) . '/includes/x.php'",
    "dirname(__FILE__, 2) . '/includes/x.php'",
    "__FILE__",
    "dirname('app/main.php') . '/includes/x.php'",
  ];
  for (const expression of expressions) {
    const result = extractRepositoryImports([
      source("app/main.php", `<?php require ${expression};`),
      source("includes/x.php", "<?php"),
      source("app/includes/x.php", "<?php"),
    ]);
    assert.deepEqual(result.edges, [], expression);
    assert.equal(result.issues.length, 1, expression);
    assert.match(result.issues[0]!.reason, /not a supported static path/);
  }
});

test("PHP paths never escape the Workspace or infer stream, drive or backslash paths", () => {
  const result = extractRepositoryImports([
    source(
      "app.php",
      String.raw`<?php
require __DIR__ . '/../outside.php';
require dirname(__FILE__) . '/../../outside.php';
require '/absolute.php';
require 'C:/outside.php';
require 'https://example.com/file.php';
require 'dir\\file.php';
require __DIR__ . '/missing.php';
`,
    ),
    source("outside.php", "<?php"),
    source("absolute.php", "<?php"),
    source("dir/file.php", "<?php"),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 7);
});

test("PHP ./ and ../ literals add their in-Workspace candidate evidence with runtime diagnostics", () => {
  const result = extractRepositoryImports([
    source("app/main.php", "<?php require './local.php'; require '../api.php';"),
    source("app/local.php", "<?php"),
    source("api.php", "<?php"),
  ]);
  assert.deepEqual(pairs(result), ["app/main.php -> api.php", "app/main.php -> app/local.php"]);
  assert.equal(result.issues.length, 2);
});

test("PHP short tags remain diagnostic and compiler data does not create source imports", () => {
  const result = extractRepositoryImports([
    source("short.php", "<? require 'hidden.php'; ?>"),
    source("data.php", '<?xml version="1.0"?><?php __halt_compiler(); use Lib\\Hidden; /*'),
    source("hidden.php", "<?php"),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.reason, /short open tags/);
});

test("PHP unsupported deep include expressions remain bounded diagnostics", () => {
  const result = extractRepositoryImports([
    source(
      "app.php",
      `<?php require ${"(".repeat(2000)}__DIR__ . '/hidden.php'${")".repeat(2000)};`,
    ),
    source("hidden.php", "<?php"),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 1);
});

test("PHP malformed and unsupported Composer config is diagnostic while valid entries remain usable", () => {
  const files = [
    config({
      "psr-4": { "Lib\\": "lib/", Bad: "bad/", "Escape\\": "../external/", "Wrong\\": 123 },
      classmap: ["legacy/"],
      files: ["helpers.php"],
    }),
    source("app.php", String.raw`<?php use Lib\Thing;`),
    source("lib/Thing.php", "<?php"),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(pairs(result), ["app.php -> lib/Thing.php"]);
  assert.equal(result.issues.length, 3);
  for (const content of [
    "{",
    "[]",
    '{"autoload":[]}',
    '{"autoload":{"psr-4":[]}}',
    '{"autoload":{"psr-4":{"App\\\\":[null]}}}',
  ]) {
    assert.ok(
      extractRepositoryImports([source("composer.json", content), source("app.php", "<?php")])
        .issues.length,
      content,
    );
  }
  assert.match(
    extractRepositoryImports([source("composer.json"), source("app.php", "<?php")]).issues[0]!
      .reason,
    /bytes are unavailable/,
  );
});

test("PHP malformed source and unavailable bytes produce bounded diagnostics", () => {
  const result = extractRepositoryImports([
    source("broken.php", "<?php use Lib\\{Thing; /*"),
    source("body.php", "<?php function f() {"),
    source("string.php", "<?php $x = 'unclosed"),
    source("heredoc.php", "<?php $x = <<<TEXT\nuse Lib\\Thing;"),
    source("missing.php"),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 6);
});

test("PHP test sources and targets do not contribute edges or scanned counts", () => {
  const result = extractRepositoryImports([
    source("app.php", "<?php require __DIR__ . '/tests/only.php'; require __DIR__ . '/app.php';"),
    source("tests/only.php", "<?php require __DIR__ . '/../app.php';"),
    source("app.test.php", "<?php require __DIR__ . '/app.php';"),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.scannedFiles, 1);
});

test("PHP focused Core requests only member source and closest containing Composer bytes", () => {
  const files = [
    config({ "psr-4": { "Lib\\": "lib/" } }),
    source("app/main.php", String.raw`<?php use Lib\Thing; require __DIR__ . '/../api.php';`),
    source("lib/Thing.php"),
    source("api.php"),
    source("other/broken.php"),
    source("other/composer.json"),
  ];
  const result = extractPhpImports(files, ["app/main.php"]);
  assert.deepEqual(result.requiredFiles, ["app/main.php", "composer.json"]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 2);
  assert.deepEqual(extractPhpImports(files, []), { edges: [], issues: [], requiredFiles: [] });
});

test("PHP FS collection and narrow structure share Core resolution and preserve relevant failures", async () => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "php-imports-"));
  try {
    initializeFixtureRepository(root);
    const files = [
      config({ "psr-4": { "Lib\\": "lib/" } }),
      source("app/main.php", String.raw`<?php use Lib\Thing; require __DIR__ . '/../api/a.php';`),
      source("lib/Thing.php", "<?php"),
      source("api/a.php", "<?php"),
      source("other/broken.php", "<?php /*"),
      source("other/composer.json", "{"),
    ];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await fs.writeFile(path.join(root, file.path), file.content!);
    }
    const collected = await readRepositorySources(
      root,
      files.map((file) => file.path),
    );
    assert.deepEqual(collected.errors, []);
    assert.deepEqual(pairs(extractRepositoryImports(collected.files)), [
      "app/main.php -> api/a.php",
      "app/main.php -> lib/Thing.php",
    ]);
    const observe = () =>
      withStructureSnapshot(() => observeStructureMaterial(root, "Module/Module.md", "../../app/"));
    assert.deepEqual((await observe()).structureDependencies, ["api/", "lib/"]);
    await fs.writeFile(path.join(root, "lib/Thing.php"), Buffer.from([0xff]));
    await fs.writeFile(path.join(root, "other/composer.json"), Buffer.from([0xff]));
    assert.deepEqual((await observe()).structureDependencies, ["api/", "lib/"]);
    await fs.writeFile(path.join(root, "composer.json"), "{");
    await assert.rejects(observe, /Cannot parse PHP Composer/);
    await fs.writeFile(path.join(root, "composer.json"), files[0]!.content!);
    await fs.writeFile(path.join(root, "app/main.php"), "<?php require '../api/a.php';");
    await assert.rejects(
      observe,
      /candidate api\/a.php: runtime include_path and working directory/,
    );
    await fs.writeFile(path.join(root, "app/main.php"), "<?php require $dynamic;");
    await assert.rejects(observe, /PHP include\/require expression/);
    await fs.writeFile(path.join(root, "app/main.php"), Buffer.from([0xff]));
    await assert.rejects(observe);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
