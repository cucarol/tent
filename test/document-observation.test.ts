import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory, testScratchRoot } from "./scratch.js";
import { documentHeader } from "../src/core/graph/node-catalog.js";
import { sqliteContentFingerprint } from "../src/core/store/sqlite-history.js";
import { retainedDocumentFs } from "../src/core/graph/retained-read.js";
import { listCardDocuments } from "../src/core/graph/card-document.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { contentEtag } from "../src/core/base/etag.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";

const card = (id: string, body = "private body", extra = "") =>
  `---\ntype: card\nid: ${id}\nschemaVersion: 3\nstate: pending\ntitle: ${id}\n${extra}---\n${body}`;

async function fixture(t: TestContext, raw = card("card-a")) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "document-observation-"));
  t.after(() => removeTestFixture(root, { recursive: true, force: true }));
  await initializeFixtureHistory(root);
  await fs.mkdir(path.join(root, "cards"));
  const relative = "cards/card-a.md",
    filename = path.join(root, relative);
  await fs.writeFile(filename, raw);
  const old = new Date(Date.now() - 5000);
  await fs.utimes(filename, old, old);
  return {
    root,
    relative,
    filename,
    adapter: openTestFs(root),
    cache: path.join(root, ".git/tent-material-cache/file-state.json"),
  };
}

function sourceOpens(t: TestContext, filename: string) {
  let count = 0;
  const open = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (path.resolve(String(args[0])) === path.resolve(filename)) count++;
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return () => count;
}

test("document observation caches only prefix and decoded-text fingerprint across adapters", async (t) => {
  const bytes = Buffer.concat([
    Buffer.from("\uFEFF" + card("card-a", "private body ")),
    Buffer.from([0xff, 0xfe]),
  ]);
  const f = await fixture(t);
  await fs.writeFile(f.filename, bytes);
  const old = new Date(Date.now() - 5000);
  await fs.utimes(f.filename, old, old);
  const count = sourceOpens(t, f.filename);
  const expected = {
    content: documentHeader(bytes.toString("utf8")),
    fingerprint: sqliteContentFingerprint(bytes.toString("utf8")),
  };
  assert.deepEqual(await f.adapter.readFrontmatterWithFingerprint(f.relative), expected);
  assert.equal(count(), 1);
  assert.deepEqual(await openTestFs(f.root).readFrontmatterWithFingerprint(f.relative), expected);
  assert.equal(count(), 1, "a fresh adapter validates stat without opening unchanged bytes");
  const cache = await fs.readFile(f.cache, "utf8");
  assert.ok(!cache.includes("private body"), "full document text must not persist");
  assert.ok(cache.includes(expected.fingerprint));
  await f.adapter.observationScope(() => f.adapter.readFrontmatterWithFingerprint(f.relative), {
    forceContent: true,
  });
  assert.equal(count(), 2, "explicit content checks bypass persistent observations");
});

test("current stat detects body/header edits with restored mtime and path replacement inside one scope", async (t) => {
  const f = await fixture(t);
  await withFileReadScope(async () => {
    const first = await f.adapter.readFrontmatterWithFingerprint(f.relative);
    const times = await fs.stat(f.filename);
    const changed = card("card-a", "PRIVATE BODY");
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(card("card-a")));
    await fs.writeFile(f.filename, changed);
    await fs.utimes(f.filename, times.atime, times.mtime);
    const next = await f.adapter.readFrontmatterWithFingerprint(f.relative);
    assert.equal(next.content, first.content);
    assert.notEqual(next.fingerprint, first.fingerprint);
    assert.equal(next.fingerprint, sqliteContentFingerprint(changed));
    const replacement = card("card-b", "PRIVATE BODY");
    await fs.writeFile(f.filename + ".new", replacement);
    await fs.utimes(f.filename + ".new", times.atime, times.mtime);
    await fs.rename(f.filename + ".new", f.filename);
    const replaced = await f.adapter.readFrontmatterWithFingerprint(f.relative);
    assert.equal(replaced.content, documentHeader(replacement));
    assert.equal(replaced.fingerprint, sqliteContentFingerprint(replacement));
  });
});

test("missing/damaged cache, racy files and malformed headers reread complete current bytes", async (t) => {
  const f = await fixture(t);
  const count = sourceOpens(t, f.filename);
  const read = () => f.adapter.readFrontmatterWithFingerprint(f.relative);
  const expected = await read();
  for (const invalid of ["missing", "json", "checksum"]) {
    if (invalid === "missing") await fs.rm(f.cache);
    else if (invalid === "json") await fs.writeFile(f.cache, "{");
    else {
      const cache = JSON.parse(await fs.readFile(f.cache, "utf8"));
      Object.values(cache.entries).forEach((entry: any) => (entry.digest = "bad"));
      await fs.writeFile(f.cache, JSON.stringify(cache));
    }
    const before = count();
    assert.deepEqual(await read(), expected);
    assert.equal(count(), before + 1);
  }
  const now = new Date();
  await fs.utimes(f.filename, now, now);
  await read();
  const before = count();
  await read();
  assert.equal(count(), before + 1, "conservative one-second rule is retained");
  const malformed = "---\nid: card-a\nprivate unterminated body";
  await fs.writeFile(f.filename, malformed);
  assert.deepEqual(await read(), {
    content: malformed,
    fingerprint: sqliteContentFingerprint(malformed),
  });
  assert.ok(!(await fs.readFile(f.cache, "utf8")).includes("unterminated body"));
  await fs.writeFile(f.filename, "plain body");
  assert.equal((await read()).content, "");
  await fs.rm(f.filename);
  await assert.rejects(read(), { code: "ENOENT" });
});

test("a handle/path identity mismatch retains SOURCE_CHANGED and read errors", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.filename + ".new", card("card-b"));
  const open = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    // Model a pathname restored after opening a replacement: current path stats
    // describe A while the acquired handle still supplies B.
    if (path.resolve(String(args[0])) === path.resolve(f.filename))
      return open(f.filename + ".new", "r");
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.adapter.readFrontmatterWithFingerprint(f.relative), {
      code: "SOURCE_CHANGED",
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  const denied = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (path.resolve(String(args[0])) === path.resolve(f.filename))
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.adapter.readFrontmatterWithFingerprint(f.relative), { code: "EACCES" });
  } finally {
    denied.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Card lists preserve live validation, full-body uncaptured, revision and fallback semantics", async (t) => {
  const f = await fixture(t);
  const retained = card("card-a");
  await f.adapter.history.captureUnlocked([{ path: f.relative, raw: retained }]);
  await fs.writeFile(
    path.join(f.root, "cards/card-b.md"),
    card("card-b", "B", "order: '!first~card-b'\n"),
  );
  await f.adapter.history.captureUnlocked([
    { path: "cards/card-b.md", raw: card("card-b", "B", "order: '!first~card-b'\n") },
  ]);
  await fs.writeFile(
    path.join(f.root, "cards/card-c.md"),
    "---\ntype: card\nid: card-c\nstate: strange\n---\ninvalid",
  );
  const fallback = new Proxy(f.adapter, {
    get(target, key) {
      if (key === "readFrontmatterWithFingerprint") return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  for (const options of [
    { retainedState: true },
    { state: "pending" as const, retainedState: true },
    { includeDeprecated: true, retainedState: true },
  ]) {
    const expected = await listCardDocuments(fallback, options);
    assert.deepEqual(await listCardDocuments(f.adapter, options), expected);
    assert.deepEqual(await listCardDocuments(f.adapter, options), expected);
  }
  const original = await listCardDocuments(f.adapter, { retainedState: true });
  assert.equal(original.items.find((i) => i.cardId === "card-a")?.uncaptured, undefined);
  assert.deepEqual(
    (await listCardDocuments(f.adapter, { state: "pending", retainedState: true })).items
      .filter((i) => !i.diagnostic)
      .map((i) => i.cardId),
    ["card-b", "card-a"],
  );
  await fs.writeFile(f.filename, retained.replace("private body", "changed body"));
  const edited = await listCardDocuments(f.adapter, { retainedState: true });
  assert.equal(edited.items.find((i) => i.cardId === "card-a")?.uncaptured, true);
  assert.notEqual(edited.revision, original.revision);
  assert.deepEqual(edited, await listCardDocuments(fallback, { retainedState: true }));
  await fs.writeFile(
    f.filename,
    retained.replace("state: pending", "state: consumed\nreceivedBy: role-a"),
  );
  const historical = await retainedDocumentFs(f.adapter);
  assert.equal(historical.readFrontmatterWithFingerprint, undefined);
  assert.equal(
    (await listCardDocuments(historical, { state: "pending" })).items.some(
      (i) => i.cardId === "card-a",
    ),
    true,
  );
  assert.equal(
    (await listCardDocuments(f.adapter, { state: "pending", retainedState: true })).items.some(
      (i) => i.cardId === "card-a",
    ),
    false,
  );
});

test("edit reads share an observation scope while later native edits supply fresh full ETags", async (t) => {
  const f = await fixture(t);
  const relative = "A/A.md",
    filename = path.join(f.root, relative);
  await fs.mkdir(path.dirname(filename));
  const raw = (body: string) => `---\nid: node-alpha\ntype: prompt\n---\n${body}`;
  await fs.writeFile(filename, raw("before"));
  const scope = f.adapter.observationScope.bind(f.adapter);
  let depth = 0,
    fullReadDepth = 0;
  f.adapter.observationScope = async (action) =>
    scope(async () => {
      depth++;
      try {
        return await action();
      } finally {
        depth--;
      }
    });
  const read = f.adapter.readFile.bind(f.adapter);
  f.adapter.readFile = async (file) => {
    if (file === relative) fullReadDepth = depth;
    return read(file);
  };
  const first = await readNodeForEdit(f.adapter, "node-alpha");
  assert.ok(fullReadDepth > 0, "catalog, full document and optional checks share the query scope");
  await fs.writeFile(filename, raw("AFTER!"));
  const next = await readNodeForEdit(f.adapter, "node-alpha");
  assert.equal(next.raw, raw("AFTER!"));
  assert.equal(next.etag, contentEtag(next.raw));
  assert.notEqual(next.etag, first.etag);
  f.adapter.readFile = async (file) =>
    file === relative ? raw("body").replace("node-alpha", "node-other") : read(file);
  await assert.rejects(readNodeForEdit(f.adapter, "node-alpha"), { code: "SOURCE_CHANGED" });
});
