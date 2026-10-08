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

test("output activity uses earliest valid declared generated or verified time without Git replay", async (t) => {
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
  assert.equal((await readOutputActivity(adapter)).get("node-out"), "2026-01-02T00:00:00.000Z");
  await write({
    generated: { by: "process:test", at: "invalid" },
    verified: { by: "human:cuca", at: "2026-01-05T00:00:00Z" },
  });
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

test("activity excludes deprecated outputs, invalid types and non-output Nodes", async (t) => {
  const { adapter, write } = await fixture(t);
  const generated = { by: "process:test", at: "2026-01-01T00:00:00Z" };
  await write({ generated, status: "deprecated" });
  assert.deepEqual(await readOutputActivity(adapter), new Map());
  await write({ generated, type: "prompt" });
  assert.deepEqual(await readOutputActivity(adapter), new Map());
  await write({ generated, type: "output-evidence" });
  assert.deepEqual(await readOutputActivity(adapter), new Map(), "former labels are invalid");
});

test("every current output has activity, whatever its tags", async (t) => {
  const { adapter, write } = await fixture(t);
  const generated = { by: "process:test", at: "2026-01-01T00:00:00Z" };
  for (const tags of [[], ["issue"], ["analysis"], ["custom"], ["asset", "evidence"]]) {
    await write({ generated, ...(tags.length ? { tags } : {}) });
    assert.equal(
      (await readOutputActivity(adapter)).get("node-out"),
      "2026-01-01T00:00:00.000Z",
      tags.join(","),
    );
  }
});

test("completion reads current provenance across confirmation, rewrite and imported-output boundaries", async (t) => {
  const { adapter, write } = await fixture(t);
  const generated = { by: "process:test", at: "2026-01-01T00:00:00Z" };
  for (const at of ["2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"]) {
    await write({ generated, verified: [{ by: "human:cuca", at }] });
    assert.equal((await readOutputActivity(adapter)).get("node-out"), "2026-01-01T00:00:00.000Z");
  }
  await write({
    generated: { ...generated, at: "2026-01-05T00:00:00Z" },
    verified: [{ by: "human:cuca", at: "2026-01-03T00:00:00Z" }],
  });
  assert.equal((await readOutputActivity(adapter)).get("node-out"), "2026-01-03T00:00:00.000Z");
  await write({ generated: { ...generated, at: "2026-01-05T00:00:00Z" } });
  assert.equal((await readOutputActivity(adapter)).get("node-out"), "2026-01-05T00:00:00.000Z");
  for (const at of ["2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"]) {
    await write({ verified: [{ by: "human:cuca", at }] });
    assert.equal((await readOutputActivity(adapter)).get("node-out"), at.replace("Z", ".000Z"));
  }
});
