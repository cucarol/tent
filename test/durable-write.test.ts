import { openTestFs } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";

import { syncBuiltinESMExports } from "node:module";
import { NodeFs } from "../src/fs/node-fs.js";
import { durableReplace, syncDirectory } from "../src/fs/durable-file.js";

async function fixture(t: TestContext) {
  await fs.mkdir(path.resolve(testScratchRoot()), { recursive: true });
  const root = await fs.mkdtemp(path.resolve(testScratchRoot(), "durable-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return { root, adapter: openTestFs(root) };
}

function restoreBuiltins(t: TestContext) {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("writes into new nested directories complete, including Windows namespaced mkdir results", async (t) => {
  const { root, adapter } = await fixture(t);
  await adapter.writeFile("new/nested/document.md", "new directory bytes");
  assert.equal(
    await fs.readFile(path.join(root, "new/nested/document.md"), "utf8"),
    "new directory bytes",
  );
});

test("text and binary replacements sync prepared bytes before publication", async (t) => {
  const { root, adapter } = await fixture(t);
  const events: string[] = [];
  const open = fs.open,
    rename = fs.rename;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes(".tmp-")) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        events.push("sync");
        await sync();
      });
    }
    return handle;
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    events.push("rename");
    await rename(...args);
  });
  restoreBuiltins(t);
  await adapter.writeFile("text.md", "原文\n");
  await adapter.writeBinary("data.bin", Uint8Array.from([0, 255, 1, 128]));
  assert.deepEqual(events, ["sync", "rename", "sync", "rename"]);
  assert.equal(await fs.readFile(path.join(root, "text.md"), "utf8"), "原文\n");
  assert.deepEqual(await fs.readFile(path.join(root, "data.bin")), Buffer.from([0, 255, 1, 128]));
});

test("failed file sync rejects the save, keeps the original and removes the prepared file", async (t) => {
  const { root, adapter } = await fixture(t);
  await fs.writeFile(path.join(root, "keep.md"), "last complete bytes");
  const failure = Object.assign(new Error("injected flush failure"), { code: "EIO" });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes(".tmp-"))
      t.mock.method(handle, "sync", async () => {
        throw failure;
      });
    return handle;
  });
  restoreBuiltins(t);
  await assert.rejects(adapter.writeFile("keep.md", "new bytes"), (error) => error === failure);
  assert.equal(await fs.readFile(path.join(root, "keep.md"), "utf8"), "last complete bytes");
  assert.deepEqual(await fs.readdir(root), ["keep.md"]);
});

test("publication failure keeps the original and cleans up the synced temporary", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "keep.md");
  await fs.writeFile(file, "original");
  const failure = Object.assign(new Error("rename failed"), { code: "EIO" });
  t.mock.method(fs, "rename", async () => {
    throw failure;
  });
  restoreBuiltins(t);
  await assert.rejects(durableReplace(file, "replacement"), (error) => error === failure);
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.deepEqual(await fs.readdir(root), ["keep.md"]);
});

test(
  "POSIX directory sync errors are not hidden",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root } = await fixture(t);
    const failure = Object.assign(new Error("directory sync failed"), { code: "EIO" });
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      t.mock.method(handle, "sync", async () => {
        throw failure;
      });
      return handle;
    });
    restoreBuiltins(t);
    await assert.rejects(syncDirectory(root), (error) => error === failure);
  },
);
