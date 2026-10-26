import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { ReaderError } from "../src/core/graph/context-reader.js";
import { fileState, type FileState } from "../src/fs/file-state-cache.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { testScratchRoot } from "./scratch.js";

test("NodeFs reads the exact frontmatter prefix across UTF-8 and fence boundaries", async () => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-fm-"));
  try {
    const adapter = openTestFs(root);
    const cases = [
      [
        "bom.md",
        "\uFEFF---\r\ntitle: café\r\n--- \t\r\nBody",
        "\uFEFF---\r\ntitle: café\r\n--- \t\r\n",
      ],
      ["eof.md", "---\nname: value\n---", "---\nname: value\n---"],
      [
        "split.md",
        `---\nkey: ${"a".repeat(4084)}\n---\nBody`,
        `---\nkey: ${"a".repeat(4084)}\n---\n`,
      ],
      [
        "utf8.md",
        `---\nkey: \"${"a".repeat(4085)}😀\"\n---\nBody`,
        `---\nkey: \"${"a".repeat(4085)}😀\"\n---\n`,
      ],
      ["plain.md", "# No metadata\n---\nBody", ""],
      ["unfinished.md", "---\nkey: value\nNo closing fence", "---\nkey: value\nNo closing fence"],
    ] as const;
    for (const [name, raw, expected] of cases) {
      await fs.writeFile(path.join(root, name), raw);
      assert.equal(await adapter.readFrontmatter(name), expected, name);
    }
    assert.throws(() => parseFrontmatter(cases[5][1]), /unterminated frontmatter fence/);
    await assert.rejects(adapter.readFrontmatter("../outside.md"), /Path escapes Tent root/);
  } finally {
    await removeTestFixture(root, { recursive: true, force: true });
  }
});

test("NodeFs stops reading after the closing fence or a missing opening", async () => {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-fm-bounded-"));
  const originalOpen = fsPromises.open;
  let readBytes = 0;
  try {
    const adapter = openTestFs(root);
    const frontmatter = "---\nid: node-large\n---\n";
    await fs.writeFile(path.join(root, "front.md"), frontmatter + "x".repeat(4_000_000));
    await fs.writeFile(path.join(root, "plain.md"), "# Body\n" + "x".repeat(4_000_000));
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const originalRead = handle.read;
      Object.defineProperty(handle, "read", {
        value: async (...readArgs: unknown[]) => {
          const result = (await Reflect.apply(originalRead, handle, readArgs)) as {
            bytesRead: number;
          };
          readBytes += result.bytesRead;
          return result;
        },
      });
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    assert.equal(await adapter.readFrontmatter("front.md"), frontmatter);
    assert.ok(readBytes > 0 && readBytes <= 4096, `read ${readBytes} bytes for fenced document`);
    readBytes = 0;
    assert.equal(await adapter.readFrontmatter("plain.md"), "");
    assert.ok(readBytes > 0 && readBytes <= 4096, `read ${readBytes} bytes for plain document`);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await removeTestFixture(root, { recursive: true, force: true });
  }
});

test("a swapped directory cannot persist another handle's header under the restored file identity", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-header-identity-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const systemRoot = path.join(root, ".tent");
  await fs.mkdir(path.join(systemRoot, ".git"), { recursive: true });
  const original = path.join(systemRoot, "A"),
    replacement = path.join(root, "replacement"),
    saved = path.join(root, "saved");
  await fs.mkdir(original);
  await fs.mkdir(replacement);
  const filename = path.join(original, "A.md");
  const header = "---\nid: node-original\ntype: prompt\n---\n";
  const other = "---\nid: node-replaced\ntype: output\n---\n";
  await fs.writeFile(filename, header + "Original body\n");
  await fs.writeFile(path.join(replacement, "A.md"), other + "Another body\n");
  const old = new Date(Date.now() - 5_000);
  await fs.utimes(filename, old, old);
  const before = fileState(await fs.stat(filename, { bigint: true }));
  const open = fsPromises.open;
  let openedState: FileState | undefined;
  const mocked = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof open>) => {
    if (String(args[0]) !== filename || openedState) return open(...args);
    await fs.rename(original, saved);
    await fs.rename(replacement, original);
    const handle = await open(...args);
    openedState = fileState(await handle.stat({ bigint: true }));
    return new Proxy(handle, {
      get(target, key) {
        if (key === "close")
          return async () => {
            // Windows permits restoring the parent directory after its handle closes.
            await target.close();
            await fs.rename(original, replacement);
            await fs.rename(saved, original);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  syncBuiltinESMExports();
  let failure: unknown;
  try {
    await openTestFs(systemRoot)
      .readFrontmatter("A/A.md")
      .catch((error) => {
        failure = error;
      });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(openedState);
  assert.notEqual(openedState.ino, before.ino, "the bytes came from a distinct real inode");
  assert.deepEqual(
    fileState(await fs.stat(filename, { bigint: true })),
    before,
    "the original leaf state genuinely remains unchanged",
  );
  assert.equal(
    await openTestFs(systemRoot).readFrontmatter("A/A.md"),
    header,
    "an independent request must never reuse the other file's header",
  );
  const current = (await loadNodeCatalog(openTestFs(systemRoot))).byPath.get("A");
  assert.equal(current?.nodeId, "node-original");
  assert.equal(current?.type, "prompt");
  assert.ok(failure instanceof ReaderError);
  assert.equal(failure.code, "SOURCE_CHANGED");
  assert.match(failure.message, /Source changed while reading header/);
});
