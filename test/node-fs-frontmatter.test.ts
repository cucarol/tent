import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";

test("NodeFs reads the exact frontmatter prefix across UTF-8 and fence boundaries", async () => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-fm-"));
  try {
    const adapter = new NodeFs(root);
    const cases = [
      [
        "bom.md",
        "\uFEFF---\r\ntitle: café\r\n--- \t\r\nBody",
        "\uFEFF---\r\ntitle: café\r\n--- \t\r\n",
      ],
      ["eof.md", "---\nname: value\n---", "---\nname: value\n---"],
      [
        "split.md",
        `---\nkey: ${"a".repeat(500)}\n---\nBody`,
        `---\nkey: ${"a".repeat(500)}\n---\n`,
      ],
      [
        "utf8.md",
        `---\nkey: \"${"a".repeat(501)}😀\"\n---\nBody`,
        `---\nkey: \"${"a".repeat(501)}😀\"\n---\n`,
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
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("NodeFs stops reading after the closing fence or a missing opening", async () => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "node-fm-bounded-"));
  const originalOpen = fsPromises.open;
  let readBytes = 0;
  try {
    const adapter = new NodeFs(root);
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
    assert.ok(readBytes > 0 && readBytes <= 512, `read ${readBytes} bytes for fenced document`);
    readBytes = 0;
    assert.equal(await adapter.readFrontmatter("plain.md"), "");
    assert.ok(readBytes > 0 && readBytes <= 512, `read ${readBytes} bytes for plain document`);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
