import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "../src/fs/sqlite-runtime.js";
import {
  SqliteDocumentHistory,
  sqliteContentFingerprint,
} from "../src/core/store/sqlite-history.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { withFileReadScope } from "../src/fs/file-state-cache.js";
import { canonicalSha256 } from "../src/core/base/canonical-digest.js";
import { itemPageStart, pageItems } from "../src/cli/reader-page.js";
import { testScratchRoot } from "./scratch.js";

const raw = (id: string, body: string) => `---\nid: ${id}\ntype: prompt\n---\n${body}`;
const cache = (root: string) => path.join(root, ".git/tent-material-cache/history-index.sqlite");

test("projection updates prepare fixed statements once per batch and recreate them after close", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-batch-"));
  let history = new SqliteDocumentHistory(root);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await history.initialize();
  for (let i = 0; i < 4; i++)
    await history.captureUnlocked([{ path: `N${i}/N${i}.md`, raw: raw(`node-n${i}`, String(i)) }]);
  const fixed = [
    "INSERT INTO events VALUES(?,?)",
    "INSERT INTO versions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET latest=excluded.latest",
    "UPDATE versions SET latest=NULL WHERE id=?",
    "INSERT INTO node_events VALUES(?,?,?)",
    "SELECT value FROM node_events WHERE id=? ORDER BY seq",
    "INSERT OR REPLACE INTO nodes VALUES(?,?)",
    "SELECT id FROM identities WHERE digest=?",
    "INSERT INTO identities VALUES(?,?)",
    "SELECT raw FROM blobs WHERE digest=?",
    "SELECT * FROM changes WHERE event=? ORDER BY path",
    "INSERT OR REPLACE INTO state VALUES(?,?)",
  ];
  const prepared = new Map<string, number>();
  const prepare = DatabaseSync.prototype.prepare;
  const observer = t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      prepared.set(sql, (prepared.get(sql) ?? 0) + 1);
      return prepare.call(this, sql);
    },
  );
  const first = await history.identityVersions();
  assert.equal(Object.keys(first.latest).length, 4);
  for (const sql of fixed) assert.equal(prepared.get(sql), 1, sql);
  t.diagnostic(
    JSON.stringify({
      phase: "four-event-batch",
      fixedPrepares: Object.fromEntries(fixed.map((sql) => [sql, prepared.get(sql)])),
    }),
  );
  observer.mock.restore();
  await history.close();
  history = new SqliteDocumentHistory(root);
  await history.captureUnlocked([{ path: "N0/N0.md", raw: raw("node-n0", "updated") }]);
  prepared.clear();
  const reopened = t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      prepared.set(sql, (prepared.get(sql) ?? 0) + 1);
      return prepare.call(this, sql);
    },
  );
  const next = await history.identityVersions();
  assert.deepEqual(next.first, first.first);
  assert.notDeepEqual(next.latest["node-n0"], first.latest["node-n0"]);
  for (const sql of fixed) assert.equal(prepared.get(sql), 1, sql);
  reopened.mock.restore();
});

test("history projections increment by seq, parse each digest once, and page only selected Node events", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-index-"));
  let history = new SqliteDocumentHistory(root);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await history.initialize();
  for (const [id, body] of [
    ["node-a", "A"],
    ["node-b", "unrelated"],
    ["node-a", "B"],
    ["node-a", "A"],
  ])
    await history.captureUnlocked([{ path: `${id}/${id}.md`, raw: raw(id!, body!) }]);
  const all = await history.changesInRange();
  const expected = all.flatMap((e) => {
    const changes = e.changes.filter((c) => c.objectId === "node-a");
    return changes.length ? [{ ...e, changes }] : [];
  });
  assert.equal(expected.length, 3);
  assert.equal((await history.nodeVersionPage("node-a", 0, 2)).revision, canonicalSha256(expected));
  assert.deepEqual((await history.nodeVersionPage("node-a", 1, 1)).items, expected.slice(1, 2));
  assert.deepEqual(await history.nodeVersions("node-a"), expected);
  const saved = await history.identityVersions();
  await history.close();
  const index = new DatabaseSync(cache(root));
  assert.equal(index.prepare("SELECT count(*) AS n FROM identities").get()!.n, 3);
  // Any attempt to revisit old events or parse an already known digest fails.
  index.exec(`CREATE TRIGGER old_events BEFORE INSERT ON events WHEN NEW.seq<=4 BEGIN SELECT RAISE(ABORT,'replayed old event'); END;
    CREATE TRIGGER repeated_digest BEFORE INSERT ON identities BEGIN SELECT RAISE(ABORT,'reparsed known content'); END;`);
  index.close();
  history = new SqliteDocumentHistory(root);
  const ranges: SQLInputValue[][] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const observed = t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql === "SELECT * FROM events WHERE seq>? AND seq<=? ORDER BY seq") {
        const all = statement.all;
        t.mock.method(statement, "all", function (...args: SQLInputValue[]) {
          ranges.push(args);
          return Reflect.apply(all, statement, args);
        });
      }
      return statement;
    },
  );
  assert.deepEqual(await history.identityVersions(), saved);
  await history.nodeVersionPage("node-a", 0, 2);
  assert.deepEqual(ranges, [], "warm reads never scan historical event ranges");
  const external = new SqliteDocumentHistory(root);
  try {
    await external.captureUnlocked([{ path: "node-a/node-a.md", raw: raw("node-a", "B") }]);
  } finally {
    await external.close();
  }
  const next = await history.nodeVersions("node-a");
  const advanced = new DatabaseSync(cache(root));
  assert.equal(
    advanced.prepare("SELECT count(*) AS n FROM events").get()!.n,
    5,
    "the persisted projection advanced without replay/fallback",
  );
  assert.equal(advanced.prepare("SELECT count(*) AS n FROM identities").get()!.n, 3);
  advanced.close();
  assert.equal(next.length, 4);
  assert.deepEqual(ranges, [[4, 5]], "new history reads process exactly the new seq range");
  observed.mock.restore();
  assert.deepEqual(next.slice(0, 3), expected);
  await history.close();
  const authority = await fs.readFile(path.join(root, ".git/history.sqlite"));
  await fs.rm(path.dirname(cache(root)), { recursive: true });
  history = new SqliteDocumentHistory(root);
  assert.deepEqual(await history.nodeVersions("node-a"), next);
  await history.close();
  const incomplete = new DatabaseSync(cache(root));
  incomplete.exec("DROP TABLE node_events");
  incomplete.close();
  history = new SqliteDocumentHistory(root);
  assert.deepEqual(await history.nodeVersions("node-a"), next);
  await history.close();
  await fs.writeFile(cache(root), "damaged disposable cache");
  history = new SqliteDocumentHistory(root);
  assert.deepEqual(await history.nodeVersions("node-a"), next);
  assert.deepEqual(await fs.readFile(path.join(root, ".git/history.sqlite")), authority);
});

test("SQL history windows preserve all page bytes, cursor revision, budget truncation and stale cursor errors", () => {
  const items = Array.from({ length: 30 }, (_, n) => ({
    commit: String(n),
    changes: [{ objectId: "node-a", before: { commit: "x", path: "a/" + "x".repeat(900) } }],
  }));
  const revision = canonicalSha256(items),
    operation = "node.history:node-a";
  const first = pageItems({ items, revision }, operation, { limit: 20 });
  const window = pageItems({ items: items.slice(0, 20), revision }, operation, {
    limit: 20,
    window: { start: 0, total: items.length },
  });
  assert.deepEqual(window, first);
  const cursor = first.page.nextCursor!,
    start = itemPageStart(cursor, operation);
  assert.deepEqual(
    pageItems({ items: items.slice(start, start + 20), revision }, operation, {
      cursor,
      limit: 20,
      window: { start, total: items.length },
    }),
    pageItems({ items, revision }, operation, { cursor, limit: 20 }),
  );
  assert.throws(() => itemPageStart(cursor, "node.history:node-b"), /another source/);
  assert.throws(() => itemPageStart(undefined, operation, 0), /Invalid page limit/);
  assert.throws(
    () => pageItems({ items, revision: "changed" }, operation, { cursor }),
    /source changed/,
  );
});

test("one read scope shares ready probes; later requests still settle new interrupted transactions", async (t) => {
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
      version: 1,
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

test("damaged projection values rebuild, but damaged authoritative content retains its original error", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-damage-"));
  let history = new SqliteDocumentHistory(root);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await history.initialize();
  await history.captureUnlocked([{ path: "A/A.md", raw: raw("node-a", "A") }]);
  const expected = await history.nodeVersions("node-a");
  await history.close();
  const index = new DatabaseSync(cache(root));
  index.prepare("UPDATE node_events SET value=?").run('{"validJson":"wrong projection"}');
  index.close();
  history = new SqliteDocumentHistory(root);
  assert.deepEqual((await history.nodeVersionPage("node-a", 0, 20)).items, expected);
  assert.deepEqual(await history.nodeVersions("node-a"), expected);
  const source = new DatabaseSync(path.join(root, ".git/history.sqlite"));
  source.prepare("UPDATE blobs SET raw=?").run("damaged authority");
  source.close();
  await assert.rejects(history.nodeVersions("node-a"), /Damaged SQLite content: [a-f0-9]{64}/);
});

test("records and identity projections remain independent and a superseded invalid record stays superseded", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-records-"));
  const history = new SqliteDocumentHistory(root);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await history.initialize();
  const valid = { v: 1 as const, materials: [] };
  await history.captureUnlocked([{ path: "A/A.md", raw: raw("node-a", "A") }], {
    operation: "test.records",
    nodeRecords: { "node-a": valid },
  });
  const authority = new DatabaseSync(path.join(root, ".git/history.sqlite"));
  const append = (value: unknown) => {
    const parent = authority.prepare("SELECT id FROM events ORDER BY seq DESC LIMIT 1").get()!.id;
    const seq = authority
      .prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)")
      .run(
        randomBytes(32).toString("hex"),
        parent!,
        new Date().toISOString(),
        '{"operation":"test.imported-record"}',
      ).lastInsertRowid;
    authority
      .prepare("INSERT INTO records VALUES(?,?,?)")
      .run(seq, "node-a", JSON.stringify(value));
  };
  try {
    append({ invalid: true });
    assert.equal(
      (await history.nodeVersions("node-a")).length,
      1,
      "history never reads unrelated records",
    );
    await assert.rejects(history.nodeRecords());
    append(valid);
    assert.deepEqual(await history.nodeRecords(), { "node-a": valid });
    authority.prepare("UPDATE blobs SET raw=?").run("damaged history content");
    assert.deepEqual(
      await history.nodeRecords(),
      { "node-a": valid },
      "record reads do not parse unrelated historical documents",
    );
    await assert.rejects(history.nodeVersions("node-a"), /Damaged SQLite content/);
  } finally {
    authority.close();
  }
});

test("initialization refreshes earlier negative availability without weakening legacy or closed errors", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-availability-"));
  const reader = new SqliteDocumentHistory(root);
  t.after(async () => {
    await reader.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(await reader.available(), false);
  const initializer = new SqliteDocumentHistory(root);
  await initializer.initialize();
  await initializer.close();
  assert.equal(await reader.available(), true);
  await fs.writeFile(path.join(root, "index.md"), "legacy marker");
  await fs.writeFile(path.join(root, ".git/HEAD"), "legacy ref");
  const sqlite = new SqliteDocumentHistory(root);
  assert.equal(
    await sqlite.currentCommit(),
    null,
    "an existing SQLite database is not legacy-probed",
  );
  await sqlite.close();
  await reader.close();
  await assert.rejects(reader.available(), /connection is closed/);
  await fs.rm(path.join(root, ".git/history.sqlite"));
  const legacy = new SqliteDocumentHistory(root);
  try {
    await assert.rejects(legacy.available(), /legacy Git history/);
  } finally {
    await legacy.close();
  }
});

test("an existing unopened adapter sees another process initialize history at the next request", async (t) => {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-external-init-"));
  const history = new SqliteDocumentHistory(root);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await withFileReadScope(async () => {
    assert.equal(await history.available(), false);
    const source = new URL("../src/core/store/sqlite-history.ts", import.meta.url).href;
    const code = `import { SqliteDocumentHistory } from ${JSON.stringify(source)}; const history = new SqliteDocumentHistory(process.argv[1]); try { await history.initialize(); } finally { await history.close(); }`;
    const child = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code, root],
      { windowsHide: true },
    );
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "");
    assert.equal(
      await history.available(),
      false,
      "an initialized read request keeps its negative probe",
    );
  });
  assert.equal(await withFileReadScope(() => history.available()), true);
  assert.equal(await history.currentCommit(), null);
});

test("selected history bytes remain authoritative when an unrelated new event advances a warm projection", async (t) => {
  for (const damaged of [false, true]) {
    await t.test(
      damaged ? "old selected content is damaged" : "legal append stays incremental",
      async (t) => {
        const root = await fs.mkdtemp(path.join(testScratchRoot(), "history-advanced-damage-"));
        const history = new SqliteDocumentHistory(root);
        t.after(async () => {
          await history.close();
          await fs.rm(root, { recursive: true, force: true });
        });
        await history.initialize();
        const a = raw("node-a", "original A"),
          b = raw("node-b", "unrelated B");
        const first = await history.captureUnlocked([{ path: "A/A.md", raw: a }]);
        const expected = await history.nodeVersionPage("node-a", 0, 1);
        const writer = new SqliteDocumentHistory(root);
        try {
          await writer.captureUnlocked([{ path: "B/B.md", raw: b }]);
        } finally {
          await writer.close();
        }
        if (damaged) {
          const source = new DatabaseSync(path.join(root, ".git/history.sqlite"));
          source
            .prepare("UPDATE blobs SET raw=? WHERE digest=?")
            .run("corrupted original A", sqliteContentFingerprint(a));
          source.close();
        }
        const queries: Array<{ sql: string; args: SQLInputValue[] }> = [];
        const source = Reflect.get(history, "database") as DatabaseSync;
        const original = DatabaseSync.prototype.prepare;
        const observer = t.mock.method(
          DatabaseSync.prototype,
          "prepare",
          function (this: DatabaseSync, sql: string) {
            const statement = original.call(this, sql);
            if (this === source)
              for (const method of ["all", "get"] as const) {
                const execute = statement[method];
                t.mock.method(statement, method, function (...args: SQLInputValue[]) {
                  queries.push({ sql, args });
                  return Reflect.apply(execute, statement, args);
                });
              }
            return statement;
          },
        );
        if (damaged) {
          const message = `Damaged SQLite content: ${sqliteContentFingerprint(a)}`;
          const exactError = (error: unknown) =>
            error instanceof Error && error.message === message;
          await assert.rejects(history.nodeVersionPage("node-a", 0, 1), exactError);
          await assert.rejects(history.nodeVersions("node-a"), exactError);
          await assert.rejects(history.changesInRange(), exactError);
          await assert.rejects(history.read(first.versions[0]!), exactError);
        } else {
          assert.deepEqual(await history.nodeVersionPage("node-a", 0, 1), expected);
          assert.deepEqual(
            queries
              .filter((q) => q.sql.startsWith("SELECT * FROM events WHERE seq>?"))
              .map((q) => q.args),
            [[1, 2]],
          );
          assert.deepEqual(
            queries
              .filter((q) => q.sql === "SELECT raw FROM blobs WHERE digest=?")
              .map((q) => q.args[0])
              .sort(),
            [sqliteContentFingerprint(a), sqliteContentFingerprint(b)].sort(),
          );
          t.diagnostic(
            JSON.stringify({
              phase: "after-unrelated-append",
              statements: queries.length,
              queries,
            }),
          );
          queries.length = 0;
          assert.deepEqual(await history.nodeVersionPage("node-a", 0, 1), expected);
          assert.equal(queries.filter((q) => q.sql.includes("WHERE seq>?")).length, 0);
          assert.deepEqual(
            queries
              .filter((q) => q.sql === "SELECT raw FROM blobs WHERE digest=?")
              .map((q) => q.args),
            [[sqliteContentFingerprint(a)]],
          );
          assert.equal(
            queries.length,
            5,
            "warm one-event page uses two head/anchor lookups and three selected-version checks",
          );
          t.diagnostic(
            JSON.stringify({ phase: "warm-selected-page", statements: queries.length, queries }),
          );
          const c = raw("node-a", "changed A");
          await history.captureUnlocked([{ path: "A/A.md", raw: c }]);
          await history.captureUnlocked([{ path: "A/A.md", raw: a }]);
          await history.nodeVersionPage("node-a", 0, 3);
          queries.length = 0;
          assert.equal((await history.nodeVersionPage("node-a", 0, 3)).items.length, 3);
          assert.deepEqual(
            queries
              .filter((q) => q.sql === "SELECT raw FROM blobs WHERE digest=?")
              .map((q) => q.args[0])
              .sort(),
            [sqliteContentFingerprint(a), sqliteContentFingerprint(c)].sort(),
            "A→C→A validates each authority digest once despite distinct event versions",
          );
          assert.equal(queries.filter((q) => q.sql.includes("WHERE seq>?")).length, 0);
          t.diagnostic(
            JSON.stringify({
              phase: "warm-three-event-two-digest-page",
              statements: queries.length,
              queries,
            }),
          );
        }
        observer.mock.restore();
      },
    );
  }
});
