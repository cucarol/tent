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
import { extractCFamilyImports } from "../src/core/base/cfamily-imports.js";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import { readRepositorySources } from "../src/fs/repository-sources.js";
import {
  observeStructureMaterial,
  withStructureSnapshot,
} from "../src/fs/structure-observation.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";

const source = (path: string, content?: string): RepositorySource => ({ path, content });
const pairs = (result: ReturnType<typeof extractRepositoryImports>) =>
  result.edges.map(({ from, to }) => `${from} -> ${to}`);

test("C/C++ implementation and header suffixes share scan and structure classification", () => {
  for (const extension of [
    "c",
    "cc",
    "cpp",
    "cxx",
    "C",
    "h",
    "hh",
    "hpp",
    "hxx",
    "inc",
    "inl",
    "ipp",
    "tpp",
  ]) {
    assert.ok(isImportSource(`lib/file.${extension}`));
    assert.ok(isCodeSource(`lib/file.${extension}`));
  }
  assert.equal(isImportSource("file.cpp.txt"), false);
  assert.ok(isImportConfig("CMakeLists.txt"));
  assert.ok(isImportConfig("build/compile_commands.json"));
  assert.equal(isImportConfig("notcompile_commands.json"), false);
});

test("C/C++ source-relative literal includes resolve actual files deterministically", () => {
  const files = [
    source(
      "app/main.cpp",
      '#include "local.hpp"\n# include "../api/public.h"\n#include "local.hpp"\n#include <vector>\n',
    ),
    source("app/local.hpp", '#include "detail.inl"\n'),
    source("app/detail.inl", ""),
    source("api/public.h", ""),
    source("other/local.hpp", ""),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), [
    "app/local.hpp -> app/detail.inl",
    "app/main.cpp -> api/public.h",
    "app/main.cpp -> app/local.hpp",
  ]);
  assert.equal(result.scannedFiles, 5);
  assert.deepEqual(extractRepositoryImports([...files].reverse()), result);
  assert.deepEqual(repositoryFacts(files).imports, result);
});

test("C/C++ comments, literals and raw strings cannot inject includes", () => {
  const result = extractRepositoryImports([
    source(
      "app.cpp",
      [
        '// #include "hidden.h"',
        '/*\n#include "hidden.h"\n*/',
        'const char *s = "#include \\"hidden.h\\"";',
        "char quote = '\\''; auto count = 1'000;",
        'const char *raw = u8R"tag(',
        '#include "hidden.h"',
        ')tag";',
        'auto adjacent = R"(#include "hidden.h")";',
        '/* prefix */ # /* middle */ include /* before */ "visible.h" // after',
        'int x; #include "hidden.h"',
        '"literal" #include "hidden.h"',
        'R"(multiline',
        ')" #include "hidden.h"',
      ].join("\n"),
    ),
    source("visible.h", ""),
    source("hidden.h", ""),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), ["app.cpp -> visible.h"]);
});

test("C/C++ line splicing precedes comments and include token recognition", () => {
  const result = extractRepositoryImports([
    source(
      "app.c",
      '#inc\\\r\nlude \\\r\n"a.h"\n// continued \\\n#include "hidden.h"\n/\\\n* #include "hidden.h" */\n#include "b\\\n.h"',
    ),
    source("a.h", ""),
    source("b.h", ""),
    source("hidden.h", ""),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), ["app.c -> a.h", "app.c -> b.h"]);
});

test("C/C++ considers literal includes from all conditional branches and header guards", () => {
  const result = extractRepositoryImports([
    source(
      "app.hpp",
      '#ifndef GUARD\n#define GUARD\n#if FEATURE\n#include "a.h"\n#else\n#include "b.h"\n#endif\n#endif',
    ),
    source("a.h", ""),
    source("b.h", ""),
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 2);
});

test("C/C++ unresolved and nonliteral includes are diagnostic without basename guessing", () => {
  const result = extractRepositoryImports([
    source(
      "app/main.cpp",
      '#include "missing.h"\n#include "../../escape.h"\n#include "C:/outside.h"\n#include HEADER\n#include_next "next.h"\n#include "a.h" trailing\n#include <external.h>',
    ),
    source("other/missing.h", ""),
    source("app/a.h", ""),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 6);
  assert.ok(result.issues.some((issue) => issue.specifier === "HEADER"));
  assert.ok(result.issues.some((issue) => /include_next/.test(issue.reason)));
});

test("C/C++ malformed source and missing bytes remain explicit and bounded", () => {
  const result = extractRepositoryImports([
    source("broken.c", '#include "ok.h"\n/*'),
    source("missing.c"),
    source("ok.h", ""),
    source("raw.cpp", 'auto x = R"tag(\n#include "ok.h"'),
  ]);
  assert.deepEqual(pairs(result), ["broken.c -> ok.h"]);
  assert.equal(result.issues.length, 3);
});

test("C/C++ test sources and targets do not contribute edges", () => {
  const result = extractRepositoryImports([
    source("src/app.cpp", '#include "../test/hidden.h"\n#include "app.cpp"'),
    source("test/hidden.h", '#include "../src/app.cpp"'),
    source("src/example.test.cpp", '#include "../src/app.cpp"'),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.scannedFiles, 1);
});

test("C/C++ narrow Core requests source bytes only for its members", () => {
  const files = [
    source("src/app.cpp", '#include "../api/public.h"'),
    source("api/public.h"),
    source("other/broken.cpp"),
  ];
  const result = extractCFamilyImports(files, ["src/app.cpp"]);
  assert.deepEqual(result.requiredFiles, ["src/app.cpp"]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges[0]?.to, "api/public.h");
  assert.deepEqual(extractCFamilyImports(files, []).requiredFiles, []);
});

test("C/C++ recognized build configuration is diagnostic and scoped to containing directories", () => {
  const files = [
    source("CMakeLists.txt", "project(example)"),
    source("compile_commands.json", "malformed"),
    source("src/app.cpp", '#include "../api/public.h"'),
    source("api/public.h", ""),
    source("independent/CMakeLists.txt"),
  ];
  const result = extractCFamilyImports(files, ["src/app.cpp"]);
  assert.equal(result.edges[0]?.to, "api/public.h");
  assert.deepEqual(result.requiredFiles, [
    "CMakeLists.txt",
    "compile_commands.json",
    "src/app.cpp",
  ]);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every((issue) => /not evaluated/.test(issue.reason)));
  assert.deepEqual(extractCFamilyImports(files, []).issues, []);
  assert.match(
    extractCFamilyImports([source("CMakeLists.txt"), source("app.c", "")]).issues[0]!.reason,
    /unavailable/,
  );
});

test("C/C++ collector and narrow structure use the shared extractor", async () => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "cfamily-imports-"));
  try {
    initializeFixtureRepository(root);
    const files = [
      source("src/app.cpp", '#include "../api/public.h"'),
      source("api/public.h", ""),
      source("other/broken.cpp", "/*"),
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
      "src/app.cpp -> api/public.h",
    ]);
    const observe = () =>
      withStructureSnapshot(() => observeStructureMaterial(root, "Module/Module.md", "../../src/"));
    assert.deepEqual((await observe()).structureDependencies, ["api/"]);
    await fs.writeFile(path.join(root, "other/broken.cpp"), Buffer.from([0xff, 0xfe]));
    assert.deepEqual((await observe()).structureDependencies, ["api/"]);
    await fs.writeFile(path.join(root, "src/app.cpp"), '#include "../api/missing.h"');
    await assert.rejects(observe, /Structure unavailable:.*Quoted C\/C\+\+ include/);
    await fs.writeFile(path.join(root, "src/app.cpp"), Buffer.from([0xff, 0xfe]));
    await assert.rejects(observe);
    await fs.writeFile(path.join(root, "src/app.cpp"), '#include "../api/public.h"');
    await fs.writeFile(path.join(root, "CMakeLists.txt"), "project(example)");
    await assert.rejects(observe, /C\/C\+\+ build include search paths are not evaluated/);
    const config = await readRepositorySources(root, ["CMakeLists.txt"]);
    assert.equal(config.files[0]?.content, "project(example)");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
