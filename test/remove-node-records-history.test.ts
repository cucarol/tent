import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { SqliteDocumentHistory } from "../src/fs/sqlite-history.js";
import { importGitHistory } from "../src/fs/import-git-history.js";

const { removeNodeRecordsHistory } = await import(
  new URL("../scripts/one-off/remove-node-records-history.mjs", import.meta.url).href
);

async function fixture(t: TestContext) {
  const scratch = fileURLToPath(new URL("../.scratch/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(scratch, "remove-records-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, ".tent");
  const history = new SqliteDocumentHistory(root);
  await history.initialize();
  const old = "---\nid: node-alpha\ntype: prompt\nverified:\n  by: human:cuca\n---\nOld\n";
  const next = old.replace("Old\n", "New\n");
  const first = (await history.captureUnlocked([{ path: "Alpha/Alpha.md", raw: old }])).commit!;
  const card = `---\nid: card-pin\ntype: card\nsources:\n  - resource: ../Alpha/Alpha.md\n    version: {commit: ${first}, path: Alpha/Alpha.md}\n---\nPinned\n`;
  const second = (
    await history.captureUnlocked([
      { path: "Alpha/Alpha.md", raw: next },
      { path: "cards/card-pin.md", raw: card },
    ])
  ).commit!;
  await history.close();
  await fs.mkdir(path.join(root, "Alpha"));
  await fs.writeFile(path.join(root, "Alpha/Alpha.md"), next);
  await fs.mkdir(path.join(root, "cards"));
  await fs.writeFile(path.join(root, "cards/card-pin.md"), card);
  return {
    workspace,
    root,
    filename: path.join(root, ".git/history.sqlite"),
    first,
    second,
    old,
    next,
    card,
  };
}

async function files(root: string) {
  const result = new Map();
  for (const relative of await fs.readdir(root, { recursive: true })) {
    const filename = path.join(root, relative);
    const stat = await fs.stat(filename, { bigint: true });
    if (stat.isFile())
      result.set(relative, {
        bytes: await fs.readFile(filename),
        mtime: stat.mtimeNs,
        ctime: stat.ctimeNs,
      });
  }
  return result;
}

function downgrade(filename: string) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA user_version=1;
    CREATE TABLE records(event INTEGER NOT NULL REFERENCES events(seq),id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(event,id)) STRICT;
    CREATE TABLE unportable_records(id TEXT PRIMARY KEY) STRICT;
  `);
  return db;
}

test("format 2 retains document history and rebuilds a format 1 disposable index without records", async (t) => {
  const f = await fixture(t);
  const index = path.join(f.root, ".git/tent-material-cache/history-index.sqlite");
  await fs.mkdir(path.dirname(index), { recursive: true });
  const stale = new DatabaseSync(index);
  stale.exec("CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=1");
  stale.close();
  const history = new SqliteDocumentHistory(f.root);
  try {
    assert.equal("nodeRecords" in history, false);
    assert.equal("unportableNodeRecordIds" in history, false);
    assert.equal(await history.read({ commit: f.first, path: "Alpha/Alpha.md" }), f.old);
    assert.equal(await history.read({ commit: f.second, path: "cards/card-pin.md" }), f.card);
    assert.match(
      await history.diff(
        { commit: f.first, path: "Alpha/Alpha.md" },
        { commit: f.second, path: "Alpha/Alpha.md" },
      ),
      /-Old\n\+New/,
    );
    assert.equal((await history.nodeVersions("node-alpha")).length, 2);
    assert.equal((await history.identityVersions()).first["node-alpha"].commit, f.first);
    assert.deepEqual(
      await history.firstCommitTimes(["Alpha/Alpha.md"]),
      new Map([["Alpha/Alpha.md", (await history.changesInRange())[0].time]]),
    );
    assert.equal(
      (await history.captureUnlocked([{ path: "Alpha/Alpha.md", raw: f.next }])).created,
      false,
    );
  } finally {
    await history.close();
  }
  for (const filename of [f.filename, index]) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 2);
      assert.deepEqual(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE name IN ('records','unportable_records')")
          .all(),
        [],
      );
    } finally {
      db.close();
    }
  }
});

test("record scrub preserves immutable events, other metadata, originals, pins and verified; second run writes nothing", async (t) => {
  const f = await fixture(t);
  const db = downgrade(f.filename);
  const recordOnly = "c".repeat(64);
  const marker = "retired-local-machine-path-C:/must-disappear";
  let expectedEvents: unknown[], expectedDocuments: unknown[];
  const auditOriginal = Buffer.from(f.old);
  try {
    const metadata = JSON.stringify({
      operation: "node.confirm",
      entry: "core",
      objectIds: ["node-alpha"],
      nodeRecords: { "node-alpha": { marker } },
      extension: { verified: "keep", nodeRecords: "nested-keep" },
    });
    const seq = db
      .prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)")
      .run(recordOnly, f.second, "2026-11-03T00:00:00.000Z", metadata).lastInsertRowid;
    db.prepare("INSERT INTO records VALUES(?,?,?)").run(
      seq,
      "node-alpha",
      JSON.stringify({ marker }),
    );
    db.prepare("INSERT INTO unportable_records VALUES(?)").run("node-alpha");
    db.exec(
      "CREATE TABLE migration_events(event TEXT PRIMARY KEY,message TEXT NOT NULL) STRICT; CREATE TABLE migration_originals(event TEXT NOT NULL,path TEXT NOT NULL,raw BLOB NOT NULL,PRIMARY KEY(event,path)) STRICT;",
    );
    db.prepare("INSERT INTO migration_events VALUES(?,?)").run(
      f.first,
      `Subject\r\n\r\nTent-Node-Record: ["node-alpha",{"marker":"${marker}"}]\r\nTent-Operation: node.confirm\r\nMention Tent-Node-Record: keep prose\r\n`,
    );
    db.prepare("INSERT INTO migration_originals VALUES(?,?,?)").run(
      f.first,
      "Alpha/Alpha.md",
      auditOriginal,
    );
    expectedEvents = db
      .prepare("SELECT * FROM events ORDER BY seq")
      .all()
      .map((row) => {
        const clean = JSON.parse(String(row.metadata));
        if (Object.prototype.hasOwnProperty.call(clean, "nodeRecords")) {
          delete clean.nodeRecords;
          row.metadata = JSON.stringify(clean);
        }
        return row;
      });
    expectedDocuments = ["blobs", "changes", "current"].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
  } finally {
    db.close();
  }
  const index = path.join(f.root, ".git/tent-material-cache/history-index.sqlite");
  await fs.mkdir(path.dirname(index), { recursive: true });
  await fs.writeFile(index, marker);
  const originalLive = await fs.readFile(path.join(f.root, "Alpha/Alpha.md"));
  assert.deepEqual(await removeNodeRecordsHistory(f.workspace), {
    changed: true,
    metadata: 1,
    trailers: 1,
    records: 1,
    unportableRecords: 1,
  });
  await assert.rejects(fs.access(index), { code: "ENOENT" });
  assert.equal((await fs.readFile(f.filename)).includes(Buffer.from(marker)), false);
  assert.deepEqual(await fs.readFile(path.join(f.root, "Alpha/Alpha.md")), originalLive);
  const audit = new DatabaseSync(f.filename, { readOnly: true });
  try {
    assert.deepEqual(audit.prepare("SELECT * FROM events ORDER BY seq").all(), expectedEvents);
    assert.deepEqual(
      ["blobs", "changes", "current"].map((table) => audit.prepare(`SELECT * FROM ${table}`).all()),
      expectedDocuments,
    );
    assert.deepEqual(
      Buffer.from(audit.prepare("SELECT raw FROM migration_originals").get()!.raw as Uint8Array),
      auditOriginal,
    );
    assert.equal(
      audit.prepare("SELECT message FROM migration_events").get()!.message,
      "Subject\r\n\r\nTent-Operation: node.confirm\r\nMention Tent-Node-Record: keep prose\r\n",
    );
  } finally {
    audit.close();
  }
  const history = new SqliteDocumentHistory(f.root);
  try {
    assert.equal(await history.currentCommit(), recordOnly);
    assert.deepEqual((await history.changesInRange()).at(-1)!.changes, []);
    assert.equal(await history.read({ commit: f.first, path: "Alpha/Alpha.md" }), f.old);
    assert.equal(await history.read({ commit: f.second, path: "cards/card-pin.md" }), f.card);
    assert.match(
      await history.diff(
        { commit: f.first, path: "Alpha/Alpha.md" },
        { commit: f.second, path: "Alpha/Alpha.md" },
      ),
      /-Old\n\+New/,
    );
  } finally {
    await history.close();
  }
  const beforeRepeat = await files(f.root);
  assert.deepEqual(await removeNodeRecordsHistory(f.workspace), {
    changed: false,
    metadata: 0,
    trailers: 0,
    records: 0,
    unportableRecords: 0,
  });
  assert.deepEqual(await files(f.root), beforeRepeat);
});

test("product reads and initialize refuse format 1 without upgrading or rewriting it", async (t) => {
  const f = await fixture(t);
  downgrade(f.filename).close();
  const before = await files(f.root);
  for (const action of ["currentCommit", "initialize"] as const) {
    const history = new SqliteDocumentHistory(f.root);
    try {
      await assert.rejects(history[action](), {
        message:
          "Tent history format 1 must be converted offline: from a Tent checkout, run node scripts/one-off/remove-node-records-history.mjs <workspaceRoot>",
      });
    } finally {
      await history.close();
    }
  }
  assert.deepEqual(await files(f.root), before);
});

test("failed copied-database conversion leaves source files intact and removes its temporary copy", async (t) => {
  const f = await fixture(t);
  const db = downgrade(f.filename);
  db.exec("DROP TABLE unportable_records");
  db.close();
  const before = await files(f.root);
  await assert.rejects(removeNodeRecordsHistory(f.workspace), /no such table: unportable_records/);
  assert.deepEqual(await files(f.root), before);
});

test("scrub rejects unsettled writes and unsupported versions before changing any files", async (t) => {
  const f = await fixture(t);
  downgrade(f.filename).close();
  for (const pending of [
    "mutation.lock",
    ".git/tent-transaction.json",
    ".git/history.sqlite-journal",
  ]) {
    const filename = path.join(f.root, pending);
    await fs.writeFile(filename, "pending");
    const before = await files(f.root);
    await assert.rejects(
      removeNodeRecordsHistory(f.workspace),
      /settle pending operations|settle its journal/,
    );
    assert.deepEqual(await files(f.root), before);
    await fs.unlink(filename);
  }
  const db = new DatabaseSync(f.filename);
  db.exec("PRAGMA user_version=9");
  db.close();
  const before = await files(f.root);
  await assert.rejects(
    removeNodeRecordsHistory(f.workspace),
    /Unsupported Tent SQLite history format: 9/,
  );
  assert.deepEqual(await files(f.root), before);
});

test("document capture rollback and compare-and-swap still protect the publication boundary", async (t) => {
  const f = await fixture(t);
  const failed = new SqliteDocumentHistory(f.root, "core", async (point) => {
    if (point === "before-commit") throw new Error("cut before commit");
  });
  try {
    await assert.rejects(
      failed.captureUnlocked([{ path: "Alpha/Alpha.md", raw: f.old }]),
      /cut before commit/,
    );
    assert.equal(await failed.currentCommit(), f.second);
    assert.equal((await failed.readDirectory(f.second)).get("Alpha/Alpha.md"), f.next);
  } finally {
    await failed.close();
  }
  const competing = new SqliteDocumentHistory(f.root);
  const stale = new SqliteDocumentHistory(f.root);
  try {
    await assert.rejects(
      stale.withPublicationObserver(
        {
          before: async () => {
            await competing.captureUnlocked([{ path: "Alpha/Alpha.md", raw: f.old }]);
          },
          after: async () => {},
        },
        () => stale.captureUnlocked([{ path: "Alpha/Alpha.md", raw: f.old + "stale" }]),
      ),
      /changed during capture/,
    );
    assert.equal(
      (await stale.readDirectory((await stale.currentCommit())!)).get("Alpha/Alpha.md"),
      f.old,
    );
  } finally {
    await stale.close();
    await competing.close();
  }
});

test("legacy Git import retains document versions and Card pins while discarding record trailers", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.workspace, "legacy/.tent");
  const target = path.join(f.workspace, "imported/.tent");
  await fs.mkdir(path.join(source, "Alpha"), { recursive: true });
  const execute = promisify(execFile);
  const git = async (...args: string[]) =>
    (
      await execute("git", ["-C", source, ...args], {
        windowsHide: true,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
        ),
      })
    ).stdout.trim();
  const commit = async (message: string) => {
    await git("add", "--all");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "core.autocrlf", "false");
  await fs.writeFile(path.join(source, "Alpha/Alpha.md"), f.old);
  const first = await commit(
    'Original subject\n\nTent-Node-Record: ["node-alpha",{"local":"C:/retired"}]\nTent-Operation: node.confirm',
  );
  await fs.writeFile(path.join(source, "Alpha/Alpha.md"), f.next);
  await fs.mkdir(path.join(source, "cards"));
  const card = f.card.replace(f.first, first);
  await fs.writeFile(path.join(source, "cards/card-pin.md"), card);
  const second = await commit("Current subject");
  const result = await importGitHistory(source, target);
  const imported = new SqliteDocumentHistory(target);
  try {
    assert.equal(
      await imported.read({ commit: result.mapping[first], path: "Alpha/Alpha.md" }),
      f.old,
    );
    assert.equal(
      await imported.read({ commit: result.mapping[second], path: "cards/card-pin.md" }),
      card.replace(first, result.mapping[first]),
    );
    assert.match(
      await imported.diff(
        { commit: result.mapping[first], path: "Alpha/Alpha.md" },
        { commit: result.mapping[second], path: "Alpha/Alpha.md" },
      ),
      /-Old\n\+New/,
    );
  } finally {
    await imported.close();
  }
  assert.equal(await fs.readFile(path.join(source, "cards/card-pin.md"), "utf8"), card);
  const audit = new DatabaseSync(path.join(target, ".git/history.sqlite"), { readOnly: true });
  try {
    assert.equal(audit.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.deepEqual(
      audit
        .prepare("SELECT name FROM sqlite_schema WHERE name IN ('records','unportable_records')")
        .all(),
      [],
    );
    const message = String(
      audit
        .prepare("SELECT message FROM migration_events WHERE event=?")
        .get(result.mapping[first])!.message,
    );
    assert.equal(message.includes("Tent-Node-Record:"), false);
    assert.match(message, /Original subject\n\nTent-Operation: node.confirm/);
    assert.deepEqual(
      Buffer.from(
        audit
          .prepare("SELECT raw FROM migration_originals WHERE event=? AND path=?")
          .get(result.mapping[first], "Alpha/Alpha.md")!.raw as Uint8Array,
      ),
      Buffer.from(f.old),
    );
  } finally {
    audit.close();
  }
});
