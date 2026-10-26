import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { createNode } from "../src/core/graph/ops.js";
import { inspectNodeSync, confirmNodeSync } from "../src/core/graph/node-sync.js";
import { readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { exportGraph } from "../src/fs/graph-export.js";

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "record-version-"));
  await initializeFixtureWorkspace(workspace);
  const system = path.join(workspace, ".tent"),
    adapter = openTestFs(system);
  t.after(async () => {
    await adapter.close();
    await removeTestFixture(workspace, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    });
  });
  const env = {
    fs: adapter,
    clock: { now: () => "2026-10-27T00:00:00.000Z" },
    tentName: "Records",
  };
  async function importedRecords(records: Record<string, unknown>) {
    const db = new DatabaseSync(path.join(system, ".git/history.sqlite"));
    try {
      db.exec("PRAGMA synchronous=EXTRA;BEGIN IMMEDIATE");
      const head = db.prepare("SELECT id FROM events ORDER BY seq DESC LIMIT 1").get()?.id ?? null,
        id = randomBytes(32).toString("hex");
      const seq = Number(
        db
          .prepare("INSERT INTO events(id,parent,time,metadata) VALUES(?,?,?,?)")
          .run(
            id,
            head,
            new Date().toISOString(),
            JSON.stringify({ operation: "migration.records" }),
          ).lastInsertRowid,
      );
      for (const [key, value] of Object.entries(records))
        db.prepare("INSERT INTO records VALUES(?,?,?)").run(seq, key, JSON.stringify(value));
      db.exec("COMMIT");
      return id;
    } finally {
      db.close();
    }
  }
  return { workspace, system, adapter, env, importedRecords };
}

test("a migrated unknown record masks only its Node and cannot be restored by a retired cache", async (t) => {
  const { adapter, system, importedRecords } = await fixture(t),
    valid = { v: 1 as const, materials: [], extension: "current" };
  await adapter.history.captureUnlocked([], {
    operation: "test.records",
    nodeRecords: { "node-unknown": valid, "node-good": valid },
  });
  const head = await importedRecords({ "node-unknown": null });
  await fs.writeFile(
    path.join(system, ".git/tent-derived-node-records.json"),
    JSON.stringify({ head, value: { "node-unknown": valid } }),
  );
  assert.deepEqual(await adapter.history.nodeRecords(), {
    "node-unknown": null,
    "node-good": valid,
  });
});

test("record extension fields survive fresh readers and caller mutations stay isolated", async (t) => {
  const { adapter, system } = await fixture(t);
  const material = {
    identity: "portable",
    version: "a".repeat(64),
    fingerprintVersion: 2 as const,
    extension: { selection: "summary" },
    repository: { commonDir: "../repository/.git", path: "material.md", blob: "b".repeat(40) },
  };
  const record = {
    v: 1 as const,
    materials: [material],
    goals: [
      {
        nodeId: "node-goal",
        version: "c".repeat(64),
        fingerprintVersion: 2 as const,
        materials: [material],
        extension: ["ancestor"],
      },
    ],
    extension: { enabled: true },
  };
  await adapter.history.captureUnlocked([], {
    operation: "test.extensions",
    nodeRecords: { "node-extended": record },
  });
  const fresh = openTestFs(system);
  try {
    assert.deepEqual((await fresh.history.nodeRecords())["node-extended"], record);
    const values = await fresh.history.nodeRecords();
    values["node-extended"]!.extension = "caller mutation";
    assert.deepEqual((await fresh.history.nodeRecords())["node-extended"], record);
  } finally {
    await fresh.close();
  }
});

for (const resource of [undefined, "https://example.invalid/remote.md"]) {
  test(`unknown imported output stays unanchored through a metadata write and establishes a basis only on confirm (${resource ?? "no material"})`, async (t) => {
    const { adapter, env, importedRecords } = await fixture(t);
    const id = await createNode(env, {
      name: "Output",
      parentPath: "",
      type: "output",
      body: "old output",
      ...(resource ? { resource } : {}),
    });
    await importedRecords({ [id]: null });
    assert.equal((await inspectNodeSync(adapter, id)).state, "unanchored");
    await writeNodeDocument(adapter, id, {
      baseEtag: (await readNodeForEdit(adapter, id)).etag,
      frontmatter: { title: "metadata" },
    });
    assert.equal((await adapter.history.nodeRecords())[id], null);
    await confirmNodeSync(adapter, id, { baseEtag: (await readNodeForEdit(adapter, id)).etag });
    assert.equal((await adapter.history.nodeRecords())[id]!.v, 1);
  });
}

for (const identity of [
  "C:/private/file.md",
  "file:///private/file.md",
  JSON.stringify(["uri", "file://server/share/private.md"]),
]) {
  test(`capture rejects local machine paths and export audits imported records (${identity})`, async (t) => {
    const { workspace, system, adapter, env, importedRecords } = await fixture(t),
      record = {
        v: 1 as const,
        materials: [{ identity, version: "a".repeat(64), fingerprintVersion: 2 as const }],
      };
    await assert.rejects(
      adapter.history.captureUnlocked([], {
        operation: "test.private",
        nodeRecords: { "node-private": record },
      }),
      /local machine paths/,
    );
    await importedRecords({ "node-private": record });
    assert.equal((await adapter.history.nodeRecords())["node-private"], null);
    assert.deepEqual(await adapter.history.unportableNodeRecordIds(), ["node-private"]);
    const settings = JSON.parse(await adapter.readFile("settings.json"));
    await assert.rejects(
      exportGraph(
        { workspaceRoot: workspace, systemRoot: system, workspaceId: settings.workspaceId, env },
        { outputDir: "output/rejected" },
      ),
      /local machine paths/,
    );
  });
}
