import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";
import { observeMaterialResource } from "../src/fs/source-observation.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";
import {
  changedStructureDependencies,
  structureDependenciesSchema,
  structureFingerprint,
  externalStructureDependencies,
} from "../src/core/base/structure-material.js";

const owner = "index.md";
async function fixture(t: TestContext, repository = true) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "structure-material-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  async function write(file: string, content: string | Buffer) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  await write(".gitignore", ".tent/\n*.tmp\n");
  await write("src/core/card-main.ts", 'import "../out/a.js";\nexport const value = 1;\n');
  await write("src/core/card-helper.ts", "export const helper = 1;\n");
  await write("src/core/sibling.ts", "export const sibling = 1;\n");
  await write("src/out/a.ts", "export const a = 1;\n");
  await write("src/other/b.ts", "export const b = 1;\n");
  if (repository) {
    await git(root, "init", "--quiet", "--initial-branch=main");
    await git(root, "config", "core.autocrlf", "false");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "test: structure fixture");
  } else {
    const original = fs.lstat;
    const mocked = t.mock.method(fs, "lstat", (...args: Parameters<typeof original>) => {
      const filename = String(args[0]);
      if (path.basename(filename) === ".git" && !filename.startsWith(root + path.sep))
        return Promise.reject(
          Object.assign(new Error("No ancestor Git in fixture"), { code: "ENOENT" }),
        );
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
  }
  const observe = (resource = "../src/core/", track: "structure" | "content" = "structure") =>
    observeMaterialResource(
      root,
      owner,
      resource,
      undefined,
      track === "structure" ? track : undefined,
    );
  return { root, write, observe };
}

test("structure fingerprints contain only the outgoing external dependency set", async (t) => {
  const { root, write, observe } = await fixture(t);
  const initial = await observe();
  assert.deepEqual(initial.structureDependencies, ["src/out/"]);
  assert.equal(initial.coverage, undefined);
  await write("src/core/card-main.ts", 'import "../out/a.js";\nexport const value = 99;\n');
  await write("src/core/card-new.ts", "export const extra = true;\n");
  await write("src/core/card-helper.ts", 'import "./card-main.js";\n');
  await write("src/other/b.ts", 'import "../core/card-main.js";\n');
  await write("src/core/card-main.test.ts", 'import "../other/b.js";\n');
  await write("src/core/card-unused.test.ts", Buffer.from([0xff, 0x00]));
  const unchanged = await observe();
  assert.equal(unchanged.observedVersion, initial.observedVersion);
  await fs.rename(
    path.join(root, "src/core/card-new.ts"),
    path.join(root, "src/core/card-renamed.ts"),
  );
  assert.equal((await observe()).observedVersion, initial.observedVersion);
  await fs.rm(path.join(root, "src/core/card-renamed.ts"));
  assert.equal((await observe()).observedVersion, initial.observedVersion);
  await write("src/core/card-main.ts", 'import "../out/a.js"; import "../other/b.js";\n');
  const added = await observe();
  assert.deepEqual(added.structureDependencies, ["src/other/", "src/out/"]);
  assert.notEqual(added.observedVersion, initial.observedVersion);
  assert.deepEqual(
    changedStructureDependencies(initial.structureDependencies!, added.structureDependencies!),
    { changedDependencies: [{ target: "src/other/", state: "added" }] },
  );
  await write("src/core/card-main.ts", 'import "../other/b.js";\n');
  const removed = await observe();
  assert.deepEqual(
    changedStructureDependencies(added.structureDependencies!, removed.structureDependencies!),
    { changedDependencies: [{ target: "src/out/", state: "deleted" }] },
  );
  assert.equal(
    (await openTestFs(path.join(root, ".tent")).observeMaterial("../src/core/", owner, "structure"))
      .coverage,
    undefined,
  );
});

test("cached structure sources preserve dependencies and notice a changed import", async (t) => {
  const { root, write } = await fixture(t);
  const source = path.join(root, "src/core/card-main.ts");
  const old = new Date(Date.now() - 5_000);
  for (const name of ["card-main.ts", "card-helper.ts", "sibling.ts"])
    await fs.utimes(path.join(root, "src/core", name), old, old);
  const cacheDir = path.join(root, ".tent", ".git", "tent-material-cache");
  const observe = () =>
    withFileReadScope(() =>
      observeMaterialResource(root, owner, "../src/core/", cacheDir, "structure"),
    );
  const cold = await observe();
  const original = fs.open;
  const originalStat = fs.lstat,
    originalPath = fs.realpath;
  const states = new Map<string, number>(),
    paths = new Map<string, number>();
  let sourceOpens = 0;
  const mocked = t.mock.method(fs, "open", (...args: Parameters<typeof original>) => {
    if (String(args[0]).startsWith(path.join(root, "src"))) sourceOpens++;
    return original(...args);
  });
  const statMock = t.mock.method(fs, "lstat", (...args: Parameters<typeof originalStat>) => {
    const name = String(args[0]);
    states.set(name, (states.get(name) ?? 0) + 1);
    return originalStat(...args);
  });
  const pathMock = t.mock.method(fs, "realpath", (...args: Parameters<typeof originalPath>) => {
    const name = String(args[0]);
    paths.set(name, (paths.get(name) ?? 0) + 1);
    return originalPath(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    statMock.mock.restore();
    pathMock.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual(await observe(), cold);
  assert.equal(sourceOpens, 0);
  for (const name of [
    "src/core/card-main.ts",
    "src/core/card-helper.ts",
    "src/core/sibling.ts",
    "src/out/a.ts",
    "src/other/b.ts",
  ]) {
    const filename = path.join(root, name);
    assert.equal(states.get(filename), 1, "listing and cache validation share one file lstat");
    assert.equal(paths.has(filename), false, "warm reads resolve parents, not every leaf");
  }
  assert.equal(paths.get(root), 1);
  assert.equal(paths.get(path.join(root, "src/core")), 1);
  await write("src/core/card-main.ts", 'import "../other/b.js";\nexport const value = 1;\n');
  await fs.utimes(source, old, old);
  assert.deepEqual((await observe()).structureDependencies, ["src/other/"]);
  assert.equal(sourceOpens, 1);
});

test("prefix structure excludes members and retains exact same-directory external files", async (t) => {
  const { root, write, observe } = await fixture(t);
  await write("src/core/card-main.ts", 'import "./card-helper.js"; import "./sibling.js";\n');
  const initial = await observe("../src/core/card-*");
  assert.deepEqual(initial.structureDependencies, ["src/core/sibling.ts"]);
  await write("src/core/card-new.ts", 'import "../other/b.js";\n');
  const added = await observe("../src/core/card-*");
  assert.deepEqual(added.structureDependencies, ["src/core/sibling.ts", "src/other/"]);
  await git(root, "add", "src/core/card-new.ts");
  assert.equal((await observe("../src/core/card-*")).observedVersion, added.observedVersion);
  await fs.rm(path.join(root, "src/core/card-new.ts"));
  assert.equal((await observe("../src/core/card-*")).observedVersion, initial.observedVersion);
});

test("nested prefix members use the importing member directory and ignore unrelated unreadable sources", async (t) => {
  const { root, write, observe } = await fixture(t);
  await write("src/core/card-main.ts", "export const main = true;\n");
  await write("src/core/card-nested/member.ts", 'import "../sibling.js";\n');
  await write("src/other/b.ts", Buffer.from([0xff, 0x00]));
  await write("src/other/tsconfig.json", "invalid unrelated config");
  await git(root, "add", "src/core/card-nested/member.ts", "src/other/tsconfig.json");
  assert.deepEqual((await observe("../src/core/card-*")).structureDependencies, ["src/core/"]);
});

test("prefix members resolve untracked targets and include matching targets as internal", async (t) => {
  const { write, observe } = await fixture(t);
  await write("src/core/card-main.ts", 'import "../untracked/target.js";\n');
  await write("src/untracked/target.ts", "export const target = true;\n");
  assert.deepEqual((await observe("../src/core/card-*")).structureDependencies, ["src/untracked/"]);
  await write("src/core/card-main.ts", 'import "./card-untracked.js";\n');
  await write("src/core/card-untracked.ts", "export const target = true;\n");
  assert.deepEqual((await observe("../src/core/card-*")).structureDependencies, []);
});

test("unrelated symbolic paths do not affect structure or prefix content; relevant members remain unavailable", async (t) => {
  const { root, write, observe } = await fixture(t);
  await write("src/core/card-main.ts", "export const value = true;\n");
  const original = fs.lstat;
  let linked = path.join(root, "src/core/sibling.ts");
  const mocked = t.mock.method(fs, "lstat", async (...args: Parameters<typeof original>) => {
    const info = await original(...args);
    return String(args[0]) === linked
      ? new Proxy(info, {
          get(target, key) {
            if (key === "isSymbolicLink") return () => true;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : info;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual((await observe("../src/core/card-*")).structureDependencies, []);
  assert.equal((await observe("../src/core/card-*", "content")).coverage, true);
  linked = path.join(root, "src/core/card-main.ts");
  await assert.rejects(observe("../src/core/card-*"), /Symbolic links/);
  assert.equal((await observe("../src/core/card-*", "content")).coverage, true);
});

test("directory structure resolves ignored tracked targets while preserving nonignored members", async (t) => {
  const { write, observe } = await fixture(t);
  await write(".gitignore", ".tent/\nsrc/out/\nsrc/core/card-helper.ts\n");
  await write("src/core/card-helper.ts", Buffer.from([0xff]));
  assert.deepEqual((await observe()).structureDependencies, ["src/out/"]);
  await write("src/core/card-main.ts", 'import "./card-helper.js";\n');
  assert.deepEqual((await observe()).structureDependencies, ["src/core/card-helper.ts"]);
});

test("prefix coverage does not acquire a version when members change", async (t) => {
  const { root, write, observe } = await fixture(t);
  const initial = await observe("../src/core/card-*", "content");
  assert.equal(initial.coverage, true);
  assert.equal(initial.observedVersion, undefined);
  await write("src/core/card-main.ts", "changed member\n");
  await write("src/core/card-nested/member.ts", Buffer.from([0xff]));
  await fs.rm(path.join(root, "src/core/card-helper.ts"));
  assert.deepEqual(await observe("../src/core/card-*", "content"), initial);
});

test("structure fails honestly for unreadable text, invalid config and unresolved local imports", async (t) => {
  const { write, observe } = await fixture(t);
  await write("src/core/card-main.ts", Buffer.from([0xff]));
  await assert.rejects(observe(), /encoded data was not valid|encoding|UTF-8/i);
  await write("src/core/card-main.ts", "export const value = 1;\n\0");
  await assert.rejects(observe(), /not valid text/);
  await write("src/core/card-main.ts", 'import "./missing.js";\n');
  await assert.rejects(observe(), /absent from tracked files/);
  await write("src/core/card-main.ts", "export const value = 1;\n");
  await write("tsconfig.json", "{ invalid configuration }");
  await assert.rejects(observe(), /Cannot parse TypeScript path configuration/);
});

test("prefix observation is unavailable without a trustworthy ignore interpreter", async (t) => {
  const { observe } = await fixture(t, false);
  await assert.rejects(observe("../src/core/card-*"), /缺少可信的忽略规则解释/);
  assert.equal((await observe("../src/core/card-*", "content")).coverage, true);
});

test("prefix and directory share nonignored membership for tracked and untracked files", async (t) => {
  const { write, observe } = await fixture(t);
  await write(".gitignore", ".tent/\nsrc/core/card-helper.ts\nsrc/core/card-ignored.ts\n");
  await write("src/core/card-main.ts", "export const main = true;\n");
  await write("src/core/card-helper.ts", 'import "../out/a.js";\n');
  await write("src/core/card-ignored.ts", Buffer.from([0xff]));
  await write("src/core/card-untracked.ts", 'import "../other/b.js";\n');
  assert.deepEqual((await observe("../src/core/card-*")).structureDependencies, ["src/other/"]);
  const content = await observe("../src/core/card-*", "content");
  const directory = await observe("../src/core/", "content");
  assert.equal(content.coverage, true);
  assert.equal(directory.coverage, true);
  assert.equal(content.observedVersion, undefined);
  assert.equal(directory.observedVersion, undefined);
});

test("non-Git prefix uses Tent Git ignore rules and supports rule-free standalone reads", async (t) => {
  const { root, write, observe } = await fixture(t, false);
  await write(".gitignore", "");
  assert.deepEqual((await observe("../src/core/card-*")).structureDependencies, ["src/out/"]);
  assert.equal((await observe("../src/core/card-*", "content")).coverage, true);
  await write(".gitignore", ".tent/\nsrc/core/card-helper.ts\nsrc/core/card-ignored.ts\n");
  await write("src/core/card-helper.ts", Buffer.from([0xff]));
  await write("src/core/card-ignored.ts", Buffer.from([0xff]));
  await write("src/core/card-new.ts", 'import "../other/b.js";\n');
  await fs.mkdir(path.join(root, ".tent"));
  await initializeFixtureHistory(path.join(root, ".tent"));
  const adapter = openTestFs(path.join(root, ".tent"));
  const structure = await adapter.observeMaterial("../src/core/card-*", owner, "structure");
  assert.deepEqual(structure.structureDependencies, ["src/other/", "src/out/"]);
  const content = await adapter.observeMaterial("../src/core/card-*", owner);
  const directory = await adapter.observeMaterial("../src/core/", owner);
  assert.equal(content.coverage, true);
  assert.equal(directory.coverage, true);
});

test("standalone directory structure retains safe reading with no ignore rules", async (t) => {
  const { root, write, observe } = await fixture(t, false);
  await write(".gitignore", "");
  const original = fs.lstat;
  let linked = path.join(root, "src/other/b.ts");
  const mocked = t.mock.method(fs, "lstat", async (...args: Parameters<typeof original>) => {
    const info = await original(...args);
    return String(args[0]) === linked
      ? new Proxy(info, {
          get(target, key) {
            if (key === "isSymbolicLink") return () => true;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : info;
  });
  const originalReaddir = fs.readdir;
  const mockedReaddir = t.mock.method(
    fs,
    "readdir",
    async (...args: Parameters<typeof originalReaddir>) => {
      const entries = await originalReaddir(...args);
      return entries.map((entry) =>
        path.join(String(args[0]), String(entry.name)) === linked
          ? new Proxy(entry, {
              get(target, key) {
                if (key === "isSymbolicLink") return () => true;
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            })
          : entry,
      );
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mockedReaddir.mock.restore();
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual((await observe()).structureDependencies, ["src/out/"]);
  linked = path.join(root, "src/core/card-main.ts");
  await assert.rejects(observe(), /Symbolic links/);
});

test("partial Go package targets are unavailable and complete internal packages are ignored", () => {
  const files = ["pkg/card-main.go", "pkg/card-member.go", "pkg/sibling.go", "outside/main.go"];
  const edge = {
    from: "pkg/card-main.go",
    to: "pkg",
    kind: "directory" as const,
    specifier: "example/pkg",
    execution: "module-load" as const,
  };
  assert.throws(
    () =>
      externalStructureDependencies(
        { kind: "prefix", prefix: "pkg/card-" },
        [edge],
        files,
        new Set(files.filter((file) => file.startsWith("pkg/card-"))),
      ),
    /partly covered/,
  );
  assert.deepEqual(
    externalStructureDependencies(
      { kind: "directory", prefix: "pkg/" },
      [edge],
      files,
      new Set(files.filter((file) => file.startsWith("pkg/"))),
    ),
    [],
  );
});

test("canonical dependencies validate sorted unique targets and bounded added/deleted reports", () => {
  assert.equal(
    structureDependenciesSchema.safeParse(["./", "src/core/file.ts", "src/out/"]).success,
    true,
  );
  for (const dependencies of [
    ["../escape/"],
    ["src\\bad/"],
    ["src//bad/"],
    ["z/", "a/"],
    ["a/", "a/"],
  ])
    assert.equal(structureDependenciesSchema.safeParse(dependencies).success, false);
  assert.equal(structureFingerprint(["b/", "a/", "b/"]), structureFingerprint(["a/", "b/"]));
  const changed = changedStructureDependencies(
    [],
    Array.from({ length: 23 }, (_, i) => `src/${String(i).padStart(2, "0")}/`),
  );
  assert.equal(changed.changedDependencies.length, 20);
  assert.equal(changed.changedDependenciesOverflow, 3);
});

test("Node union excludes complete Go packages without mixing other sources' outgoing edges", () => {
  const coverage = { kind: "prefix" as const, prefix: "pkg/card-" };
  const files = ["pkg/card-main.go", "pkg/role-main.go", "outside/api.go"];
  const members = new Set(["pkg/card-main.go", "pkg/role-main.go"]);
  assert.deepEqual(
    externalStructureDependencies(
      coverage,
      [
        {
          from: "pkg/card-main.go",
          to: "pkg",
          kind: "directory",
          specifier: "example/pkg",
          execution: "module-load" as const,
        },
        {
          from: "pkg/role-main.go",
          to: "outside",
          kind: "directory",
          specifier: "example/outside",
          execution: "module-load" as const,
        },
      ],
      files,
      members,
    ),
    [],
  );
  assert.throws(
    () =>
      externalStructureDependencies(
        coverage,
        [
          {
            from: "pkg/card-main.go",
            to: "pkg",
            kind: "directory",
            specifier: "example/pkg",
            execution: "module-load" as const,
          },
        ],
        [...files, "pkg/nonmember.go"],
        members,
      ),
    /partly covered/,
  );
});
