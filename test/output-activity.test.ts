import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readOutputActivity } from "../src/core/card-progress.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "output-activity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new NodeFs(root);
  return {
    adapter,
    write: (fields: Record<string, unknown>) =>
      adapter.writeFile(
        "Out/Out.md",
        serializeFrontmatter({ id: "node-out", type: "output", ...fields }, "result"),
      ),
  };
}

test("output activity uses latest declared generated or verified time without Git replay", async (t) => {
  const { adapter, write } = await fixture(t);
  await write({ generated: { by: "process:test", at: "2026-01-01T00:00:00Z" } });
  assert.equal((await readOutputActivity(adapter)).get("node-out"), "2026-01-01T00:00:00.000Z");
  await write({
    generated: { by: "process:test", at: "2026-01-03T00:00:00Z" },
    verified: [
      { by: "human:cuca", at: "2026-01-04T02:00:00+08:00" },
      { by: "process:test", at: "2026-01-02T00:00:00Z" },
    ],
  });
  assert.equal((await readOutputActivity(adapter)).get("node-out"), "2026-01-03T18:00:00.000Z");
  await write({ verified: { by: "human:cuca", at: "2026-01-05T00:00:00Z" } });
  assert.equal((await readOutputActivity(adapter)).get("node-out"), "2026-01-05T00:00:00.000Z");
});

test("outputs without valid declared time provide no completion timestamp", async (t) => {
  const { adapter, write } = await fixture(t);
  for (const fields of [
    {},
    { generated: { by: "process:test" } },
    { generated: { at: "yesterday" } },
  ]) {
    await write(fields);
    assert.deepEqual(await readOutputActivity(adapter), new Map());
  }
});

test("activity excludes deprecated outputs and non-output Nodes", async (t) => {
  const { adapter, write } = await fixture(t);
  const generated = { by: "process:test", at: "2026-01-01T00:00:00Z" };
  await write({ generated, status: "deprecated" });
  assert.deepEqual(await readOutputActivity(adapter), new Map());
  await write({ generated, type: "prompt" });
  assert.deepEqual(await readOutputActivity(adapter), new Map());
});
