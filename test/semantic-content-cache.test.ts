import { removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { withPersistedSemanticContent } from "../src/fs/semantic-content-cache.js";
import { cachedSemanticContent } from "../src/core/base/semantic-content-cache.js";
import { testScratchRoot } from "./scratch.js";

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
