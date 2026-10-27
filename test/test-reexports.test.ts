import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRepositoryImports,
  extractRepositoryTestImports,
  type RepositorySource,
} from "../src/core/base/repository-imports.js";
import { checkModuleMap } from "../src/core/check/module-map.js";

const sources = (files: Record<string, string>): RepositorySource[] =>
  Object.entries(files).map(([path, content]) => ({ path, content }));
const targets = (files: Record<string, string>, from: string) =>
  extractRepositoryTestImports(sources(files))
    .edges.filter((e) => e.from === from)
    .map((e) => e.to);
const script = {
  "src/index.ts": 'export { A } from "./a"; export { B } from "./b";',
  "src/a.ts": "export class A {}",
  "src/b.ts": "export class B {}",
};
const python = {
  "p/__init__.py": "from .middle import *\nfrom .b import B",
  "p/middle.py": 'from .a import A as Alias\n__all__=["Alias"]',
  "p/a.py": "class A: pass",
  "p/b.py": "class B: pass",
};

test("test reexports retain the entry, follow only a called value, and do not change production imports", () => {
  const files = {
    ...script,
    "tests/x.test.ts": 'import { A as Call } from "../src/index"; new Call();',
  };
  assert.deepEqual(targets(files, "tests/x.test.ts"), ["src/a.ts", "src/index.ts"]);
  assert.deepEqual(
    extractRepositoryImports(sources(files)).edges.map((e) => [e.from, e.to]),
    [
      ["src/index.ts", "src/a.ts"],
      ["src/index.ts", "src/b.ts"],
    ],
  );
  assert.deepEqual(
    extractRepositoryTestImports(sources(files).reverse()),
    extractRepositoryTestImports(sources(files)),
  );
});

test("Python literal __all__, aliases and the dotted import namespace follow the actual binding", () => {
  assert.deepEqual(
    targets({ ...python, "tests/test_p.py": "import p as api\napi.Alias()" }, "tests/test_p.py"),
    ["p/__init__.py", "p/a.py"],
  );
  const files = {
    "p/__init__.py": "",
    "p/sub.py": "from .a import A",
    "p/a.py": "class A: pass",
    "tests/test_p.py": "import p.sub\np.sub.A()",
  };
  assert.deepEqual(targets(files, "tests/test_p.py"), ["p/a.py", "p/sub.py"]);
});

test("object property keys and methods are not uses of an imported TS binding", () => {
  for (const body of [
    "const obj={A:1};",
    "const obj={A(){}};",
    'const obj={A(x=")"){}};',
    "class Other { A() {} }",
  ]) {
    assert.deepEqual(
      targets(
        { ...script, "tests/x.test.ts": `import {A} from '../src/index'; ${body}` },
        "tests/x.test.ts",
      ),
      ["src/index.ts"],
    );
  }
});

test("a competing binding, assignment or dynamic namespace member never adds a definition", () => {
  for (const body of [
    "function f(A: unknown) { A(); }",
    "const f = (A: any) => A();",
    "function f(...A) { A.forEach(() => {}); } f(1);",
    "const f = (...A) => A.forEach(() => {}); f(1);",
    "let [...A] = []; A.forEach(() => {});",
    "let A=1; A();",
    'api["A"]();',
  ]) {
    assert.deepEqual(
      targets(
        {
          ...script,
          "tests/x.test.ts": `import {A} from '../src/index'; import * as api from '../src/index'; ${body}`,
        },
        "tests/x.test.ts",
      ),
      ["src/index.ts"],
    );
  }
  assert.deepEqual(
    targets({ ...python, "tests/test_p.py": "import p\ndef f(p):\n p.Alias()" }, "tests/test_p.py"),
    ["p/__init__.py"],
  );
});

test("a re-export cannot turn a test helper into a production target", () => {
  assert.deepEqual(
    targets(
      {
        "src/index.ts": 'export {A} from "../tests/helper";',
        "tests/helper.ts": "export function A() {}",
        "tests/x.test.ts": 'import {A} from "../src/index"; A();',
      },
      "tests/x.test.ts",
    ),
    ["src/index.ts"],
  );
});

test("module testedBy credits the unique definition and ancestors while retaining the entry", () => {
  for (const typeOnly of [false, true]) {
    const files = sources({
      ...script,
      "tests/x.test.ts": typeOnly
        ? 'import type {A} from "../src/index"; let x: A;'
        : 'import {A} from "../src/index"; new A();',
    });
    const result = checkModuleMap({
      trackedFiles: files.map((f) => f.path),
      imports: extractRepositoryTestImports(files).edges,
      commits: [],
      nodes: [
        {
          id: "root",
          name: "API",
          path: "API",
          body: "",
          materials: [{ path: "src", kind: "directory", track: "structure" }],
        },
        {
          id: "a",
          name: "A",
          path: "API/A",
          parentId: "root",
          body: "",
          materials: [{ path: "src/a", kind: "prefix", track: "structure" }],
        },
        {
          id: "b",
          name: "B",
          path: "API/B",
          parentId: "root",
          body: "",
          materials: [{ path: "src/b", kind: "prefix", track: "structure" }],
        },
      ],
    });
    assert.deepEqual(result.modules.find((m) => m.id === "root")!.testedBy, ["tests/x.test.ts"]);
    assert.deepEqual(
      result.modules.find((m) => m.id === "a")!.testedBy,
      typeOnly ? [] : ["tests/x.test.ts"],
    );
    assert.deepEqual(result.modules.find((m) => m.id === "b")!.testedBy, []);
  }
});

test("explicit and implicit type-only references retain their direct entry without new attribution", () => {
  for (const body of [
    'import type {A} from "../src/index"; let x: A;',
    'import {type A} from "../src/index"; let x: A;',
    'import {A} from "../src/index"; let x: A;',
    'import * as api from "../src/index"; let x: api.A;',
    'import {A} from "../src/index"; interface X { A(): void }',
    'import {A} from "../src/index"; let x: { A() };',
  ]) {
    assert.deepEqual(targets({ ...script, "tests/x.test.ts": body }, "tests/x.test.ts"), [
      "src/index.ts",
    ]);
  }
});

test("unknown external exports, dynamic __all__, ambiguity and cycles retain only the original entry", () => {
  const cases: Record<string, string>[] = [
    { "src/a.ts": "@replace\nexport class A {}" },
    { "src/index.ts": 'export * from "./a"; export * from "external";' },
    {
      "src/index.ts": 'export * from "./a"; export * from "./b";',
      "src/b.ts": "export class A {}",
    },
    { "src/index.ts": 'export {A} from "./cycle";', "src/cycle.ts": 'export {A} from "./index";' },
  ];
  for (const extra of cases)
    assert.deepEqual(
      targets(
        { ...script, ...extra, "tests/x.test.ts": 'import {A} from "../src/index"; A();' },
        "tests/x.test.ts",
      ),
      ["src/index.ts"],
    );
  assert.deepEqual(
    targets(
      {
        ...python,
        "p/middle.py": "from .a import A as Alias\n__all__=make_exports()",
        "tests/test_p.py": "import p\np.Alias()",
      },
      "tests/test_p.py",
    ),
    ["p/__init__.py"],
  );
});

test("Python deletion, loop/context/exception bindings and namespace overwrite invalidate an export", () => {
  for (const body of [
    "del A",
    "for A in values:\n pass",
    "with manager() as A:\n pass",
    "try:\n pass\nexcept Exception as A:\n pass",
    "import external as A",
    "match value:\n case A:\n  pass",
  ]) {
    const files = {
      "p/__init__.py": "from .a import A\n" + body,
      "p/a.py": "class A: pass",
      "tests/test_p.py": "import p\np.A()",
    };
    assert.deepEqual(targets(files, "tests/test_p.py"), ["p/__init__.py"]);
  }
});

test("a long export chain has no eight-node limit; a cycle after that point still stops", () => {
  const files: Record<string, string> = {
    "src/end.ts": "export function A() {}",
    "tests/x.test.ts": 'import {A} from "../src/i0"; A();',
  };
  for (let i = 0; i < 40; i++)
    files[`src/i${i}.ts`] = `export {A} from "./${i === 39 ? "end" : "i" + (i + 1)}";`;
  assert.deepEqual(targets(files, "tests/x.test.ts"), ["src/end.ts", "src/i0.ts"]);
  files["src/end.ts"] = 'export {A} from "./i12";';
  assert.deepEqual(targets(files, "tests/x.test.ts"), ["src/i0.ts"]);
});

const cargo = '[package]\nname="fixture"\nversion="0.0.0"\nedition="2021"';
test("Rust namespace anchors follow grouped pub use without guessing a missing Core entry", () => {
  const files = {
    "Cargo.toml": cargo,
    "src/lib.rs": "mod a; mod b; pub use self::a::{A}; pub use self::b::B;",
    "src/a.rs": "pub struct A;",
    "src/b.rs": "pub struct B;",
    "tests/t.rs": "use fixture; #[test] fn f(){fixture::A::new();}",
  };
  assert.deepEqual(targets(files, "tests/t.rs"), ["src/a.rs", "src/lib.rs"]);
  const noAnchor = { ...files, "tests/t.rs": "use fixture::A; fn f(){A::new();}" };
  assert.deepEqual(targets(noAnchor, "tests/t.rs"), []);
});

test("Rust let shadow and unknown external pub use conflicts do not produce extra attribution", () => {
  const files = {
    "Cargo.toml": cargo,
    "src/lib.rs": "mod a; pub use a::*;",
    "src/a.rs": "pub struct A;",
  };
  assert.deepEqual(
    targets({ ...files, "tests/t.rs": "use fixture::A; fn f(){let A=1;}" }, "tests/t.rs"),
    [],
  );
  assert.deepEqual(
    targets(
      { ...files, "tests/t.rs": "use fixture; fn f(){let fixture=1; fixture::A::new();}" },
      "tests/t.rs",
    ),
    ["src/lib.rs"],
  );
  const external = {
    ...files,
    "Cargo.toml": cargo + '\n[dependencies]\nexternal="1"',
    "src/lib.rs": "mod a; pub use a::*; pub use external::A;",
    "tests/t.rs": "use fixture; fn f(){fixture::A::new();}",
  };
  assert.deepEqual(targets(external, "tests/t.rs"), ["src/lib.rs"]);
});
