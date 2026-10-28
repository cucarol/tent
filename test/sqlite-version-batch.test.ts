import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  SqliteDocumentHistory,
  sqliteContentFingerprint,
} from "../src/core/store/sqlite-history.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { testScratchRoot } from "./scratch.js";

const raw = (body: string) => `---\nid: node-batch\ntype: prompt\n---\n${body}`;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "version-batch-"));
  const history = new SqliteDocumentHistory(root);
  t.after(async () => {
    await history.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await history.initialize();
  return { root, history };
}

test("retained version batches bound query preparation and keep ordered results independent", async (t) => {
  const { history } = await fixture(t);
  const first = await history.captureUnlocked([{ path: "Fact/Fact.md", raw: raw("first") }]);
  const second = await history.captureUnlocked([{ path: "Fact/Fact.md", raw: raw("second") }]);
  const versions = Array.from({ length: 40 }, (_, index) =>
    index % 2 ? second.versions[0]! : first.versions[0]!,
  );
  const prepare = DatabaseSync.prototype.prepare;
  let prepares = 0;
  const mocked = t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      prepares++;
      return prepare.call(this, sql);
    },
  );
  const values = await history.readVersions([
    ...versions,
    { commit: "invalid", path: "Fact/Fact.md" },
    { commit: "0".repeat(64), path: "Fact/Fact.md" },
    { commit: first.commit!, path: "Missing/Missing.md" },
    { commit: first.commit!, path: "../Fact/Fact.md" },
    { commit: "0".repeat(64), path: "../Fact/Fact.md" },
  ]);
  mocked.mock.restore();
  assert.ok(prepares < 10, `prepared ${prepares} queries for repeated version occurrences`);
  for (const [index, version] of versions.entries()) {
    const value = values[index]!;
    assert.ok(!(value instanceof Error));
    assert.deepEqual(value.version, version);
    assert.equal(value.raw, raw(index % 2 ? "second" : "first"));
    assert.equal(value.changedSince, index % 2 === 0);
  }
  assert.deepEqual(
    values.slice(40).map((value) => value instanceof Error && value.message),
    [
      "Invalid SQLite event: invalid",
      `Unknown SQLite event: ${"0".repeat(64)}`,
      "Document absent at SQLite event: Missing/Missing.md",
      "Invalid history path: ../Fact/Fact.md",
      `Unknown SQLite event: ${"0".repeat(64)}`,
    ],
  );
  const firstValue = values[0]!,
    repeated = values[2]!;
  assert.ok(!(firstValue instanceof Error) && !(repeated instanceof Error));
  firstValue.frontmatter!.id = "mutated";
  assert.equal(repeated.frontmatter!.id, "node-batch");
});

test("version batch reuse keeps A to B to A identities and revalidates later requests", async (t) => {
  const { root, history } = await fixture(t);
  const first = await history.captureUnlocked([{ path: "Fact/Fact.md", raw: raw("A") }]);
  const unchanged = await history.readVersions(first.versions);
  assert.ok(!(unchanged[0] instanceof Error));
  assert.equal(unchanged[0]!.changedSince, false);
  await history.captureUnlocked([{ path: "Fact/Fact.md", raw: raw("B") }]);
  const last = await history.captureUnlocked([{ path: "Fact/Fact.md", raw: raw("A") }]);
  assert.notEqual(first.commit, last.commit);
  const values = await history.readVersions([first.versions[0]!, last.versions[0]!]);
  assert.ok(!(values[0] instanceof Error) && !(values[1] instanceof Error));
  assert.equal(values[0]!.raw, values[1]!.raw);
  assert.equal(values[0]!.changedSince, true);
  assert.equal(values[1]!.changedSince, false);
  const db = new DatabaseSync(path.join(root, ".git/history.sqlite"));
  try {
    db.prepare("UPDATE blobs SET raw=? WHERE raw=?").run(raw("damaged"), raw("A"));
  } finally {
    db.close();
  }
  const damaged = await history.readVersions([first.versions[0]!, last.versions[0]!]);
  assert.ok(
    damaged.every(
      (value) => value instanceof Error && /Damaged SQLite content/.test(value.message),
    ),
  );
});

test("bulk reads chunk large requests and preserve positions when SQL rows arrive reversed", async (t) => {
  const { history } = await fixture(t);
  const documents = Array.from({ length: 270 }, (_, index) => {
    const name = `N${String(index).padStart(3, "0")}`;
    return {
      path: `${name}/${name}.md`,
      raw: raw(name).replace("node-batch", `node-${name.toLowerCase()}`),
    };
  });
  const captured = await history.captureUnlocked(documents);
  const wanted = [...captured.versions, ...captured.versions.slice(0, 20)];
  const prepare = DatabaseSync.prototype.prepare;
  let calls = 0;
  const mocked = t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "all" || key === "get")
            return (...args: unknown[]) => {
              calls++;
              const result = Reflect.apply(value, target, args);
              return key === "all" && /^(?:WITH wanted|SELECT digest,raw)/.test(sql)
                ? (result as unknown[]).reverse()
                : result;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  );
  const values = await history.readVersions(wanted);
  const directory = await history.readDirectory(captured.commit!);
  mocked.mock.restore();
  assert.ok(calls < 15, `${calls} native queries for 290 version occurrences and 270 documents`);
  for (const [index, version] of wanted.entries()) {
    const value = values[index]!;
    assert.ok(!(value instanceof Error));
    assert.deepEqual(value.version, version);
    assert.equal(value.raw, documents.find((d) => d.path === version.path)!.raw);
    assert.equal(value.changedSince, false);
  }
  assert.deepEqual(
    [...directory],
    documents.map((d) => [d.path, d.raw]),
  );
  t.diagnostic(
    JSON.stringify({
      versionOccurrences: wanted.length,
      documents: documents.length,
      nativeQueries: calls,
    }),
  );
});

for (const failedBulk of [false, true])
  test(`bulk blob ${failedBulk ? "failure fallback" : "row reordering"} retains damaged/missing positions and directory first-error order`, async (t) => {
    const { root, history } = await fixture(t);
    const documents = [
      { path: "A/A.md", raw: "valid" },
      { path: "B/B.md", raw: "shared" },
      { path: "C/C.md", raw: "shared" },
      { path: "D/D.md", raw: "missing" },
    ];
    const captured = await history.captureUnlocked(documents);
    const blobs = await history.documentBlobs();
    const shared = blobs.get("B/B.md")!,
      missing = blobs.get("D/D.md")!;
    const db = new DatabaseSync(path.join(root, ".git/history.sqlite"));
    try {
      // Deliberately make the private corruption fixture violate its blob FK.
      db.exec("PRAGMA foreign_keys=OFF");
      db.prepare("UPDATE blobs SET raw=? WHERE digest=?").run("corrupt", shared);
      db.prepare("DELETE FROM blobs WHERE digest=?").run(missing);
      const prepare = DatabaseSync.prototype.prepare;
      t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        if (failedBulk && sql.startsWith("SELECT digest,raw"))
          throw new Error("Controlled bulk blob failure");
        const statement = prepare.call(this, sql);
        return new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "all" && /^(?:WITH wanted|SELECT digest,raw)/.test(sql))
              return (...args: unknown[]) =>
                (Reflect.apply(value, target, args) as unknown[]).reverse();
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      const byPath = new Map(captured.versions.map((v) => [v.path, v]));
      const values = await history.readVersions([
        byPath.get("D/D.md")!,
        byPath.get("A/A.md")!,
        byPath.get("C/C.md")!,
        byPath.get("B/B.md")!,
      ]);
      assert.ok(values[0] instanceof Error);
      assert.equal(values[0].message, `Damaged SQLite content: ${missing}`);
      assert.ok(!(values[1] instanceof Error));
      assert.equal(values[1]!.raw, "valid");
      for (const value of values.slice(2))
        assert.ok(value instanceof Error && value.message === `Damaged SQLite content: ${shared}`);
      assert.deepEqual(
        [...(await history.readDirectory(captured.commit!, "A"))],
        [["A/A.md", "valid"]],
      );
      await assert.rejects(history.readDirectory(captured.commit!), {
        message: `Damaged SQLite content: ${shared}`,
      });
      db.prepare("UPDATE blobs SET raw=? WHERE digest=?").run("shared", shared);
      await assert.rejects(history.readDirectory(captured.commit!), {
        message: `Damaged SQLite content: ${missing}`,
      });
    } finally {
      db.close();
    }
  });

test("metadata failure fallback retains event/path/raw error priority without poisoning valid requests", async (t) => {
  const { root, history } = await fixture(t);
  const captured = await history.captureUnlocked([
    { path: "A/A.md", raw: "valid" },
    { path: "B/B.md", raw: "damaged" },
  ]);
  const blobs = await history.documentBlobs(),
    damaged = blobs.get("B/B.md")!;
  const db = new DatabaseSync(path.join(root, ".git/history.sqlite"));
  db.prepare("UPDATE blobs SET raw=? WHERE digest=?").run("corrupt", damaged);
  db.close();
  const prepare = DatabaseSync.prototype.prepare;
  let changedOnBadRaw = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("WITH wanted")) throw new Error("Controlled bulk metadata failure");
    const statement = prepare.call(this, sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "all" && sql.startsWith("SELECT event FROM changes"))
          return (...args: unknown[]) => {
            if (args[0] === "B/B.md") {
              changedOnBadRaw++;
              throw new Error("Changed check preceded raw validation");
            }
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const values = await history.readVersions([
    { commit: "0".repeat(64), path: "../escape.md" },
    { commit: captured.commit!, path: "../escape.md" },
    captured.versions.find((v) => v.path === "B/B.md")!,
    captured.versions.find((v) => v.path === "A/A.md")!,
  ]);
  assert.deepEqual(
    values.slice(0, 3).map((v) => v instanceof Error && v.message),
    [
      `Unknown SQLite event: ${"0".repeat(64)}`,
      "Invalid history path: ../escape.md",
      `Damaged SQLite content: ${damaged}`,
    ],
  );
  assert.ok(!(values[3] instanceof Error));
  assert.equal(values[3]!.raw, "valid");
  assert.equal(changedOnBadRaw, 0);
});

for (const failedMetadata of [false, true])
  test(`version ${failedMetadata ? "fallback" : "bulk"} reads cap changedSince at the same frozen head`, async (t) => {
    const { root, history } = await fixture(t);
    const captured = await history.captureUnlocked([{ path: "Fact/Fact.md", raw: raw("old") }]);
    const before = (await history.documentBlobs()).get("Fact/Fact.md")!;
    const db = new DatabaseSync(path.join(root, ".git/history.sqlite"));
    try {
      const prepare = DatabaseSync.prototype.prepare;
      let appended = false,
        failed = false;
      t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        if (failedMetadata && !failed && sql.startsWith("WITH wanted")) {
          failed = true;
          throw new Error("Controlled bulk metadata failure");
        }
        const statement = prepare.call(this, sql);
        return new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "get" && sql === "SELECT MAX(seq) AS seq FROM events")
              return (...args: unknown[]) => {
                const row = Reflect.apply(value, target, args);
                if (!appended) {
                  appended = true;
                  const text = raw("new"),
                    digest = sqliteContentFingerprint(text);
                  const event = "f".repeat(64);
                  db.prepare("INSERT INTO blobs VALUES(?,?)").run(digest, text);
                  const seq = Number(
                    db
                      .prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)")
                      .run(
                        event,
                        captured.commit!,
                        new Date().toISOString(),
                        JSON.stringify({ operation: "document.capture" }),
                      ).lastInsertRowid,
                  );
                  db.prepare("INSERT INTO changes VALUES(?,?,?,?)").run(
                    seq,
                    "Fact/Fact.md",
                    before,
                    digest,
                  );
                  db.prepare("UPDATE current SET digest=?,event=? WHERE path=?").run(
                    digest,
                    seq,
                    "Fact/Fact.md",
                  );
                }
                return row;
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      const values = await history.readVersions(captured.versions);
      assert.ok(!(values[0] instanceof Error));
      assert.equal(values[0]!.raw, raw("old"));
      assert.equal(values[0]!.changedSince, false);
      const later = await history.readVersions(captured.versions);
      assert.ok(!(later[0] instanceof Error));
      assert.equal(later[0]!.changedSince, true);
    } finally {
      db.close();
    }
  });
