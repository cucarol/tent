import { removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { nodeSemanticContent } from "../src/core/graph/node-sync-record.js";
import { withPersistedSemanticContent } from "../src/fs/semantic-content-cache.js";
import {
  withSemanticContentCache,
  cachedSemanticContent,
} from "../src/core/base/semantic-content-cache.js";
import { testScratchRoot } from "./scratch.js";

test("semantic cache preserves live Node identities, source ordering, tracks, paths and body", async () => {
  const nodes = new Map([
    ["node-first", { nodeId: "node-first", path: "Target" }],
    ["node-second", { nodeId: "node-second", path: "Other" }],
  ]);
  const data = { sources: [{ resource: "../Target/Target.md" }] };
  const body = "[target](../Target/Target.md)\r\n";
  const examples = [
    [data, body, "Owner/Owner.md", "/workspace"],
    [data, body + "changed", "Owner/Owner.md", "/workspace"],
    [data, body, "Else/Nested/Owner.md", "/workspace"],
    [
      { sources: [{ resource: "../Other/Other.md" }, ...data.sources] },
      body,
      "Owner/Owner.md",
      "/workspace",
    ],
    [
      { sources: [...data.sources, { resource: "../Other/Other.md" }] },
      body,
      "Owner/Owner.md",
      "/workspace",
    ],
    [
      { sources: [{ resource: "../Target/Target.md", track: "structure" }] },
      body,
      "Owner/Owner.md",
      "/workspace",
    ],
    [
      { sources: [{ resource: "file:///workspace/.tent/cards/card-example.md" }] },
      body,
      "Owner/Owner.md",
      "/workspace",
    ],
    [
      { sources: [{ resource: "file:///workspace/.tent/cards/card-example.md" }] },
      body,
      "Owner/Owner.md",
      "/other",
    ],
  ] as const;
  const direct = () =>
    examples.map(([data, body, document, root]) =>
      nodeSemanticContent(data, body, document, nodes, root),
    );
  const expected = direct();
  const first = await withSemanticContentCache(new Map(), async () => direct());
  assert.deepEqual(first.result, expected);
  const warm = await withSemanticContentCache(first.used, async () => direct());
  assert.deepEqual(warm.result, expected);
  await withSemanticContentCache(first.used, async () => {
    assert.deepEqual(direct(), expected);
    nodes.get("node-first")!.nodeId = "node-replacement";
    assert.match(direct()[0]!, /node-replacement/);
    nodes.get("node-first")!.path = "Gone";
    assert.doesNotMatch(direct()[0]!, /node-replacement/);
    nodes.set("node-new", { nodeId: "node-new", path: "Target" });
    assert.match(direct()[0]!, /node-new/);
    nodes.delete("node-new");
    assert.doesNotMatch(direct()[0]!, /node-new/);
  });
});

test("persisted semantics survive new scopes and reject damaged or obsolete cache bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "semantic-content-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await fs.mkdir(path.join(root, ".git"));
  const file = path.join(root, ".git/tent-material-cache/semantic-content.bin");
  let computed = 0;
  const read = () =>
    withPersistedSemanticContent(root, async () =>
      cachedSemanticContent(
        () => ["input"],
        () => {
          computed++;
          return "canonical";
        },
      ),
    );
  assert.equal(await read(), "canonical");
  assert.equal(computed, 1);
  const saved = await fs.readFile(file);
  assert.equal(await read(), "canonical");
  assert.equal(computed, 1);
  assert.deepEqual(await fs.readFile(file), saved);
  await fs.writeFile(file, Buffer.from("damaged"));
  assert.equal(await read(), "canonical");
  assert.equal(computed, 2);
  const payload = serialize({ version: 0, entries: new Map() });
  await fs.writeFile(file, Buffer.concat([createHash("sha256").update(payload).digest(), payload]));
  assert.equal(await read(), "canonical");
  assert.equal(computed, 3);
  await fs.rm(file);
  await fs.mkdir(file);
  assert.equal(await read(), "canonical", "unwritable cache cannot fail a read");
  assert.equal(computed, 4);
});
