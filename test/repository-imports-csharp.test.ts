import { removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  extractRepositoryImports,
  isImportConfig,
  isImportSource,
  type RepositorySource,
} from "../src/core/base/repository-imports.js";
import { extractCSharpImports } from "../src/core/base/csharp-imports.js";
import { repositoryFacts } from "../src/core/base/repository-facts.js";
import { readRepositorySources } from "../src/fs/repository-sources.js";
import {
  observeStructureMaterial,
  withStructureSnapshot,
} from "../src/fs/structure-observation.js";
import { initializeFixtureRepository, testScratchRoot } from "./scratch.js";

const source = (path: string, content?: string): RepositorySource => ({ path, content });
const project = (name: string, body = "") =>
  source(`${name}/${name}.csproj`, `<Project Sdk="Microsoft.NET.Sdk">${body}</Project>`);
const pairs = (result: ReturnType<typeof extractRepositoryImports>) =>
  result.edges.map(({ from, to }) => `${from} -> ${to}`);

test("C# sources and MSBuild files share the collector classification", () => {
  assert.ok(isImportSource("app/Main.cs"));
  for (const file of [
    "App.csproj",
    "app/App.csproj",
    "Directory.Build.props",
    "app/Directory.Build.targets",
  ])
    assert.ok(isImportConfig(file), file);
  assert.equal(isImportConfig("not.csproj.txt"), false);
});

test("C# static, alias and global using directives resolve declarations through project references", () => {
  const files = [
    project("app", '<ItemGroup><ProjectReference Include="..\\api\\api.csproj" /></ItemGroup>'),
    project("api"),
    source(
      "api/Different.cs",
      "namespace Example { public class Api { public class Nested {} } public record Record(int Value); public struct Value {} public interface Contract {} public enum Choice {} public delegate void Callback(); }",
    ),
    source(
      "app/Main.cs",
      "global using static global::Example.Api; using Alias = Example.Api.Nested; using R = Example.Record; using V = Example.Value; using I = Example.Contract; using E = Example.Choice; using D = Example.Callback; using System; namespace Consumer; class Main {}",
    ),
    project("independent"),
    source("independent/Api.cs", "namespace Example; class Api {}"),
  ];
  const result = extractRepositoryImports(files);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 7);
  assert.ok(result.edges.some((edge) => edge.specifier === "Alias = Example.Api.Nested"));
  assert.ok(
    result.edges.every((edge) => edge.from === "app/Main.cs" && edge.to === "api/Different.cs"),
  );
  assert.equal(result.scannedFiles, 3);
  assert.deepEqual(extractRepositoryImports([...files].reverse()), result);
  assert.deepEqual(repositoryFacts(files).imports, result);
});

test("C# block, nested and file-scoped namespaces resolve relative and escaped names", () => {
  const result = extractRepositoryImports([
    source(
      "types/Types.cs",
      "namespace Outer { namespace Inner { public class @class { public class Nested {} } } }",
    ),
    source(
      "consumer/A.cs",
      "namespace Outer { namespace Consumer { using Alias = Inner.@class.Nested; class A {} } }",
    ),
    source("consumer/B.cs", "namespace Other; using static global::Outer.Inner.@class; record B;"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), [
    "consumer/A.cs -> types/Types.cs",
    "consumer/B.cs -> types/Types.cs",
  ]);
});

test("C# comments, strings and using resources cannot invent directives", () => {
  const result = extractRepositoryImports([
    source("Target.cs", "namespace Real; public class Target {}"),
    source(
      "Main.cs",
      `using RealTarget = Real.Target;
      /* using static Fake.Target; namespace Fake { class Target {} } */
      // using static Fake.Target;
      class Main {
        string normal = "using static Fake.Target;";
        string verbatim = @"using static Fake.Target; ""namespace Fake;""";
        string raw = """" using static Fake.Target; """ namespace Fake; """";
        string interpolation = $"{Call("using static Fake.Target;")} using static Fake.Target;";
        string interpolatedVerbatim = @$"{Call(@"using static Fake.Target;")} namespace Fake;";
        char quote = '\\'';
        void Method() { using var resource = Open(); using (var other = Open()) {} }
      }
      using var topLevel = Open();`,
    ),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), ["Main.cs -> Target.cs"]);
});

test("C# namespace imports do not fan out and partial definitions stay uncertain", () => {
  const result = extractRepositoryImports([
    source("api/One.cs", "namespace Api; partial class Shared {} class One {}"),
    source("api/Two.cs", "namespace Api; partial class Shared {} class Two {}"),
    source(
      "Main.cs",
      "using Api; using Alias = Api; using static Api.Shared; using Missing = External.Unknown; class Main {}",
    ),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 4);
  assert.equal(result.issues.filter((issue) => /namespace using/.test(issue.reason)).length, 2);
  assert.ok(result.issues.some((issue) => /partial/.test(issue.reason)));
  assert.ok(result.issues.some((issue) => /assemblies/.test(issue.reason)));
});

test("C# raw interpolation bodies remain opaque even with nested raw strings", () => {
  const result = extractRepositoryImports([
    source("Target.cs", "namespace Real; class Target {}"),
    source(
      "Main.cs",
      'var text = $$""" {{ """using static Fake.Target;""" }} """; using T = Real.Target;',
    ),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(pairs(result), ["Main.cs -> Target.cs"]);
});

test("C# project references can be transitive or cyclic without project-only import edges", () => {
  const files = [
    project("app", '<ItemGroup><ProjectReference Include="../middle/middle.csproj" /></ItemGroup>'),
    project("middle", '<ItemGroup><ProjectReference Include="../api/api.csproj" /></ItemGroup>'),
    project("api", '<ItemGroup><ProjectReference Include="../app/app.csproj" /></ItemGroup>'),
    source("api/Target.cs", "namespace Api; class Target {}"),
    source("app/Main.cs", "using T = Api.Target; class Main {}"),
  ];
  assert.deepEqual(pairs(extractRepositoryImports(files)), ["app/Main.cs -> api/Target.cs"]);
  files[4]!.content = "class Main {}";
  assert.deepEqual(extractRepositoryImports(files).edges, []);
});

test("C# test-only sources cannot add imports or duplicate production types", () => {
  const result = extractRepositoryImports([
    source("Api.cs", "namespace Api; class Target {}"),
    source("tests/Api.cs", "namespace Api; class Target {}"),
    source("Main.cs", "using T = Api.Target;"),
    source("tests/Main.cs", "using Missing = Missing.Type;"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.edges.length, 1);
});

test("C# malformed/unavailable sources and unsupported compiler context remain diagnostic", () => {
  const result = extractRepositoryImports([
    source("Broken.cs", "namespace Broken; using static Missing.; class Broken { /*"),
    source("Unavailable.cs"),
    source(
      "Conditional.cs",
      "#if FEATURE\nusing T = Local.Target;\n#endif\nextern alias Other; class Conditional {}",
    ),
    source("Target.cs", "namespace Local; class Target {}"),
  ]);
  for (const reason of [
    /Unterminated block/,
    /using directive/,
    /bytes are unavailable/,
    /Conditional compilation/,
    /extern alias/,
  ])
    assert.ok(
      result.issues.some((issue) => reason.test(issue.reason)),
      String(reason),
    );
});

test("C# unknown, malformed, conditional or dynamic project configuration remains diagnostic", () => {
  const configs = [
    source("broken/broken.csproj", "<Project><ItemGroup></Project>"),
    source("invalid/invalid.csproj", "<Project Sdk=nope/>"),
    source("unread/unread.csproj"),
    project("dynamic", '<ItemGroup><ProjectReference Include="$(Root)/Api.csproj" /></ItemGroup>'),
    project(
      "conditional",
      '<ItemGroup Condition="$(TargetFramework) == x"><ProjectReference Include="../api/api.csproj" /></ItemGroup>',
    ),
    project(
      "missing",
      '<ItemGroup><ProjectReference Include="../absent/Api.csproj" /></ItemGroup>',
    ),
    project(
      "custom",
      '<ItemGroup><Compile Include="../Shared/*.cs" /></ItemGroup><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><Import Project="Other.props"/>',
    ),
    source("Directory.Build.props", "<Project/>"),
  ];
  const result = extractRepositoryImports([...configs, source("Main.cs", "class Main {}")]);
  assert.ok(configs.every((config) => result.issues.some((issue) => issue.file === config.path)));
  assert.equal(extractRepositoryImports(configs).issues.length, 0);
});

test("C# focused extraction requests reachable declarations without namespace directory assumptions", () => {
  const files = [
    project("app", '<ItemGroup><ProjectReference Include="../api/api.csproj" /></ItemGroup>'),
    project("api"),
    project("unrelated"),
    source("app/Main.cs", "using T = Api.Target;"),
    source("api/Unexpected.cs", "namespace Api; class Target {}"),
    source("unrelated/Bad.cs"),
  ];
  const result = extractCSharpImports(files, ["app/Main.cs"]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.requiredFiles, [
    "api/Unexpected.cs",
    "api/api.csproj",
    "app/Main.cs",
    "app/app.csproj",
  ]);
  assert.equal(result.edges[0]?.to, "api/Unexpected.cs");
});

test("C# unreachable project namespaces cannot shadow a reachable type in full or focused extraction", () => {
  const files = [
    project("app", '<ItemGroup><ProjectReference Include="../lib/lib.csproj" /></ItemGroup>'),
    project("lib"),
    source("app/Main.cs", "namespace Scope; using T = Api.Target;"),
    source("lib/Target.cs", "namespace Api; class Target {}"),
  ];
  const before = extractRepositoryImports(files);
  files.push(
    project("unrelated"),
    source("unrelated/Other.cs", "namespace Scope.Api.Target; class Other {}"),
  );
  const full = extractRepositoryImports(files);
  const focused = extractCSharpImports(files, ["app/Main.cs"]);
  assert.deepEqual(pairs(full), ["app/Main.cs -> lib/Target.cs"]);
  assert.deepEqual(full.edges, before.edges);
  assert.deepEqual(full.issues, before.issues);
  assert.deepEqual(focused.edges, full.edges);
  assert.deepEqual(full.issues, []);
  assert.deepEqual(focused.issues, full.issues);
});

test("C# visible namespace shadowing is preserved for own and referenced projects", () => {
  for (const shadowProject of ["app", "shadow"]) {
    const reference =
      shadowProject === "shadow" ? '<ProjectReference Include="../shadow/shadow.csproj" />' : "";
    const files = [
      project(
        "app",
        `<ItemGroup><ProjectReference Include="../lib/lib.csproj" />${reference}</ItemGroup>`,
      ),
      project("lib"),
      source(
        "app/Main.cs",
        "namespace Scope; using T = Api.Target; using Absolute = global::Api.Target;",
      ),
      source("lib/Target.cs", "namespace Api; class Target {}"),
      source(`${shadowProject}/Other.cs`, "namespace Scope.Api.Target; class Other {}"),
      ...(shadowProject === "shadow" ? [project("shadow")] : []),
    ];
    const full = extractRepositoryImports(files);
    const focused = extractCSharpImports(files, ["app/Main.cs"]);
    assert.deepEqual(pairs(full), ["app/Main.cs -> lib/Target.cs"]);
    assert.equal(full.edges[0]?.specifier, "Absolute = global::Api.Target");
    assert.equal(full.issues.length, 1);
    assert.equal(full.issues[0]?.specifier, "T = Api.Target");
    assert.match(full.issues[0]!.reason, /namespace using/);
    assert.deepEqual(focused.edges, full.edges);
    assert.deepEqual(focused.issues, full.issues);
  }
});

test("C# FS collection and narrow structure observations read required context and preserve failures", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "csharp-imports-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  initializeFixtureRepository(root);
  const files = [
    project("app", '<ItemGroup><ProjectReference Include="../api/api.csproj" /></ItemGroup>'),
    project("api"),
    project("independent"),
    source("app/Main.cs", "using T = Api.Target; class Main {}"),
    source("api/UnusualName.cs", "namespace Api; class Target {}"),
    source("independent/Bad.cs", "class Bad {}"),
    source("web/main.ts", "export {}"),
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
    "app/Main.cs -> api/UnusualName.cs",
  ]);
  await fs.writeFile(path.join(root, "independent/Bad.cs"), Buffer.from([0xff, 0xfe]));
  const observe = () =>
    withStructureSnapshot(() => observeStructureMaterial(root, "Module/Module.md", "../../app/"));
  assert.deepEqual((await observe()).structureDependencies, ["api/"]);
  await fs.writeFile(path.join(root, "api/UnusualName.cs"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(observe, /encoded data|valid text/i);
  await fs.writeFile(path.join(root, "api/UnusualName.cs"), "namespace Api; class Target { /*");
  await assert.rejects(observe, /Unterminated block/);
  await fs.writeFile(path.join(root, "api/UnusualName.cs"), "namespace Api; class Target {}");
  await fs.writeFile(path.join(root, "app/app.csproj"), "<broken");
  await assert.rejects(observe, /C# project configuration/);
  assert.deepEqual(
    (
      await withStructureSnapshot(() =>
        observeStructureMaterial(root, "Module/Module.md", "../../web/"),
      )
    ).structureDependencies,
    [],
  );
});
