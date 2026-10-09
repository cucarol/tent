import { readNodeForEdit } from "../src/core/node-query.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { createNode, moveNode, renameNode } from "../src/core/ops.js";
import { scaffoldTent, scaffoldInWorkspace } from "../src/core/scaffold.js";
import { nodeNotePath } from "../src/core/tree.js";
import { NodeFs } from "../src/fs/node-fs.js";

const metadata = [
  "# preserved document comment",
  "id: node-aaaaaa",
  "type: prompt",
  "tags: [alpha] # tag comment",
  "generated:",
  "  by: agent # author comment",
  "  at: 2026-09-08T01:02:03Z",
  "verified:",
  "  by: human",
  "  at: null",
  "sources:",
  "  - resource: https://example.com/a#section",
  "    uri: https://example.com/a#section",
  "    details:",
  "      count: 3",
  "      enabled: false",
  "      labels: [one, '02', null]",
  "literal: |",
  "  first line",
  "  第二行 # literal",
  "folded: >-",
  "  one",
  "  two",
  "custom: {empty: {}, list: [], '123': '0042'}",
].join("\n");

test("nested YAML preserves values, comments, BOM, CRLF, and exact body-only bytes", () => {
  const prefix = "\uFEFF---\r\n" + metadata.replace(/\n/g, "\r\n") + "\r\n---\r\n";
  const body = "\r\n# 正文\r\n\n```yaml\n---\n```\n";
  const parsed = parseFrontmatter(prefix + body);
  assert.equal(parsed.body, body);
  assert.deepEqual(parsed.data.generated, { by: "agent", at: "2026-09-08T01:02:03Z" });
  assert.deepEqual(parsed.data.verified, { by: "human", at: null });
  assert.equal(parsed.data.by, undefined);
  assert.equal(parsed.data.literal, "first line\n第二行 # literal\n");
  assert.equal(parsed.data.folded, "one two");
  assert.equal(serializeFrontmatter(parsed.data, body, parsed.keyOrder), prefix + body);
  assert.equal(
    serializeFrontmatter({ ...parsed.data }, "next\r\n", parsed.keyOrder),
    prefix + "next\r\n",
  );
  const result = serializeFrontmatter({ ...parsed.data, tags: ["beta"] }, body, parsed.keyOrder);
  assert.deepEqual(parseFrontmatter(result).data, { ...parsed.data, tags: ["beta"] });
  assert.equal(parseFrontmatter(result).body, body);
  for (const comment of ["preserved document comment", "tag comment", "author comment"]) {
    assert.ok(result.includes(comment));
  }
  assert.ok(result.startsWith("\uFEFF---\r\n"));
});

test("valid aliases survive unrelated edits; unsafe alias updates fail instead of losing data", () => {
  const parsed = parseFrontmatter("---\nbase: &base {n: 1}\ncopy: *base\n---\nbody");
  const result = serializeFrontmatter(
    { ...parsed.data, extra: true },
    parsed.body,
    parsed.keyOrder,
  );
  assert.deepEqual(parseFrontmatter(result).data, { base: { n: 1 }, copy: { n: 1 }, extra: true });
  assert.match(result, /&base/);
  assert.match(result, /\*base/);
  assert.throws(
    () => serializeFrontmatter({ ...parsed.data, base: { n: 2 } }, "", parsed.keyOrder),
    /Invalid frontmatter YAML/,
  );
});

test("malformed and unsupported YAML is rejected explicitly", () => {
  for (const yaml of [
    "x: 1\nx: 2",
    "outer: {x: 1, x: 2}",
    "- item",
    "scalar",
    "1: value",
    "? [a, b]\n: value",
    "x: !custom thing",
    "x: !!set {a: null}",
    "x: .nan",
    "x: .inf",
    "x: 9007199254740993",
    "x: &cycle [*cycle]",
    "x: *missing",
    "x: [unfinished",
    "x: {unfinished",
    'x: "unfinished',
  ]) {
    assert.throws(
      () => parseFrontmatter(`---\n${yaml}\n---\nbody`),
      /Invalid frontmatter YAML/,
      yaml,
    );
  }
  assert.throws(() => parseFrontmatter("---\nx: 1\n"), /unterminated frontmatter fence/);
  assert.deepEqual(parseFrontmatter("# plain\r\n"), {
    data: {},
    body: "# plain\r\n",
    keyOrder: [],
  });
  assert.deepEqual(parseFrontmatter("---\n---\n").data, {});
  assert.throws(
    () => parseFrontmatter("---\nx: 1\n---suffix\n---\nbody"),
    /Invalid frontmatter YAML/,
  );
});

test("special keys remain own data and unsupported JS values cannot be silently coerced", () => {
  const parsed = parseFrontmatter("---\n__proto__: {polluted: true}\nconstructor: false\n---\n");
  const result = serializeFrontmatter(parsed.data, "");
  assert.deepEqual(parseFrontmatter(result).data, parsed.data);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  for (const value of [NaN, Infinity, 1n, new Date(), new Map(), [undefined], () => 1]) {
    assert.throws(() => serializeFrontmatter({ value }, ""), /Invalid frontmatter YAML/);
  }
});

test("rename and move retain nested metadata and comments through real write paths", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, "tent-yaml-structure-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const systemFs = new NodeFs(dir);
  await scaffoldTent(systemFs, { name: "yaml" });
  const env = { fs: systemFs, clock: { now: () => "2026-09-10T00:00:00Z" }, tentName: "yaml" };
  const target = {
    nodeId: await createNode(env, { parentPath: "", name: "Alpha", type: "prompt" }),
    path: "Alpha",
  };
  const parent = {
    nodeId: await createNode(env, { parentPath: "", name: "Parent", type: "prompt" }),
    path: "Parent",
  };
  const watcher = {
    nodeId: await createNode(env, { parentPath: "", name: "Watcher", type: "prompt" }),
    path: "Watcher",
  };
  const prefix = `---\n${metadata.replace("node-aaaaaa", watcher.nodeId)}\n---\n`;
  await systemFs.writeFile(nodeNotePath(watcher.path), prefix + "[target](../Alpha/Alpha.md)\n");
  const renamed = await renameNode(env, target.nodeId, "Beta");
  assert.ok(renamed.rewrittenNotes.includes(watcher.path));
  assert.equal(
    await systemFs.readFile(nodeNotePath(watcher.path)),
    prefix + "[target](../Beta/Beta.md)\n",
  );
  const moved = await moveNode(env, target.nodeId, parent.nodeId, { mode: "inside" });
  assert.ok(moved.rewrittenNotes.includes(watcher.path));
  assert.equal(
    await systemFs.readFile(nodeNotePath(watcher.path)),
    prefix + "[target](../Parent/Beta/Beta.md)\n",
  );
});

test("Core and Docs edits retain unknown YAML and refuse invalid writes without changing disk", async (t) => {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, "tent-yaml-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const systemFs = new NodeFs(path.join(dir, ".tent"));
  await scaffoldInWorkspace(new NodeFs(dir), { name: "yaml" });
  const env = { fs: systemFs, clock: { now: () => "2026-09-10T00:00:00Z" }, tentName: "yaml" };
  const nodeId = await createNode(env, { parentPath: "", name: "Alpha", type: "prompt" });
  const created = { nodeId, path: "Alpha" };
  const raw = `---\n${metadata.replace("node-aaaaaa", created.nodeId)}\n---\noriginal\r\n`;
  const notePath = nodeNotePath(created.path);
  await systemFs.writeFile(notePath, raw);
  const expected = parseFrontmatter(raw).data;
  let snapshot = await readNodeForEdit(systemFs, created.nodeId);
  await writeNodeDocument(systemFs, created.nodeId, { baseEtag: snapshot.etag, body: "body\r\n" });
  const saved = parseFrontmatter(await systemFs.readFile(notePath));
  assert.equal(saved.body, "body\r\n");
  const assertSavedMetadata = (
    actual: Record<string, unknown>,
    expectedMetadata: Record<string, unknown>,
  ) => {
    const { generated, ...actualUnknown } = actual;
    const { generated: _old, ...expectedUnknown } = expectedMetadata;
    assert.deepEqual(actualUnknown, expectedUnknown);
    assert.match((generated as { by: string }).by, /^tent\//);
    assert.ok(Number.isFinite(Date.parse((generated as { at: string }).at)));
  };
  assertSavedMetadata(saved.data, expected);
  assert.notDeepEqual(saved.data.generated, expected.generated);
  assert.equal(saved.data.sync, undefined);
  assert.match(await systemFs.readFile(notePath), /# preserved document comment/);
  snapshot = await readNodeForEdit(systemFs, created.nodeId);
  await writeNodeDocument(systemFs, created.nodeId, {
    baseEtag: snapshot.etag,
    frontmatter: { extra: { array: [{ value: true }] } },
  });
  snapshot = await readNodeForEdit(systemFs, created.nodeId);
  assertSavedMetadata(snapshot.frontmatter, { ...expected, extra: { array: [{ value: true }] } });
  await writeNodeDocument(systemFs, created.nodeId, { baseEtag: snapshot.etag, body: "Docs\r\n" });
  snapshot = await readNodeForEdit(systemFs, created.nodeId);
  await writeNodeDocument(systemFs, created.nodeId, {
    baseEtag: snapshot.etag,
    frontmatter: { other: false },
  });
  snapshot = await readNodeForEdit(systemFs, created.nodeId);
  assertSavedMetadata(snapshot.frontmatter, {
    ...expected,
    extra: { array: [{ value: true }] },
    other: false,
  });
  assert.equal(snapshot.body, "Docs\r\n");
  await assert.rejects(
    writeNodeDocument(systemFs, created.nodeId, {
      baseEtag: snapshot.etag,
      raw: "---\nx: [broken\n---\n",
    }),
    /Invalid frontmatter YAML/,
  );
  assert.equal(await systemFs.readFile(notePath), snapshot.raw);
  await writeNodeDocument(systemFs, created.nodeId, {
    baseEtag: snapshot.etag,
    frontmatter: { owner: "someone" },
  });
  assert.equal((await readNodeForEdit(systemFs, created.nodeId)).frontmatter.owner, "someone");
});
