import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import {
  completedCardPaths,
  listCardDocuments,
  readCardDocument,
  takeCardDocument,
} from "../src/core/graph/card-document.js";
import { inspectCurrentContext, makeContextBrief } from "../src/core/read/context-brief.js";
import { readWorkspaceRevision } from "../src/core/workspace/workspace-revision.js";
import { checkGraph } from "../src/core/check/graph-check.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "card-completion-"));
  t.after(async () => {
    assert.equal(path.dirname(workspace), path.resolve(testScratchRoot()));
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await initializeFixtureWorkspace(workspace);
  const root = path.join(workspace, ".tent");
  const adapter = new NodeFs(root);
  const cards = [
    ["plain", { state: "consumed" }],
    [
      "closed",
      { state: "closed", returnTo: "role-owner", receivedBy: "role-worker", result: "done" },
    ],
    ["deprecated", { state: "pending", status: "deprecated" }],
    ["pending", { state: "pending" }],
    ["working", { state: "consumed", returnTo: "role-owner", receivedBy: "role-worker" }],
    [
      "returned",
      { state: "returned", returnTo: "role-owner", receivedBy: "role-worker", result: "done" },
    ],
  ] as const;
  const documents = cards.map(([id, fields]) => ({
    path: `cards/card-${id}.md`,
    raw: serializeFrontmatter(
      { type: "card", id: `card-${id}`, schemaVersion: 3, sources: [], ...fields },
      "Original input",
    ),
  }));
  for (const role of ["owner", "worker"])
    documents.push({
      path: `roles/role-${role}.md`,
      raw: serializeFrontmatter({ type: "role", id: `role-${role}`, title: role }, "Direction"),
    });
  const published = documents.map((document) => {
    if (!document.path.startsWith("cards/")) return document;
    const { data, body } = parseFrontmatter(document.raw);
    delete data.receivedBy;
    delete data.result;
    return { ...document, raw: serializeFrontmatter({ ...data, state: "pending" }, body) };
  });
  for (const document of published) await adapter.writeFile(document.path, document.raw);
  await adapter.history.captureUnlocked(published, { operation: "card.create" });
  for (const document of documents) await adapter.writeFile(document.path, document.raw);
  await adapter.history.captureUnlocked(documents, { operation: "card.take" });
  const cache = path.join(root, ".git/tent-material-cache/completed-cards.json");
  return { workspace, root, adapter, cache };
}

test("brief validates only unfinished headers and UI revisions skip retained completed bytes", async (t) => {
  const { adapter } = await fixture(t);
  assert.deepEqual([...(await completedCardPaths(adapter))].sort(), [
    "cards/card-closed.md",
    "cards/card-deprecated.md",
    "cards/card-plain.md",
  ]);
  const readHeader = adapter.readFrontmatter.bind(adapter);
  const headers: string[] = [];
  t.mock.method(adapter, "readFrontmatter", async (file: string) => {
    if (file.startsWith("cards/")) headers.push(file);
    return readHeader(file);
  });
  const listDir = adapter.listDir.bind(adapter);
  let cardDirectories = 0;
  t.mock.method(adapter, "listDir", async (file: string) => {
    if (file === "cards") cardDirectories++;
    return listDir(file);
  });
  const brief = makeContextBrief(await inspectCurrentContext(adapter));
  assert.deepEqual(brief.cardInputs.map((item) => item.cardId).sort(), [
    "card-pending",
    "card-returned",
    "card-working",
  ]);
  assert.deepEqual(headers.sort(), [
    "cards/card-pending.md",
    "cards/card-returned.md",
    "cards/card-working.md",
  ]);
  assert.equal(cardDirectories, 1);
  const revision = await readWorkspaceRevision(adapter);
  await adapter.writeFile("cards/card-plain.md", "---\nid: [broken\n");
  assert.equal(await readWorkspaceRevision(adapter), revision);
  assert.deepEqual(makeContextBrief(await inspectCurrentContext(adapter)), brief);
  const pending = await adapter.readFile("cards/card-pending.md");
  await adapter.writeFile("cards/card-pending.md", pending.replace("Original", "Changed"));
  assert.notEqual(await readWorkspaceRevision(adapter), revision);
  await adapter.writeFile("cards/card-new.md", "---\nid: [broken\n");
  const inspected = await inspectCurrentContext(adapter);
  assert.ok(inspected.cards.items.some((item) => item.cardId === "card-new" && item.diagnostic));
});

test("completion membership updates only changed Card paths and survives a fresh reader and HEAD reset", async (t) => {
  const { root, adapter } = await fixture(t);
  const original = [...(await completedCardPaths(adapter))].sort();
  const before = (await adapter.history.currentCommit())!;
  const fresh = new NodeFs(root);
  const read = fresh.history.completedCardPaths.bind(fresh.history);
  const classified: string[] = [];
  t.mock.method(
    fresh.history,
    "completedCardPaths",
    (predicate: (file: string, raw: string) => boolean) =>
      read((file, raw) => {
        classified.push(file);
        return predicate(file, raw);
      }),
  );
  t.mock.method(fresh.history, "readDirectory", async () => {
    throw new Error("An existing completion list must not rescan unchanged Cards");
  });
  assert.deepEqual([...(await completedCardPaths(fresh))].sort(), original);
  assert.deepEqual(classified, []);
  await takeCardDocument(adapter, "card-pending");
  assert.ok((await completedCardPaths(fresh)).has("cards/card-pending.md"));
  assert.deepEqual(classified, ["cards/card-pending.md"]);
  classified.length = 0;
  await git(root, "commit", "--allow-empty", "-m", "Unrelated HEAD");
  assert.ok((await completedCardPaths(fresh)).has("cards/card-pending.md"));
  assert.deepEqual(classified, []);
  await git(root, "reset", "--hard", before);
  assert.deepEqual([...(await completedCardPaths(fresh))].sort(), original);
  assert.deepEqual(classified, ["cards/card-pending.md"]);
  classified.length = 0;
  await adapter.remove("cards/card-plain.md");
  await adapter.history.captureUnlocked([{ path: "cards/card-plain.md", raw: null }], {
    operation: "card.delete",
  });
  assert.ok(!(await completedCardPaths(fresh)).has("cards/card-plain.md"));
  assert.deepEqual(classified, []);
});

test("missing, corrupt and incompatible completion caches rebuild the same retained membership", async (t) => {
  const { root, adapter, cache } = await fixture(t);
  const expected = [...(await completedCardPaths(adapter))].sort();
  const retained = JSON.parse(await fs.readFile(cache, "utf8"));
  await adapter.writeFile("cards/card-plain.md", "---\nid: [broken\n");
  for (const value of [
    undefined,
    "{broken",
    JSON.stringify({ ...retained, version: 999 }),
    JSON.stringify({ ...retained, value: [], digest: "bad" }),
    JSON.stringify({
      ...retained,
      value: ["../outside.md"],
      digest: createHash("sha256")
        .update(JSON.stringify(["../outside.md"]))
        .digest("hex"),
    }),
  ]) {
    if (value === undefined) await fs.unlink(cache);
    else await fs.writeFile(cache, value);
    assert.deepEqual([...(await completedCardPaths(new NodeFs(root)))].sort(), expected);
  }
  await fs.unlink(cache);
  await fs.mkdir(cache);
  assert.deepEqual([...(await completedCardPaths(new NodeFs(root)))].sort(), expected);
  assert.deepEqual([...(await completedCardPaths(new NodeFs(root)))].sort(), expected);
});

test("explicit Card reads and workspace check still inspect completed native edits", async (t) => {
  const { workspace, adapter } = await fixture(t);
  await completedCardPaths(adapter);
  const original = parseFrontmatter(await adapter.readFile("cards/card-plain.md"));
  await adapter.writeFile(
    "cards/card-plain.md",
    serializeFrontmatter(original.data, "Changed input"),
  );
  const shown = await readCardDocument(adapter, "card-plain");
  assert.match(shown.text, /Changed input/);
  await assert.rejects(takeCardDocument(adapter, "card-plain"), { code: "INPUT_CHANGED" });
  assert.ok(
    (await listCardDocuments(adapter, { state: "consumed" })).items.some(
      (item) => item.cardId === "card-plain",
    ),
  );
  const checked = await checkGraph(adapter, workspace, async () => true);
  assert.ok(checked.errors.some((item) => item.path === "cards/card-plain.md"));
  await adapter.remove("cards/card-closed.md");
  const missing = await checkGraph(adapter, workspace, async () => true);
  assert.ok(missing.errors.some((item) => item.path === "cards/card-closed.md"));
  await adapter.writeFile("cards/card-deprecated.md", "---\nid: [broken\n");
  assert.ok(
    (await listCardDocuments(adapter, { includeDeprecated: true })).items.some(
      (item) => item.cardId === "card-deprecated" && item.diagnostic,
    ),
  );
});
