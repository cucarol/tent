import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { observeMaterialResource, observeSourceFile } from "../src/fs/source-observation.js";
import { pathToFileURL } from "node:url";
import { runNodeCommand } from "../src/cli/node-commands.js";
import { markdownMaterialHeading } from "../src/core/material-section.js";
import { materialLocator } from "../src/core/material.js";
import { NodeSectionError } from "../src/core/node-lightwrite.js";

test("material checks observe generic bytes while software/format adapters have no public entry", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "material-boundary-"));
  const materialRoot = path.join(root, "materials");
  await fs.mkdir(materialRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(
    (await runNodeCommand("read-image", ["node-test", "--workspace", root])).exitCode,
    1,
  );
  const bytes = Buffer.alloc(150_001, 255);
  const filename = path.join(materialRoot, "opaque.pen");
  await fs.writeFile(filename, bytes);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const observation = await observeSourceFile(materialRoot, filename);
  assert.deepEqual(observation, {
    canonicalPath: await fs.realpath(filename),
    observedVersion: expected,
    cacheHit: false,
    blobs: {
      sha1: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      sha256: createHash("sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    },
  });
  assert.deepEqual(
    await observeMaterialResource(root, "Node/Node.md", "../../materials/opaque.pen"),
    observation,
  );
  assert.deepEqual(
    await observeMaterialResource(materialRoot, "Node/Node.md", pathToFileURL(filename).href),
    observation,
  );
  for (const resource of [
    "materials/opaque.pen",
    "user interviews",
    "https://example.invalid/a",
    "data:text/plain,bytes",
  ]) {
    await assert.rejects(observeMaterialResource(root, "Node/Node.md", resource), /explicit local/);
  }
  await assert.rejects(
    observeMaterialResource(root, "Node/Node.md", "../../../outside.txt"),
    /absolute URI/,
  );
  assert.deepEqual(await fs.readFile(filename), bytes);
  await fs.writeFile(filename, Buffer.alloc(0));
  assert.notEqual((await observeSourceFile(materialRoot, filename)).observedVersion, expected);
  await assert.rejects(
    observeSourceFile(materialRoot, path.join(root, "outside.txt")),
    /escapes root/,
  );
  await assert.rejects(observeSourceFile(materialRoot, path.join(materialRoot, "missing")), {
    code: "ENOENT",
  });
  const other = path.join(root, "other");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "value"), bytes);
  await fs.symlink(other, path.join(materialRoot, "linked"), "junction");
  await assert.rejects(
    observeSourceFile(materialRoot, path.join(materialRoot, "linked/value")),
    /Symbolic/,
  );
});

test("Markdown materials select literal headings, nested sections and Setext through the shared AST", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "material-section-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "materials"));
  const filename = path.join(root, "materials", "设计.MARKDOWN");
  const section =
    "## **状态**\n\n当前内容。\n\n### 子节\n\n子节内容。\n\n```md\n## 假标题\n```\n\n";
  const setext = "资料\n====\n\nSetext 内容。\n\n";
  const raw =
    "---\nlabel: 状态\ntext: |\n  ## 状态\n---\n# 设计\n\n" +
    section +
    "## 其他\n\n其他内容。\n\n" +
    setext +
    "# 尾部\n\n结束。\n";
  await fs.writeFile(filename, raw);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const observe = (fragment: string) =>
    observeMaterialResource(root, "Node/Node.md", "../../materials/设计.MARKDOWN" + fragment);
  assert.equal((await observe("#状态")).observedVersion, digest(section));
  assert.equal((await observe("#%20%E7%8A%B6%E6%80%81%20")).observedVersion, digest(section));
  assert.equal((await observe("?mode=read#状态")).observedVersion, digest(section));
  assert.equal((await observe("#资料")).observedVersion, digest(setext));
  assert.equal(
    (await observeMaterialResource(root, "Node/Node.md", pathToFileURL(filename).href + "#状态"))
      .observedVersion,
    digest(section),
  );
  for (const heading of ["假标题", "state", "label: 状态", "缺失"])
    await assert.rejects(observe("#" + heading), (error: unknown) => {
      assert.ok(error instanceof NodeSectionError);
      assert.equal(error.code, "SECTION_NOT_FOUND");
      return true;
    });
  await fs.writeFile(filename, raw + "\n## 状态\n\n重复。\n");
  await assert.rejects(observe("#状态"), (error: unknown) => {
    assert.ok(error instanceof NodeSectionError);
    assert.equal(error.code, "SECTION_AMBIGUOUS");
    return true;
  });
  await fs.writeFile(filename, "# %E7%8A%B6%E6%80%81\n\n字面值。\n");
  assert.equal(
    (await observe("#%25E7%258A%25B6%25E6%2580%2581")).observedVersion,
    digest("# %E7%8A%B6%E6%80%81\n\n字面值。\n"),
  );
  await assert.rejects(observe("#状态"), /not found/);
  await fs.writeFile(filename, "---\ninvalid: [\n---\n## 状态\n");
  await assert.rejects(observe("#状态"), /frontmatter|YAML/i);
});

test("material cache isolates full files and headings while other-section edits leave versions current", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "material-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "design.md");
  const cacheDir = path.join(root, "cache");
  const a = "## A\n\nA 内容。\n\n";
  const b = "## B\n\nB 内容。\n";
  await fs.writeFile(filename, a + b);
  const uri = pathToFileURL(filename).href;
  const observe = (suffix: string) =>
    observeMaterialResource(root, "Node/Node.md", uri + suffix, cacheDir);
  const first = await observe("#A"),
    second = await observe("#B"),
    full = await observe("");
  assert.notEqual(first.observedVersion, second.observedVersion);
  assert.notEqual(first.observedVersion, full.observedVersion);
  for (const suffix of ["#A", "#B", "", "#", "#%20"])
    assert.equal((await observe(suffix)).cacheHit, true);
  assert.equal((await fs.readdir(cacheDir)).length, 3);
  await fs.writeFile(filename, a + "## B\n\nB 增加了新内容。\n");
  assert.equal((await observe("#A")).observedVersion, first.observedVersion);
  assert.equal((await observe("#A")).cacheHit, true);
  assert.notEqual((await observe("#B")).observedVersion, second.observedVersion);
  assert.notEqual((await observe("")).observedVersion, full.observedVersion);
  await fs.writeFile(filename, "## B\n\nA 标题已移除。\n");
  await assert.rejects(observe("#A"), /not found/);
  await assert.rejects(observe("#A"), /not found/);
});

test("non-Markdown fragments and absent Markdown fragments retain exact whole-file observation", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "material-whole-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([255, 0, 35, 32, 65, 10]);
  for (const name of ["opaque.txt", "design.md"]) {
    const filename = path.join(root, name);
    await fs.writeFile(filename, bytes);
    const uri = pathToFileURL(filename).href;
    const suffixes = name.endsWith(".md") ? ["", "#", "#%20"] : ["", "#A", "#%"];
    for (const suffix of suffixes)
      assert.equal(
        (await observeMaterialResource(root, "Node/Node.md", uri + suffix)).observedVersion,
        createHash("sha256").update(bytes).digest("hex"),
      );
  }
  assert.equal(
    markdownMaterialHeading(materialLocator("https://example.invalid/design.md#A", "Node/Node.md")),
    undefined,
  );
  assert.equal(
    markdownMaterialHeading(materialLocator("./design.md#%20状态%20", "Node/Node.md")),
    "状态",
  );
  const malformed = Buffer.concat([Buffer.from("## A\n\n"), Buffer.from([255])]);
  const filename = path.join(root, "design.md");
  await fs.writeFile(filename, malformed);
  await assert.rejects(
    observeMaterialResource(root, "Node/Node.md", pathToFileURL(filename).href + "#A"),
    /encoding utf-8/,
  );
  assert.equal(
    (await observeMaterialResource(root, "Node/Node.md", pathToFileURL(filename).href))
      .observedVersion,
    createHash("sha256").update(malformed).digest("hex"),
  );
});
