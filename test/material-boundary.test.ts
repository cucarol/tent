import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { observeMaterialResource, observeSourceFile } from "../src/fs/source-observation.js";
import { pathToFileURL } from "node:url";
import { runNodeCommand } from "../src/cli/node-commands.js";

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
