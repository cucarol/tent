import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { selectedContextReader } from "../src/core/context-reader-factory.js";
import { loadNodeCatalog } from "../src/core/node-catalog.js";
import { contentEtag } from "../src/core/etag.js";
import { ReaderError } from "../src/core/context-reader.js";

const source = { kind: "live" as const, workspaceId: "ws-selected" };
const raw = (id: string, body = "正文", metadata = "") =>
  `\uFEFF---\r\nid: ${id}\r\ntype: prompt\r\n${metadata}---\r\n${body}`;
async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "selected-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new NodeFs(root);
  return { root, adapter };
}
const error = (code: string) => (e: unknown) => e instanceof ReaderError && e.code === code;

test("selected reads load exactly the requested bodies at 10, 100 and 500 Nodes", async (t) => {
  const { adapter } = await fixture(t);
  const read = adapter.readFile.bind(adapter),
    reads: string[] = [];
  adapter.readFile = async (file) => {
    reads.push(file);
    return read(file);
  };
  let created = 0;
  for (const size of [10, 100, 500]) {
    for (; created < size; created++) {
      const name = `N${created.toString().padStart(3, "0")}`;
      await adapter.writeFile(
        `${name}/${name}.md`,
        raw(`node-scale${created}`, "😀body\r\n".repeat(8192)),
      );
    }
    reads.length = 0;
    const reader = await selectedContextReader(adapter, source, [
      "node-scale0",
      "node-scale1",
      "node-scale0",
    ]);
    assert.deepEqual(reads, ["N000/N000.md", "N001/N001.md"]);
    const page = reader.read({ nodeId: "node-scale0" });
    assert.ok("text" in page);
    assert.equal(page.etag, contentEtag(await read("N000/N000.md")));
  }
});

test("fresh headers preserve group hierarchy, local lifecycle and duplicate quarantine", async (t) => {
  const { adapter } = await fixture(t);
  await adapter.writeFile("Group/A/A.md", raw("node-parent", "body", "status: deprecated\r\n"));
  await adapter.writeFile("Group/A/B/B.md", raw("node-child", "child"));
  const catalog = await loadNodeCatalog(adapter);
  assert.deepEqual(catalog.rootNodeIds, ["node-parent"]);
  assert.equal(catalog.byId.get("node-child")!.parentNodeId, "node-parent");
  const reader = await selectedContextReader(adapter, source, ["node-child"]);
  const summary = reader.read({ nodeId: "node-child", view: "summary" });
  assert.ok("archived" in summary && !summary.archived);
  await adapter.writeFile("Other/Other.md", raw("node-parent"));
  await assert.rejects(selectedContextReader(adapter, source, ["node-parent"]), error("NOT_FOUND"));
  await assert.rejects(selectedContextReader(adapter, source, ["node-child"]), error("NOT_FOUND"));
  await adapter.writeFile("Other/Other.md", raw("node-other"));
  await adapter.writeFile("Group/A/A.md", "---\nid: [broken\n---\nbody");
  await assert.rejects(selectedContextReader(adapter, source, ["node-child"]), error("NOT_FOUND"));
});

test("staggered catalog reads preserve explicit order, grouping and duplicate isolation", async (t) => {
  const { adapter } = await fixture(t);
  for (const [file, id] of [
    ["A/A.md", "node-a"],
    ["B/B.md", "node-b"],
    ["Group/P/P.md", "node-parent"],
    ["Group/P/Plain/X/X.md", "node-child"],
    ["D1/D1.md", "node-duplicate"],
    ["D1/Child/Child.md", "node-quarantined"],
    ["D2/D2.md", "node-duplicate"],
  ])
    await adapter.writeFile(file!, raw(id!));
  await adapter.writeFile("order.json", JSON.stringify({ __root__: ["node-b", "node-a"] }));
  const read = adapter.readFrontmatter.bind(adapter);
  adapter.readFrontmatter = async (file) => {
    if (file.startsWith("A/") || file.startsWith("D1/"))
      await new Promise((resolve) => setTimeout(resolve, 15));
    return read(file);
  };
  const catalog = await loadNodeCatalog(adapter);
  assert.deepEqual(
    catalog.tree.roots.map((node) => node.path),
    ["B", "A", "D1", "D2", "Group/P"],
  );
  assert.equal(catalog.byId.get("node-child")!.parentNodeId, "node-parent");
  assert.deepEqual(catalog.byId.get("node-parent")!.childNodeIds, ["node-child"]);
  assert.equal(catalog.byId.has("node-duplicate"), false);
  assert.equal(catalog.byId.has("node-quarantined"), false);
});

test("selected exact reads see edits and moves; changed lookup metadata fails", async (t) => {
  const { adapter } = await fixture(t);
  const original = raw("node-selected", "😀正文\r\n".repeat(6000));
  await adapter.writeFile("A/A.md", original);
  const first = await selectedContextReader(adapter, source, ["node-selected"]);
  assert.equal(first.documentBytes("node-selected").raw, original);
  const page = first.read({ nodeId: "node-selected" });
  assert.ok("text" in page);
  assert.equal(page.text, "😀正文\r\n".repeat(6000));
  const edited = original.replace("正文", "手改");
  await adapter.writeFile("A/A.md", edited);
  const next = await selectedContextReader(adapter, source, ["node-selected"]);
  assert.equal(next.documentBytes("node-selected").raw, edited);
  assert.throws(
    () => next.read({ nodeId: "node-selected", expectedEtag: page.etag }),
    error("SOURCE_CHANGED"),
  );
  await adapter.move("A", "B");
  await adapter.move("B/A.md", "B/B.md");
  const moved = await selectedContextReader(adapter, source, ["node-selected"]);
  assert.equal(moved.documentBytes("node-selected").path, "B/B.md");
  const read = adapter.readFile.bind(adapter);
  adapter.readFile = async (file) =>
    file === "B/B.md" ? edited.replace("node-selected", "node-replaced") : read(file);
  await assert.rejects(
    selectedContextReader(adapter, source, ["node-selected"]),
    error("SOURCE_CHANGED"),
  );
});

test("catalog and selected reads never repair corrupt order files", async (t) => {
  const { adapter } = await fixture(t);
  await adapter.writeFile("A/A.md", raw("node-selected"));
  await adapter.writeFile("order.json", "{bad");
  const before = await adapter.listDir("");
  await assert.rejects(
    selectedContextReader(adapter, source, ["node-selected"]),
    /explicit repair/,
  );
  assert.equal(await adapter.readFile("order.json"), "{bad");
  assert.deepEqual(await adapter.listDir(""), before);
});
