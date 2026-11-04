import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
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

test("known Node material paths expire after writes and native quarantine changes", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "node-material-scope-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  const adapter = openTestFs(path.join(root, ".tent"));
  const file = "Target/Target.md";
  const raw = "---\nid: node-target\ntype: prompt\n---\n## Part\ncurrent\n";
  await adapter.writeFile(file, raw);
  const observe = () => adapter.observeMaterial("../Target/Target.md#Part", "Owner/Owner.md");
  const options = { nodePaths: new Set([file]) };
  await adapter.observationScope(async () => {
    await observe();
    adapter.invalidNodeEdits = new Map([[file, "native identity edit rejected"]]);
    await assert.rejects(
      observe(),
      /Materials must point to Workspace files, or Node, Role, Card documents/,
    );
  }, options);
  adapter.invalidNodeEdits = undefined;
  await adapter.observationScope(async () => {
    await observe();
    await adapter.writeFile(file, raw.replace("node-target", "invalid"));
    await assert.rejects(
      observe(),
      /Materials must point to Workspace files, or Node, Role, Card documents/,
    );
  }, options);
  await assert.rejects(
    adapter.observationScope(observe),
    /Materials must point to Workspace files, or Node, Role, Card documents/,
  );
});
