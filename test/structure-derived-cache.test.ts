import { removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { test, type TestContext } from "node:test";
import {
  observeStructureMaterial,
  withStructureSnapshot,
} from "../src/fs/structure-observation.js";
import { testScratchRoot } from "./scratch.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "structure-derived-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const write = async (file: string, content: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  };
  await write(".gitignore", ".tent/\n");
  await write("src/a/main.ts", 'import "../shared/api.js";\n');
  await write("src/b/main.ts", 'import "../shared/api.js";\n');
  await write("src/shared/api.ts", "export const api = true;\n");
  await git(root, "init", "--quiet");
  await git(root, "add", ".");
  const directory = path.join(root, ".tent", ".git", "tent-material-cache");
  const file = path.join(directory, "structure-derived.bin");
  const observe = (resource = "../../src/a/", cached = true, union = [resource]) =>
    observeStructureMaterial(
      root,
      "Module/Module.md",
      resource,
      cached ? directory : undefined,
      union,
    );
  const read = async () => deserialize((await fs.readFile(file)).subarray(32));
  return { root, write, observe, directory, file, read };
}

test("structure derivations reuse exact validated inputs and invalidate only changed source content", async (t) => {
  const { observe, write, file, read } = await fixture(t);
  const direct = await observe(undefined, false);
  assert.deepEqual(await observe(), direct);
  await observe("../../src/b/");
  const before = await read();
  const entriesBefore = [...before.entries.values()] as Array<{ base: string }>;
  assert.equal(entriesBefore.length, 2);
  const stat = await fs.stat(file);
  const bytes = await fs.readFile(file);
  assert.deepEqual(await observe(), direct);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.deepEqual(await fs.readFile(file), bytes);
  await write("src/a/main.ts", 'import "../b/main.js";\n');
  const changed = await observe();
  assert.deepEqual(changed, await observe(undefined, false));
  assert.deepEqual(changed.structureDependencies, ["src/b/"]);
  await observe("../../src/b/");
  const after = await read();
  assert.equal(
    [...before.entries].filter(
      ([key, entry]) => JSON.stringify(after.entries.get(key)) === JSON.stringify(entry),
    ).length,
    1,
    "the unchanged sibling keeps its derived entry",
  );
  const union = ["../../src/a/", "../../src/b/"];
  assert.deepEqual((await observe(undefined, true, union)).structureDependencies, []);
  assert.deepEqual(await observe(undefined, true, union), await observe(undefined, false, union));
});

test("shared structure membership preserves overlapping union order and resets between reads", async (t) => {
  const { observe, write } = await fixture(t);
  const queries = [
    ["../../src/a/", ["../../src/a/", "../../src/b/"]],
    ["../../src/b/", ["../../src/b/", "../../src/a/"]],
    ["../../src/a/", ["../../src/a/", "../../src/shared/"]],
  ] as const;
  const direct = await Promise.all(
    queries.map(([resource, union]) => observe(resource, false, [...union])),
  );
  const read = () =>
    withStructureSnapshot(async () => {
      const results = [];
      for (const [resource, union] of queries)
        results.push(await observe(resource, true, [...union]));
      return results;
    });
  assert.deepEqual(await read(), direct);
  assert.deepEqual(await read(), direct);
  await write("src/a/main.ts", 'import "../b/main.js";\n');
  const changed = await read();
  assert.notDeepEqual(changed, direct);
  assert.deepEqual(
    changed,
    await Promise.all(queries.map(([resource, union]) => observe(resource, false, [...union]))),
  );
});

test("available paths, live membership and config versions invalidate structure derivations", async (t) => {
  const { root, observe, write } = await fixture(t);
  await write("src/a/main.ts", 'import "./extra.js";\n');
  await write("src/a/extra.ts", "export const extra = true;\n");
  await git(root, "add", ".");
  const union = ["../../src/a/main*", "../../src/a/extra*"];
  assert.deepEqual((await observe(union[0], true, union)).structureDependencies, []);
  await write(".gitignore", ".tent/\nsrc/a/extra.ts\n");
  const ignored = await observe(union[0], true, union);
  assert.deepEqual(ignored, await observe(union[0], false, union));
  assert.deepEqual(ignored.structureDependencies, ["src/a/extra.ts"]);
  await write(".gitignore", ".tent/\n");
  await write("tsconfig.json", '{"compilerOptions":{"paths":{"@api":["src/shared/api.ts"]}}}');
  await write("src/a/main.ts", 'import "@api";\n');
  const configured = await observe();
  assert.deepEqual(configured, await observe(undefined, false));
  assert.deepEqual(configured.structureDependencies, ["src/shared/"]);
  await write("tsconfig.json", '{"compilerOptions":{"paths":{"@api":["src/b/main.ts"]}}}');
  assert.deepEqual((await observe()).structureDependencies, ["src/b/"]);
  await write("tsconfig.json", "{invalid");
  await assert.rejects(observe(), /Structure unavailable/);
});

test("supporting Rust files remain live cache inputs and removed requirements stop being read", async (t) => {
  const { root, observe, write, read } = await fixture(t);
  await write("Cargo.toml", '[package]\nname="sample"\nedition="2021"\n');
  await write("src/lib.rs", "pub mod api; pub mod consumer;");
  await write("src/api.rs", "pub struct Api;");
  await write("src/consumer/mod.rs", "use crate::api::Api;");
  await git(root, "add", ".");
  const resource = "../../src/consumer/";
  const initial = await observe(resource);
  assert.deepEqual(initial, await observe(resource, false));
  assert.ok(
    [...(await read()).entries.values()].some((entry: { additional: Array<[string, string]> }) =>
      entry.additional.some(([file]) => file === "src/api.rs"),
    ),
  );
  await write("src/api.rs", "pub struct Different;");
  await assert.rejects(observe(resource), /Structure unavailable/);
  await write("src/api.rs", "pub struct Api;");
  assert.deepEqual(await observe(resource), initial);
  await write("src/consumer/mod.rs", "pub fn own() {}");
  await write("src/api.rs", Buffer.from([0xff, 0xfe]));
  const noUse = await observe(resource);
  assert.deepEqual(noUse, await observe(resource, false));
  assert.deepEqual(noUse.structureDependencies, []);
});

test("bad, missing or incompatible structure caches fall back exactly and cannot introduce read paths", async (t) => {
  const { observe, file, read, directory } = await fixture(t);
  const expected = await observe(undefined, false);
  assert.deepEqual(await observe(), expected);
  const original = await read();
  const writeEnvelope = async (value: unknown) => {
    const payload = serialize(value);
    await fs.writeFile(
      file,
      Buffer.concat([createHash("sha256").update(payload).digest(), payload]),
    );
  };
  const invalidInput = structuredClone(original);
  [...invalidInput.entries.values()][0].additional = [["../../outside.ts", "a".repeat(64)]];
  for (const saved of [
    { ...original, version: -1 },
    { version: 1, entries: new Map([["bad-key", {}]]) },
    invalidInput,
    null,
  ]) {
    await writeEnvelope(saved);
    assert.deepEqual(await observe(), expected);
  }
  await fs.writeFile(file, "broken");
  assert.deepEqual(await observe(), expected);
  await fs.rm(file);
  assert.deepEqual(await observe(), expected);
  await fs.rm(file);
  await fs.mkdir(file);
  assert.deepEqual(await observe(), expected);
  assert.ok(!(await fs.readdir(directory)).some((name) => name.endsWith(".tmp")));
});
