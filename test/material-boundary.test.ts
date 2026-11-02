import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { observeMaterialResource, readSourceFile } from "../src/fs/source-observation.js";
import { removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";

test("material checks validate binary files and reject escaped or symbolic paths without a comparison basis", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "material-boundary-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const directory = path.join(root, "materials");
  await fs.mkdir(directory);
  const filename = path.join(directory, "opaque.pen");
  const bytes = Buffer.alloc(150001, 255);
  await fs.writeFile(filename, bytes);
  assert.deepEqual((await readSourceFile(root, filename)).bytes, bytes);
  const expected = { canonicalPath: await fs.realpath(filename) };
  assert.deepEqual(
    await observeMaterialResource(root, "Node/Node.md", "../../materials/opaque.pen"),
    expected,
  );
  assert.deepEqual(
    await observeMaterialResource(root, "Node/Node.md", pathToFileURL(filename).href),
    expected,
  );
  for (const resource of [
    "materials/opaque.pen",
    "user interviews",
    "https://example.invalid/a",
    "data:text/plain,bytes",
  ])
    await assert.rejects(observeMaterialResource(root, "Node/Node.md", resource), /explicit local/);
  await assert.rejects(
    observeMaterialResource(root, "Node/Node.md", "../../../outside.txt"),
    /absolute URI/,
  );
  await assert.rejects(readSourceFile(directory, path.join(root, "outside.txt")), /escapes/);
  await assert.rejects(readSourceFile(directory, path.join(directory, "missing")), {
    code: "ENOENT",
  });
  await fs.symlink(directory, path.join(root, "linked"), "junction");
  await assert.rejects(
    readSourceFile(root, path.join(root, "linked/opaque.pen")),
    /Symbolic links/,
  );
  assert.deepEqual(await fs.readFile(filename), bytes);
});

test("material checks keep literal, nested and Setext heading validation with no material fingerprint", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "material-heading-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const filename = path.join(root, "design.MARKDOWN");
  await fs.writeFile(
    filename,
    "# Design\n\n## 状态\n\n正文\n\n### Nested\n\nchild\n\n资料\n====\n\nSetext\n",
  );
  const observe = (fragment: string) =>
    observeMaterialResource(root, "Node/Node.md", pathToFileURL(filename).href + fragment);
  for (const heading of ["#状态", "#%20%E7%8A%B6%E6%80%81%20", "#Nested", "#资料"])
    assert.deepEqual(await observe(heading), { canonicalPath: await fs.realpath(filename) });
  await assert.rejects(observe("#missing"), /not found/);
  await fs.writeFile(filename, "## 状态\n\nfirst\n\n## 状态\n\nsecond\n");
  await assert.rejects(observe("#状态"), /duplicated/i);
  await fs.writeFile(filename, "# Changed\n");
  await assert.rejects(observe("#状态"), /not found/);
  await observe("");
});
