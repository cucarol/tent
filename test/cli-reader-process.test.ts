import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { cli, git } from "./helpers.js";

test("separate CLI processes continue discovery, live and Git reads and diffs with checked cursor addresses", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "reader-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const body = "DATA😀\r\n".repeat(2300);
  await scaffoldInWorkspace(new NodeFs(root), {
    name: "process reader",
    nodes: [
      { id: "node-alpha", name: "A", type: "prompt", body },
      { id: "node-beta", name: "B", type: "prompt", body: "DATA peer" },
    ],
  });
  const tent = path.join(root, ".tent");
  await git(tent, "init");
  const run = (...args: string[]) => cli(root, "node", ...args, "--workspace", root, "--json");
  const read = async (...args: string[]) => {
    const result = await run(...args);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const reject = async (args: string[], pattern: RegExp) => {
    const result = await run(...args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  };
  for (const query of [
    ["list"],
    ["search", "DATA"],
    ["relations", "root", "--direction", "children"],
  ]) {
    const first = await read(...query, "--limit", "1");
    assert.ok(first.page.nextCursor);
    const second = await read(...query, "--limit", "1", "--cursor", first.page.nextCursor);
    assert.equal(second.items.length, 1);
    assert.notDeepEqual(second.items, first.items);
    assert.equal(second.page.hasMore, false);
  }
  const adapter = new NodeFs(tent);
  const raw = await fs.readFile(path.join(tent, "A/A.md"), "utf8");
  const firstVersion = (
    await adapter.history.captureUnlocked([{ path: "A/A.md", raw }], { operation: "test.fixture" })
  ).versions[0]!;
  const first = await read("get", "node-alpha");
  assert.ok(first.page.nextCursor);
  const collect = async (args: string[], firstPage: any) => {
    let text = firstPage.text,
      cursor = firstPage.page.nextCursor;
    while (cursor) {
      const result = await read(...args, "--cursor", cursor),
        page = result;
      assert.equal(page.range.start, text.length);
      text += page.text;
      cursor = page.page.nextCursor;
    }
    return text;
  };
  assert.equal(await collect(["get", "node-alpha"], first), body);
  const versionArgs = ["get", "node-alpha", "--version-json", JSON.stringify(firstVersion)];
  const historical = await read(...versionArgs);
  await fs.writeFile(path.join(tent, "A/A.md"), raw.replace(body, "NEW😀\r\n".repeat(2300)));
  await reject(["get", "node-alpha", "--cursor", first.page.nextCursor], /source changed/);
  assert.equal(await collect(versionArgs, historical), body);
  const current = await read("get", "node-alpha");
  await read("check", "node-alpha");
  const currentVersion = { commit: (await adapter.history.currentCommit())!, path: "A/A.md" };
  const diffArgs = [
    "diff",
    "--from-json",
    JSON.stringify(firstVersion),
    "--to-json",
    JSON.stringify(currentVersion),
  ];
  const diff = await read(...diffArgs);
  assert.ok(diff.page.nextCursor);
  assert.equal(
    await collect(diffArgs, diff),
    await new NodeFs(tent).history.diff(firstVersion, currentVersion),
  );
  await reject(
    ["get", "node-beta", "--cursor", current.page.nextCursor],
    /another source or query/,
  );
  const listing = await read("list", "--limit", "1");
  await reject(["search", "DATA", "--cursor", listing.page.nextCursor], /another source or query/);
  const cursor = JSON.parse(Buffer.from(listing.page.nextCursor, "base64url").toString());
  cursor.position = 999;
  await reject(
    ["list", "--cursor", Buffer.from(JSON.stringify(cursor)).toString("base64url")],
    /position is invalid/,
  );
  await fs.writeFile(
    path.join(tent, "B/B.md"),
    (await fs.readFile(path.join(tent, "B/B.md"), "utf8")).replace("type: prompt", "type: output"),
  );
  await reject(["list", "--cursor", listing.page.nextCursor], /source changed/);
});
