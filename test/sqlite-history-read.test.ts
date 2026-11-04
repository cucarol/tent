import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { SqliteDocumentHistory, sqliteContentFingerprint } from "../src/fs/sqlite-history.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";
import { testScratchRoot } from "./scratch.js";

const raw = (id: string, body: string) => `---\nid: ${id}\ntype: prompt\n---\n${body}`;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-read-"));
  const history = new SqliteDocumentHistory(root);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await history.initialize();
  return { root, history };
}

test("a Node's history pages its own events across reverts and moves", async (t) => {
  const { history } = await fixture(t);
  for (const [file, id, body] of [
    ["A/A.md", "node-a", "first"],
    ["B/B.md", "node-b", "mentions node-a in its body"],
    ["A/A.md", "node-a", "second"],
    ["A/A.md", "node-a", "first"],
  ] as const)
    await history.captureUnlocked([{ path: file, raw: raw(id, body) }]);
  await history.captureUnlocked([
    { path: "A/A.md", raw: null },
    { path: "C/C.md", raw: raw("node-a", "first") },
  ]);
  const expected = (await history.changesInRange()).flatMap((event) => {
    const changes = event.changes.filter((change) => change.objectId === "node-a");
    return changes.length ? [{ ...event, changes }] : [];
  });
  assert.equal(expected.length, 4);
  assert.deepEqual(await history.nodeVersionPage("node-a", 1, 2), {
    total: 4,
    items: expected.slice(1, 3),
  });
  assert.deepEqual(
    expected.at(-1)!.changes.map((change) => [change.before?.path, change.after?.path]),
    [["A/A.md", "C/C.md"]],
  );
  assert.deepEqual(await history.nodeVersionPage("node-missing", 0, 2), { total: 0, items: [] });
});

test("versions read back in request order and an absent one fails the read", async (t) => {
  const { history } = await fixture(t);
  const first = await history.captureUnlocked([{ path: "A/A.md", raw: raw("node-a", "first") }]);
  const second = await history.captureUnlocked([{ path: "A/A.md", raw: raw("node-a", "second") }]);
  assert.deepEqual(
    await history.readVersions([second.versions[0]!, first.versions[0]!, second.versions[0]!]),
    [raw("node-a", "second"), raw("node-a", "first"), raw("node-a", "second")],
  );
  await assert.rejects(
    history.readVersions([first.versions[0]!, { commit: first.commit!, path: "B/B.md" }]),
    /Document absent at SQLite event: B\/B\.md/,
  );
  await assert.rejects(history.changesInRange({ from: "0".repeat(64) }), /Unknown SQLite event/);
});

test("damaged bytes fail every read that needs them", async (t) => {
  const { root, history } = await fixture(t);
  const original = raw("node-a", "original");
  const { versions } = await history.captureUnlocked([{ path: "A/A.md", raw: original }]);
  await history.captureUnlocked([{ path: "B/B.md", raw: raw("node-b", "unrelated") }]);
  const source = new DatabaseSync(path.join(root, ".git/history.sqlite"));
  source
    .prepare("UPDATE blobs SET raw=? WHERE digest=?")
    .run(raw("node-a", "altered"), sqliteContentFingerprint(original));
  source.close();
  const damaged = (error: unknown) =>
    error instanceof Error &&
    error.message === `Damaged SQLite content: ${sqliteContentFingerprint(original)}`;
  await assert.rejects(history.nodeVersionPage("node-a", 0, 1), damaged);
  await assert.rejects(history.changesInRange(), damaged);
  await assert.rejects(history.read(versions[0]!), damaged);
  assert.equal((await history.nodeVersionPage("node-b", 0, 1)).total, 1);
});

test("a later request settles a transaction interrupted after the last one", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-ready-"));
  const history = new SqliteDocumentHistory(root);
  await history.initialize();
  await history.close();
  const adapter = new NodeFs(root);
  t.after(async () => {
    await adapter.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await withFileReadScope(async () => {
    await adapter.ready();
    await adapter.ready();
  });
  await fs.writeFile(path.join(root, "sample.md"), "after");
  const bytes = (s: string) => ({ bytes: Buffer.from(s).toString("base64") });
  await fs.writeFile(
    path.join(root, ".git/tent-transaction.json"),
    JSON.stringify({
      publish: null,
      entries: [
        {
          path: "sample.md",
          before: bytes("before"),
          after: bytes("after"),
          versions: [bytes("before"), bytes("after")],
        },
      ],
    }),
  );
  assert.equal(await withFileReadScope(() => adapter.readFile("sample.md")), "before");
  await assert.rejects(fs.access(path.join(root, ".git/tent-transaction.json")));
});

test("an unopened history sees another connection initialize it and a closed one fails", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-availability-"));
  const reader = new SqliteDocumentHistory(root);
  t.after(async () => {
    await reader.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(reader.currentCommit(), /has no history.*run tent new/);
  const initializer = new SqliteDocumentHistory(root);
  await initializer.initialize();
  await initializer.close();
  assert.equal(await reader.currentCommit(), null);
  await reader.close();
  await assert.rejects(reader.currentCommit(), /connection is closed/);
});
