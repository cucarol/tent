import { removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  extractRepositoryImports,
  isImportConfig,
  isImportSource,
  type RepositorySource,
} from "../src/core/base/repository-imports.js";
import { extractJavaImports } from "../src/core/base/java-imports.js";
import { javaBuildRoots } from "../src/core/base/java-build.js";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import { readRepositorySources } from "../src/fs/repository-sources.js";
import {
  observeStructureMaterial,
  withStructureSnapshot,
} from "../src/fs/structure-observation.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";

const source = (path: string, content?: string): RepositorySource => ({ path, content });
const java = (name: string, body = "", root = "src/main/java") =>
  source(
    `${root}/${name.replace(/\./g, "/")}.java`,
    `package ${name.slice(0, name.lastIndexOf("."))}; ${body}`,
  );
const pairs = (result: ReturnType<typeof extractRepositoryImports>) =>
  result.edges.map(({ from, to }) => `${from} -> ${to}`);

test("Java sources and Maven/Gradle configurations use the shared collector classification", () => {
  assert.ok(isImportSource("module/src/main/java/example/App.java"));
  for (const file of [
    "pom.xml",
    "a/pom.xml",
    "build.gradle",
    "a/build.gradle.kts",
    "settings.gradle",
    "a/settings.gradle.kts",
  ])
    assert.ok(isImportConfig(file), file);
  assert.equal(isImportConfig("a/not-build.gradle"), false);
});

test("Java explicit and static imports resolve unique repository declarations across standard modules", () => {
  const files = [
    source(
      "pom.xml",
      "<project><modules><module>api</module><module>app</module></modules></project>",
    ),
    source(
      "app/build.gradle.kts",
      'plugins { java }; dependencies { implementation(project(":api")) }',
    ),
    java(
      "example.Api",
      "public class Api { public static int VALUE; public static void run() {} public static class Nested {} }",
      "api/src/main/java",
    ),
    java(
      "client.App",
      "import example.Api; import example.Api.Nested; import static example.Api.VALUE; import static example.Api.run; import static example.Api.*; import java.util.List; public class App {}",
      "app/src/main/java",
    ),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.edges.length, 5);
  assert.ok(
    result.edges.every(
      (edge) =>
        edge.from === "app/src/main/java/client/App.java" &&
        edge.to === "api/src/main/java/example/Api.java" &&
        edge.kind === "file",
    ),
  );
  assert.deepEqual(extractRepositoryImports([...files].reverse()), result);
  assert.equal(repositoryFacts(files).imports.edges.length, 5);
});

test("Java package and declaration parsing ignores comments, literals, text blocks and local classes", () => {
  const files = [
    java("real.Target", "public interface Target { enum Nested {} }"),
    java("real.Other", "record Other(int value) {} @interface Marker {}"),
    source(
      "app/Main.java",
      `
      /* package fake; import fake.Target; class Fake {} */
      @SuppressWarnings("package fake; import fake.Target;")
      package app;
      import real.Target.Nested;
      import real.Other;
      import real.Marker;
      public class Main {
        String example = "import fake.Target; class Fake {}";
        String block = """
          import fake.Target;
          class Fake {}
          """;
        char quote = '\\'';
        void f() { class Local {} }
      }
    `,
    ),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 3);
  assert.ok(result.edges.every((edge) => edge.from === "app/Main.java"));
  const local = extractRepositoryImports([
    ...files,
    source("app/Consumer.java", "package app; import app.Main.Local; class Consumer {}"),
  ]);
  assert.ok(local.issues.some((issue) => issue.specifier === "app.Main.Local"));
});

test("Java uses declared package/type identities instead of guessing a type from its filename", () => {
  const result = extractRepositoryImports([
    source(
      "custom/Filename.java",
      "package actual.pkg; class Secondary {} class Container { static class Inner {} }",
    ),
    source(
      "custom/App.java",
      "package consumer; import actual.pkg.Secondary; import actual.pkg.Container.Inner; import static actual.pkg.Container.Inner; class App {}",
    ),
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 3);
  assert.ok(result.edges.every((edge) => edge.to === "custom/Filename.java"));
});

test("Java static imports require an enclosing type and preserve annotated declaration headers", () => {
  const result = extractRepositoryImports([
    source(
      "api/Container.java",
      "package api; public class Container<@Marker({1, 2}) T> { public static class Nested {} }",
    ),
    source("api/Container/value.java", "package api.Container; public class value {}"),
    source("unrelated/Missing/value.java", "package unrelated.Missing; public class value {}"),
    source(
      "client/Main.java",
      "package client; import api.Container.Nested; import static api.Container.value; import static unrelated.Missing.value; class Main {}",
    ),
  ]);
  assert.equal(result.edges.length, 2);
  assert.ok(result.edges.every((edge) => edge.to === "api/Container.java"));
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.specifier, "static unrelated.Missing.value");
});

test("Java wildcard, duplicate types and unknown classpath stay diagnostic without speculative edges", () => {
  const result = extractRepositoryImports([
    java("pkg.Api", "class Api {}", "first/src/main/java"),
    java("pkg.Api", "class Api {}", "second/src/main/java"),
    java(
      "app.Main",
      "import pkg.Api; import pkg.*; import unknown.External; import java.util.*; import static java.util.Collections.emptyList; class Main {}",
    ),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 3);
  assert.match(
    result.issues.find((issue) => issue.specifier === "pkg.Api")!.reason,
    /multiple local definitions/,
  );
  assert.match(result.issues.find((issue) => issue.specifier === "pkg.*")!.reason, /wildcard/);
  assert.match(
    result.issues.find((issue) => issue.specifier === "unknown.External")!.reason,
    /classpath/,
  );
});

test("Java test-only sources do not create edges or duplicate production definitions", () => {
  const result = extractRepositoryImports([
    java("pkg.Api", "class Api {}"),
    java("pkg.Api", "class Api {}", "src/test/java"),
    java("app.Main", "import pkg.Api; class Main {}"),
    java("tests.Hidden", "import missing.Target; class Hidden {}", "src/test/java"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.edges.length, 1);
});

test("Java malformed, unavailable, Unicode-preprocessed and JPMS sources preserve explicit diagnostics", () => {
  const result = extractRepositoryImports([
    source("broken/Bad.java", "package broken; import missing. ; class Bad { /*"),
    source("unread/Missing.java"),
    source("escaped/Main.java", "package escaped; \\u0069mport hidden.Target; class Main {}"),
    source("src/main/java/module-info.java", "module example { requires java.base; }"),
    java("ok.Target", "class Target {}"),
    java("ok.Main", "import ok.Target; class Main {}"),
  ]);
  assert.equal(result.edges.length, 1);
  assert.ok(result.issues.some((issue) => /Unterminated block/.test(issue.reason)));
  assert.ok(result.issues.some((issue) => /import declaration/.test(issue.reason)));
  assert.ok(result.issues.some((issue) => /bytes are unavailable/.test(issue.reason)));
  assert.ok(result.issues.some((issue) => /Unicode escape/.test(issue.reason)));
  assert.ok(result.issues.some((issue) => /JPMS/.test(issue.reason)));
});

test("Maven literal sourceDirectory/modules and Gradle literal includes describe conventional roots", () => {
  const issues: Parameters<typeof javaBuildRoots>[1] = [];
  const roots = javaBuildRoots(
    [
      source(
        "pom.xml",
        '<project xmlns="http://maven.apache.org/POM/4.0.0"><build><sourceDirectory>${project.basedir}/code/java</sourceDirectory></build><modules><module>lib</module></modules></project>',
      ),
      source("settings.gradle", "include ':app', ':nested:service' // sourceSets"),
      source("tools/settings.gradle.kts", 'include(":one", ":two")'),
      source(
        "build.gradle",
        'apply plugin: "java"; dependencies { implementation project(":lib") }',
      ),
    ],
    issues,
  );
  assert.deepEqual(issues, []);
  assert.deepEqual([...roots].sort(), [
    "app/src/main/java",
    "code/java",
    "lib/src/main/java",
    "nested/service/src/main/java",
    "src/main/java",
    "tools/one/src/main/java",
    "tools/src/main/java",
    "tools/two/src/main/java",
  ]);
});

test("Maven/Gradle unreadable or unsupported build declarations are never treated as complete configuration", () => {
  const configs = [
    source("bad/pom.xml", "<project><build></project>"),
    source("text/pom.xml", "not XML <project/>"),
    source(
      "unknown/pom.xml",
      "<project><build><sourceDirectory>${custom}</sourceDirectory></build><modules><module>${member}</module></modules><profiles><profile/></profiles></project>",
    ),
    source(
      "plugin/pom.xml",
      "<project><build><plugins><plugin><artifactId>build-helper-maven-plugin</artifactId></plugin></plugins></build></project>",
    ),
    source("unread/pom.xml"),
    source("gradle/build.gradle.kts", 'sourceSets { main { java.srcDirs("custom") } }'),
    source("dynamic/settings.gradle", "include(findProjects())"),
    source("partial/settings.gradle.kts", 'include(":app", dynamicProject)'),
    source("applied/build.gradle", "apply from: 'custom.gradle'"),
    source("broken/build.gradle", "plugins {"),
  ];
  const result = extractRepositoryImports([...configs, java("ok.Main", "class Main {}")]);
  assert.ok(configs.every((config) => result.issues.some((issue) => issue.file === config.path)));
  assert.deepEqual(result.edges, []);
  assert.equal(
    extractRepositoryImports(configs).issues.length,
    0,
    "non-Java materials do not inspect Java build configuration",
  );
});

test("Gradle includes accept complete literal arguments and Kotlin trailing commas", () => {
  for (const [file, content] of [
    ["settings.gradle.kts", 'include(":api", ":app",)'],
    ["settings.gradle.kts", 'include(\n ":api", // next\n ":app", /* last */\n)'],
    ["settings.gradle", "include ':api'\ninclude ':app'"],
    ["settings.gradle", "include ':api'; include ':app'"],
  ]) {
    const issues: Parameters<typeof javaBuildRoots>[1] = [];
    const roots = javaBuildRoots([source(file!, content)], issues);
    assert.deepEqual(issues, [], content);
    assert.deepEqual(
      [...roots].sort(),
      ["api/src/main/java", "app/src/main/java", "src/main/java"],
      content,
    );
  }
});

test("Gradle include expressions are skipped instead of adopting a literal prefix", () => {
  for (const [file, content, knownProjects] of [
    ["settings.gradle.kts", 'val suffix = "api"; include(":lib-" + suffix)', []],
    ["settings.gradle", "def suffix = 'api'; include ':lib-' + suffix", []],
    ["settings.gradle.kts", 'include(":API".lowercase())', []],
    ["settings.gradle", "include ':API'.toLowerCase()", []],
    ["settings.gradle.kts", 'include(select(":api", ":app"))', []],
    ["settings.gradle.kts", 'include(":api", ":lib-" + suffix, ":app",)', ["api", "app"]],
    ["settings.gradle", "include ':api', ':lib-' + suffix, ':app'", ["api", "app"]],
    ["settings.gradle", "include ':lib-'\n  + suffix", []],
    ["settings.gradle", "include", []],
  ] as const) {
    const issues: Parameters<typeof javaBuildRoots>[1] = [];
    const roots = javaBuildRoots([source(file!, content)], issues);
    assert.ok(
      issues.some((issue) => /Dynamic Gradle project include/.test(issue.reason)),
      content,
    );
    assert.ok(!roots.has("lib-/src/main/java"), content);
    assert.ok(!roots.has("API/src/main/java"), content);
    assert.deepEqual(
      [...roots].sort(),
      [...knownProjects.map((project) => project + "/src/main/java"), "src/main/java"].sort(),
      content,
    );
  }
});

test("Java focused extraction requests candidate package declarations and its own build ancestry", () => {
  const files = [
    source("pom.xml", "<project/>"),
    java("client.Main", "import api.Secondary; class Main {}"),
    source("src/main/java/api/Container.java"),
    source("other/pom.xml"),
    source("other/src/main/java/unrelated/Broken.java"),
  ];
  const focus = ["src/main/java/client/Main.java"];
  const first = extractJavaImports(files, focus);
  assert.ok(first.requiredFiles.includes("src/main/java/api/Container.java"));
  assert.ok(first.requiredFiles.includes("pom.xml"));
  assert.ok(!first.requiredFiles.includes("other/pom.xml"));
  assert.ok(!first.requiredFiles.includes("other/src/main/java/unrelated/Broken.java"));
  files[2]!.content = "package api; class Secondary {}";
  const result = extractJavaImports(files, focus);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges[0]?.to, "src/main/java/api/Container.java");
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "java-imports-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  initializeFixtureRepository(root);
  const files = [
    source("pom.xml", "<project/>"),
    java("api.Api", "public class Api {}"),
    java("client.Main", "import api.Api; class Main {}"),
    source("other/pom.xml", "<invalid"),
    source("other/src/main/java/unrelated/Broken.java", "invalid"),
    source("web/main.ts", "export {}"),
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await fs.writeFile(path.join(root, file.path), file.content!);
  }
  return { root, files };
}

test("Java FS collection reads supplied Java/config files and leaves unrelated bytes unparsed", async (t) => {
  const { root, files } = await fixture(t);
  const collected = await readRepositorySources(
    root,
    files.map((file) => file.path),
  );
  assert.deepEqual(collected.errors, []);
  assert.deepEqual(pairs(extractRepositoryImports(collected.files)), [
    "src/main/java/client/Main.java -> src/main/java/api/Api.java",
  ]);
  const missing = await readRepositorySources(root, ["missing/Main.java"]);
  assert.equal(missing.errors.length, 1);
  assert.match(extractRepositoryImports(missing.files).issues[0]!.reason, /unavailable/);
});

test("Java narrow structure materials resolve supporting packages and reject required byte/config failures", async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(
    path.join(root, "other/src/main/java/unrelated/Broken.java"),
    Buffer.from([0xff, 0xfe]),
  );
  await fs.writeFile(path.join(root, "src/main/java/Unrelated.java"), Buffer.from([0xff, 0xfe]));
  const observe = () =>
    withStructureSnapshot(() =>
      observeStructureMaterial(root, "Module/Module.md", "../../src/main/java/client/"),
    );
  assert.deepEqual((await observe()).structureDependencies, ["src/main/java/api/"]);
  await fs.writeFile(path.join(root, "src/main/java/api/Api.java"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(observe, /encoded data|valid text/i);
  await fs.writeFile(path.join(root, "src/main/java/api/Api.java"), "package api; class Api { /*");
  await assert.rejects(observe, /Unterminated block comment/);
  await fs.writeFile(path.join(root, "src/main/java/api/Api.java"), "package api; class Api {}");
  await fs.writeFile(path.join(root, "pom.xml"), "<broken");
  await assert.rejects(observe, /Java build configuration/);
  const web = await withStructureSnapshot(() =>
    observeStructureMaterial(root, "Module/Module.md", "../../web/"),
  );
  assert.deepEqual(web.structureDependencies, []);
});

test("Java structure availability follows complete Gradle include argument diagnostics", async (t) => {
  const { root } = await fixture(t);
  const observe = () =>
    withStructureSnapshot(() =>
      observeStructureMaterial(root, "Module/Module.md", "../../src/main/java/client/"),
    );
  for (const [file, content, available] of [
    ["settings.gradle.kts", 'include(":api", ":app",)', true],
    ["settings.gradle.kts", 'include(":lib-" + suffix)', false],
    ["settings.gradle.kts", 'include(":API".lowercase())', false],
    ["settings.gradle", "include ':lib-' + suffix", false],
  ] as const) {
    await fs.writeFile(path.join(root, file), content);
    if (available)
      assert.deepEqual((await observe()).structureDependencies, ["src/main/java/api/"]);
    else await assert.rejects(observe, /Dynamic Gradle project include/);
    await fs.writeFile(path.join(root, file), "");
  }
});
