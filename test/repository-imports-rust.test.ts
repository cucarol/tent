import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRepositoryImports,
  isImportConfig,
  isImportSource,
  type RepositorySource,
} from "../src/core/base/repository-imports.js";

const source = (path: string, content = ""): RepositorySource => ({ path, content });
const cargo = (extra = "", edition = "2021") =>
  source("Cargo.toml", `[package]\nname = "app"\nedition = "${edition}"\n${extra}`);
const targets = (files: RepositorySource[]) =>
  extractRepositoryImports(files).edges.map(
    (edge) => `${edge.from} -> ${edge.specifier} -> ${edge.to}`,
  );

test("Rust sources and Cargo manifests participate in shared collection", () => {
  assert.equal(isImportSource("src/lib.rs"), true);
  assert.equal(isImportConfig("crates/a/Cargo.toml"), true);
  assert.equal(isImportConfig("Cargo.lock"), false);
});

test("Rust use trees retain aliases/self/globs and resolve regular and inline modules", () => {
  const files = [
    cargo(),
    source(
      "src/lib.rs",
      `
    pub mod model;
    mod nested { pub mod inner; use crate::model::{self as m, Item, Kind::{A, B}, sub::{self, *}}; }
    use self::model::Item as Alias;
    fn example() { use crate::model::Item; }
  `,
    ),
    source("src/model.rs", "pub struct Item; pub enum Kind { A, B } pub mod sub { pub fn f() {} }"),
    source("src/nested/inner.rs", "use super::super::model::Item; use crate::model::Kind::A;"),
    source("src/ignored.rs", ""),
  ];
  const result = extractRepositoryImports(files.filter((file) => file.path !== "src/ignored.rs"));
  assert.deepEqual(result.issues, []);
  assert.ok(
    result.edges.some(
      (edge) => edge.specifier === "crate::model::Kind::A" && edge.to === "src/model.rs",
    ),
  );
  for (const specifier of [
    "crate::model",
    "crate::model::Item",
    "crate::model::Kind::A",
    "crate::model::Kind::B",
    "crate::model::sub",
    "crate::model::sub::*",
    "self::model::Item",
  ])
    assert.ok(
      result.edges.some((edge) => edge.specifier === specifier),
      specifier,
    );
  assert.ok(
    result.edges.some(
      (edge) =>
        edge.from === "src/lib.rs" &&
        edge.to === "src/nested/inner.rs" &&
        edge.specifier === "mod inner",
    ),
  );
  assert.deepEqual(
    extractRepositoryImports([...files.filter((file) => file.path !== "src/ignored.rs")].reverse()),
    result,
  );
  assert.equal(result.scannedFiles, 3);
});

test("Rust lexer masks nested comments, strings, raw strings and characters without losing lifetimes", () => {
  const result = extractRepositoryImports([
    cargo(),
    source(
      "src/lib.rs",
      `
    /* outer /* use crate::fake::Fake; */ mod fake; */
    // use crate::fake::Fake;
    const EXAMPLE: &str = "use crate::fake::Fake; mod fake;";
    const RAW: &str = r###"use crate::fake::Fake; \" # }"###;
    const BYTES: &[u8] = br##"mod fake;"##;
    const C: char = '\\'';
    const B: u8 = b'\\x27';
    const OPEN: &str = "{";
    const SEMICOLON: &str = ";";
    pub mod real;
    fn lifetime<'a>(x: &'a str) -> &'static str { use crate::real::LifetimeOnly; "" }
    use crate::real::TopLevelOnly;
    #[cfg(test)] mod tests { use crate::fake::Fake; mod absent; }
  `,
    ),
    source("src/real.rs", "pub struct LifetimeOnly; pub struct TopLevelOnly;"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual([...new Set(result.edges.map((edge) => edge.to))], ["src/real.rs"]);
  assert.ok(result.edges.some((edge) => edge.specifier === "crate::real::LifetimeOnly"));
  assert.ok(result.edges.some((edge) => edge.specifier === "crate::real::TopLevelOnly"));
});

test("Rust non-mod-rs and mod-rs nesting use the declared module directory", () => {
  for (const moduleFile of ["src/outer.rs", "src/outer/mod.rs"]) {
    const result = extractRepositoryImports([
      cargo(),
      source("src/lib.rs", "mod outer;"),
      source(moduleFile, "mod child; mod inline { mod leaf; }"),
      source("src/outer/child.rs", "use super::inline::leaf::Leaf;"),
      source("src/outer/inline/leaf.rs", "pub struct Leaf;"),
    ]);
    assert.deepEqual(result.issues, []);
    assert.ok(
      result.edges.some(
        (edge) => edge.from === "src/outer/child.rs" && edge.to === "src/outer/inline/leaf.rs",
      ),
    );
  }
});

test("Rust Cargo maps renamed path dependencies and inherited workspace dependencies only when declared", () => {
  const files = [
    source(
      "Cargo.toml",
      `
    [workspace]
    members = ["app", "helper", "unrelated"]
    [workspace.package]
    edition = "2024"
    [workspace.dependencies]
    renamed = { package = "helper-package", path = "helper" }
  `,
    ),
    source(
      "app/Cargo.toml",
      `
    [package]
    name = "consumer"
    edition.workspace = true
    [dependencies]
    renamed.workspace = true
    serde = "1"
  `,
    ),
    source(
      "app/src/lib.rs",
      "use renamed::{Item as Alias, inner::Inner}; use serde::Serialize; use std::io; use unrelated::Thing;",
    ),
    source(
      "helper/Cargo.toml",
      '[package]\nname="helper-package"\nedition="2021"\n[lib]\nname="custom_lib"\npath="api.rs"',
    ),
    source("helper/api.rs", "pub struct Item; pub mod inner;"),
    source("helper/inner.rs", "pub struct Inner;"),
    source("unrelated/Cargo.toml", '[package]\nname="unrelated"\nedition="2021"'),
    source("unrelated/src/lib.rs", "pub struct Thing;"),
  ];
  const result = extractRepositoryImports(files);
  assert.ok(
    result.edges.some((edge) => edge.from === "app/src/lib.rs" && edge.to === "helper/api.rs"),
  );
  assert.ok(
    result.edges.some((edge) => edge.from === "app/src/lib.rs" && edge.to === "helper/inner.rs"),
  );
  assert.deepEqual(
    result.issues.map((issue) => issue.specifier),
    ["unrelated::Thing"],
  );
});

test("Rust explicit Cargo bin roots, default binary roots and own library use separate crate contexts", () => {
  const result = extractRepositoryImports([
    cargo(`[[bin]]\nname="custom"\npath="cmd/main.rs"`),
    source("src/lib.rs", "pub mod model;"),
    source("src/model.rs", "pub struct Item;"),
    source("src/main.rs", "use app::model::Item; mod local;"),
    source("src/local.rs", "pub struct Local;"),
    source("cmd/main.rs", "use app::model::Item; mod local;"),
    source("cmd/local.rs", "pub struct Local;"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.ok(result.edges.some((edge) => edge.from === "cmd/main.rs" && edge.to === "cmd/local.rs"));
  assert.ok(result.edges.some((edge) => edge.from === "cmd/main.rs" && edge.to === "src/model.rs"));
  assert.ok(result.edges.some((edge) => edge.from === "src/main.rs" && edge.to === "src/model.rs"));
});

test("Rust 2015 bare paths resolve from root while modern bare paths use module scope", () => {
  for (const edition of ["2015", "2021"]) {
    const result = extractRepositoryImports([
      cargo("", edition),
      source("src/lib.rs", "mod model; mod nested;"),
      source("src/model.rs", "pub struct Item;"),
      source("src/nested.rs", "use model::Item;"),
    ]);
    assert.equal(result.issues.length, edition === "2015" ? 0 : 1);
    assert.equal(
      result.edges.some((edge) => edge.from === "src/nested.rs"),
      edition === "2015",
    );
  }
});

test("Rust diagnoses conditional, macro, include, procedural and path-derived imports without fake edges", () => {
  const result = extractRepositoryImports([
    cargo(),
    source(
      "src/lib.rs",
      `
    #[cfg(feature="hidden")] mod conditional;
    #[path="other.rs"] mod redirected;
    macro_rules! generated { () => { use crate::missing::Thing; mod fake; } }
    generated!();
    include!(concat!(env!("OUT_DIR"), "/generated.rs"));
    #[custom_attribute] fn decorated() { use crate::missing::Thing; }
    #[derive(Custom)] struct Item;
    println!("use crate::missing::Thing;");
  `,
    ),
  ]);
  assert.deepEqual(result.edges, []);
  for (const specifier of [
    "cfg",
    "path",
    "macro_rules",
    "generated",
    "include",
    "custom_attribute",
    "derive",
  ])
    assert.ok(
      result.issues.some((issue) => issue.specifier === specifier),
      specifier,
    );
  assert.ok(!result.issues.some((issue) => issue.specifier?.includes("missing")));
});

test("Rust unresolved re-export chains preserve direct declaration edges without fabricated consumer edges", () => {
  const result = extractRepositoryImports([
    cargo(),
    source("src/lib.rs", "pub mod facade; mod consumer;"),
    source("src/facade.rs", "mod actual; pub use self::actual::Item;"),
    source("src/facade/actual.rs", "pub struct Item;"),
    source("src/consumer.rs", "use crate::facade::Item;"),
  ]);
  assert.ok(
    result.edges.some(
      (edge) =>
        edge.from === "src/facade.rs" &&
        edge.to === "src/facade/actual.rs" &&
        edge.specifier === "self::actual::Item",
    ),
  );
  assert.ok(!result.edges.some((edge) => edge.from === "src/consumer.rs"));
  assert.ok(
    result.issues.some(
      (issue) => issue.file === "src/consumer.rs" && /re-export/.test(issue.reason),
    ),
  );
});

test("Rust ambiguous/missing module candidates and unavailable source/config bytes stay diagnostic", () => {
  const result = extractRepositoryImports([
    cargo(),
    source("src/lib.rs", "mod duplicate; mod absent; mod unreadable;"),
    source("src/duplicate.rs"),
    source("src/duplicate/mod.rs"),
    { path: "src/unreadable.rs" },
    source("src/orphan.rs", "use std::io;"),
  ]);
  assert.deepEqual(result.edges, [
    {
      from: "src/lib.rs",
      to: "src/unreadable.rs",
      kind: "file",
      specifier: "mod unreadable",
      execution: "compile-time" as const,
    },
  ]);
  for (const reason of [/multiple source/, /absent/, /content is unavailable/, /no unambiguous/])
    assert.ok(result.issues.some((issue) => reason.test(issue.reason)));
  for (const config of [{ path: "Cargo.toml" }, source("Cargo.toml", '[package\nname = "bad"')]) {
    const missing = extractRepositoryImports([
      config,
      source("src/lib.rs", "use crate::other::Item;"),
    ]);
    assert.ok(missing.issues.some((issue) => issue.file === "Cargo.toml"));
    assert.ok(missing.issues.some((issue) => issue.file === "src/lib.rs"));
    assert.deepEqual(missing.edges, []);
  }
});

test("Rust conditional/optional or missing path dependencies cannot be reported as known external", () => {
  const result = extractRepositoryImports([
    cargo(`
    [dependencies]
    optional = {version="1", optional=true}
    missing = {path="../missing"}
    empty = {}
    [target.'cfg(unix)'.dependencies]
    conditional = "1"
  `),
    source(
      "src/lib.rs",
      "use optional::Item; use missing::Item; use conditional::Item; use unknown::Item; use empty::Item;",
    ),
  ]);
  assert.equal(result.issues.length, 5);
  assert.deepEqual(result.edges, []);
});

test("Rust raw identifiers remain identifiers and unterminated lexical input is diagnosed", () => {
  const files = [
    cargo(),
    source("src/lib.rs", 'mod r#type; use crate::r#type::Item; const r#use: &str = "example";'),
    source("src/type.rs", "pub struct Item;"),
  ];
  assert.deepEqual(extractRepositoryImports(files).issues, []);
  assert.ok(targets(files).some((target) => target.includes("crate::type::Item")));
  for (const content of ["/* missing", 'const S: &str = r##"missing', 'const S: &str = "missing']) {
    assert.ok(
      extractRepositoryImports([cargo(), source("src/lib.rs", content)]).issues.some((issue) =>
        /unterminated/.test(issue.reason),
      ),
    );
  }
});

test("Rust test-only file modules and test functions do not contribute dependency facts", () => {
  const result = extractRepositoryImports([
    cargo(),
    source(
      "src/lib.rs",
      `
    pub mod real;
    #[cfg(test)] #[custom_test_attribute] mod unit;
    #[test] fn standalone() { use crate::absent::Missing; }
    fn runtime() { if !(true) { use crate::real::Real; } while !false {} }
  `,
    ),
    source("src/real.rs", "pub struct Real;"),
    source("src/unit.rs", "mod helper; use crate::absent::Missing;"),
    source("src/unit/helper.rs", "use missing::TestOnly;"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.ok(result.edges.every((edge) => edge.from === "src/lib.rs" && edge.to === "src/real.rs"));
  assert.ok(result.edges.some((edge) => edge.specifier === "crate::real::Real"));
});

test("Rust macro arguments with dependency declarations remain diagnostic while stringify stays opaque", () => {
  const result = extractRepositoryImports([
    cargo(),
    source(
      "src/lib.rs",
      `mod real; fn run() { let _ = vec![{ use crate::real::Real; 1 }]; let _ = stringify!(use crate::absent::Missing;); }`,
    ),
    source("src/real.rs", "pub struct Real;"),
  ]);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.specifier, "vec");
  assert.ok(!result.edges.some((edge) => edge.specifier === "crate::real::Real"));
});

test("Rust conditional enum variants stay explicit", () => {
  const result = extractRepositoryImports([
    cargo(),
    source("src/lib.rs", "mod model; mod consumer;"),
    source(
      "src/model.rs",
      'pub enum Kind { Always, #[cfg(feature="hidden")] Hidden, #[cfg(test)] TestOnly }',
    ),
    source("src/consumer.rs", "use crate::model::Kind::{Always, Hidden, TestOnly};"),
  ]);
  assert.ok(result.edges.some((edge) => edge.specifier === "crate::model::Kind::Always"));
  assert.ok(!result.edges.some((edge) => /Hidden|TestOnly/.test(edge.specifier)));
  assert.ok(result.issues.some((issue) => /conditional enum/.test(issue.reason)));
  assert.equal(result.issues.filter((issue) => issue.file === "src/consumer.rs").length, 2);
});

test("Rust block imports inside ordinary expression groups are traversed independently", () => {
  for (const expression of [
    "({ use crate::model::Item; 1 })",
    "[{ use crate::model::Item; 1 }]",
    "consume({ use crate::model::Item; 1 })",
    "consume(|| { use crate::model::Item; 1 })",
    "([{ use crate::model::Item; 1 }],)",
  ]) {
    const result = extractRepositoryImports([
      cargo(),
      source("src/lib.rs", "mod model; mod consumer;"),
      source("src/model.rs", "pub struct Item;"),
      source("src/consumer.rs", `pub fn run() { let _ = ${expression}; }`),
    ]);
    assert.deepEqual(result.issues, [], expression);
    assert.deepEqual(
      result.edges.filter((edge) => edge.from === "src/consumer.rs"),
      [
        {
          from: "src/consumer.rs",
          to: "src/model.rs",
          kind: "file",
          specifier: "crate::model::Item",
          execution: "compile-time" as const,
        },
      ],
      expression,
    );
  }
});

test("Rust explicit library survives disabled auto-discovery with its default path", () => {
  const result = extractRepositoryImports([
    cargo('autolib=false\n[lib]\nname="app"'),
    source("src/lib.rs", "mod model;"),
    source("src/model.rs", "pub struct Item;"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.edges, [
    {
      from: "src/lib.rs",
      to: "src/model.rs",
      kind: "file",
      specifier: "mod model",
      execution: "compile-time" as const,
    },
  ]);
});

test("Rust 2015 other target classes do not disable inferred binaries", () => {
  for (const [target, library] of [
    ['[lib]\npath="api.rs"', "api.rs"],
    ['[[example]]\nname="demo"\npath="demo.rs"', "src/lib.rs"],
    ['[[test]]\nname="integration"\npath="integration.rs"', "src/lib.rs"],
    ['[[bench]]\nname="measurement"\npath="measurement.rs"', "src/lib.rs"],
  ]) {
    const result = extractRepositoryImports([
      cargo(target, "2015"),
      source(library),
      source("src/main.rs", "mod automatic; fn main() {}"),
      source("src/automatic.rs"),
      source("src/bin/extra/main.rs", "mod helper; fn main() {}"),
      source("src/bin/extra/helper.rs"),
    ]);
    assert.deepEqual(result.issues, [], target);
    assert.ok(
      result.edges.some((edge) => edge.from === "src/main.rs" && edge.to === "src/automatic.rs"),
      target,
    );
    assert.ok(
      result.edges.some(
        (edge) => edge.from === "src/bin/extra/main.rs" && edge.to === "src/bin/extra/helper.rs",
      ),
      target,
    );
  }
});

test("Rust binary tables leave default libraries available and apply same-class discovery defaults", () => {
  for (const edition of ["2015", "2021"])
    for (const auto of [undefined, false, true]) {
      const discover = auto ?? edition !== "2015";
      const result = extractRepositoryImports([
        cargo(
          `${auto === undefined ? "" : `autobins=${auto}\n`}[[bin]]\nname="tool"\npath="tool/main.rs"`,
          edition,
        ),
        source("tool/main.rs", "mod helper; fn main() {}"),
        source("tool/helper.rs"),
        source("src/lib.rs", "mod model;"),
        source("src/model.rs", "pub struct Item;"),
        source("src/main.rs", "mod automatic; fn main() {}"),
        source("src/automatic.rs"),
        source("src/bin/extra/main.rs", "mod helper; fn main() {}"),
        source("src/bin/extra/helper.rs"),
      ]);
      assert.ok(
        result.edges.some((edge) => edge.from === "tool/main.rs" && edge.to === "tool/helper.rs"),
      );
      assert.ok(
        result.edges.some((edge) => edge.from === "src/lib.rs" && edge.to === "src/model.rs"),
      );
      assert.equal(
        result.edges.some((edge) => edge.from === "src/main.rs"),
        discover,
      );
      assert.equal(
        result.edges.some((edge) => edge.from === "src/bin/extra/main.rs"),
        discover,
      );
      if (discover) assert.deepEqual(result.issues, []);
      else
        assert.ok(
          result.issues.some(
            (issue) => issue.file === "src/main.rs" && /no unambiguous/.test(issue.reason),
          ),
        );
    }
});

test("Rust explicit discovery switches affect only their target class", () => {
  const libraryOff = extractRepositoryImports([
    cargo('autolib=false\n[[bin]]\nname="tool"\npath="tool/main.rs"', "2015"),
    source("tool/main.rs", "mod helper; fn main() {}"),
    source("tool/helper.rs"),
    source("src/lib.rs", "mod model;"),
    source("src/model.rs"),
  ]);
  assert.ok(libraryOff.edges.some((edge) => edge.from === "tool/main.rs"));
  assert.ok(!libraryOff.edges.some((edge) => edge.from === "src/lib.rs"));
  assert.ok(libraryOff.issues.some((issue) => issue.file === "src/lib.rs"));
  const binariesOff = extractRepositoryImports([
    cargo('autobins=false\n[lib]\npath="api.rs"', "2015"),
    source("api.rs", "mod model;"),
    source("model.rs"),
    source("src/main.rs", "mod automatic; fn main() {}"),
    source("src/automatic.rs"),
  ]);
  assert.ok(binariesOff.edges.some((edge) => edge.from === "api.rs" && edge.to === "model.rs"));
  assert.ok(!binariesOff.edges.some((edge) => edge.from === "src/main.rs"));
  assert.ok(binariesOff.issues.some((issue) => issue.file === "src/main.rs"));
});

test("Rust target edition overrides package edition separately for library and binaries", () => {
  const result = extractRepositoryImports([
    cargo('[lib]\nedition="2015"\n[[bin]]\nname="tool"\npath="tool/main.rs"\nedition="2015"'),
    source("src/lib.rs", "mod model; mod consumer;"),
    source("src/model.rs", "pub struct Item;"),
    source("src/consumer.rs", "use model::Item;"),
    source("tool/main.rs", "mod model; mod consumer;"),
    source("tool/model.rs", "pub struct Item;"),
    source("tool/consumer.rs", "use model::Item;"),
  ]);
  assert.deepEqual(result.issues, []);
  assert.ok(
    result.edges.some((edge) => edge.from === "src/consumer.rs" && edge.to === "src/model.rs"),
  );
  assert.ok(
    result.edges.some((edge) => edge.from === "tool/consumer.rs" && edge.to === "tool/model.rs"),
  );
});

test("Rust custom library names and build dependencies follow Cargo target scope", () => {
  const files = [
    cargo(
      '[dependencies]\nhelper-package={path="helper"}\n[build-dependencies]\nonly_build={package="helper-package", path="helper"}',
    ),
    source("src/lib.rs", "use custom_lib::Item; use only_build::Item;"),
    source("build.rs", "use only_build::Item; use custom_lib::Item;"),
    source(
      "helper/Cargo.toml",
      '[package]\nname="helper-package"\nedition="2021"\n[lib]\nname="custom_lib"',
    ),
    source("helper/src/lib.rs", "pub struct Item;"),
  ];
  const result = extractRepositoryImports(files);
  assert.equal(result.edges.length, 2);
  assert.ok(
    result.edges.some(
      (edge) => edge.from === "src/lib.rs" && edge.specifier === "custom_lib::Item",
    ),
  );
  assert.ok(
    result.edges.some((edge) => edge.from === "build.rs" && edge.specifier === "only_build::Item"),
  );
  assert.equal(result.issues.length, 2);
});

test("Rust workspace inheritance preserves member optional flags and reads multiline Cargo strings", () => {
  const result = extractRepositoryImports([
    source(
      "Cargo.toml",
      '[workspace]\nmembers=["app"]\n[workspace.package]\nedition="2024"\n[workspace.dependencies]\nexternal="1"',
    ),
    source(
      "app/Cargo.toml",
      `[package]
    name="app"
    edition.workspace=true
    description="""
    A multi-line description with \\"quoted\\" text.
    """
    [dependencies]
    external={workspace=true, optional=true}
  `,
    ),
    source("app/src/lib.rs", "use external::Item;"),
  ]);
  assert.deepEqual(result.edges, []);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.specifier, "external::Item");
});

test("Rust lexical identifiers and Cargo metadata keys cannot alter parser dictionaries", () => {
  const result = extractRepositoryImports([
    cargo('[package.metadata.__proto__]\nrust_import_probe="value"'),
    source("src/lib.rs", "mod real; fn run() { let __proto__ = 1; use crate::real::Real; }"),
    source("src/real.rs", "pub struct Real;"),
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "rust_import_probe"), false);
  assert.deepEqual(result.issues, []);
  assert.ok(result.edges.some((edge) => edge.specifier === "crate::real::Real"));
});
