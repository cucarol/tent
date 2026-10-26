import { openTestFs } from "./node-fs.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NodeFs } from "../src/fs/node-fs.js";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { readNode, readNodeForEdit } from "../src/core/read/node-query.js";
import { writeNodesBatch } from "../src/core/write/node-write-batch.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import {
  createCardDocument,
  readCardDocument,
  verifyCardSourceVersion,
} from "../src/core/graph/card-document.js";
import { moveNode, renameNode, deleteNode } from "../src/core/graph/ops.js";
import { archiveNode, restoreNode } from "../src/core/graph/node-lifecycle.js";
import type { DocumentVersion } from "../src/core/store/history-port.js";
import { TRANSACTION_PATH } from "../src/core/store/file-transaction.js";

async function fixture(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-safety-"));
  await scaffoldInWorkspace(openTestFs(workspace), {
    name: "Safety",
    nodes: Array.from({ length: 112 }, (_, i) => ({
      name: `N${String(i).padStart(3, "0")}`,
      id: `node-n${String(i).padStart(3, "0")}`,
      type: i === 0 ? "goal" : "prompt",
      body: `old ${i}\n`,
    })),
  });
  const root = path.join(workspace, ".tent"),
    adapter = openTestFs(root),
    env = { fs: adapter, clock: { now: () => "2026-10-27T00:00:00.000Z" }, tentName: "Safety" };
  await (
    adapter.history as import("../src/core/store/sqlite-history.js").SqliteDocumentHistory
  ).initialize();
  const selected = await Promise.all(
    Array.from({ length: 112 }, async (_, i) => {
      const file = `N${String(i).padStart(3, "0")}/N${String(i).padStart(3, "0")}.md`;
      return { path: file, raw: await adapter.readFile(file) };
    }),
  );
  await adapter.withLock("mutation.lock", () => adapter.history.captureUnlocked(selected));
  t.after(async () => {
    await adapter.close();
  });
  return { workspace, root, adapter, env };
}
async function batchInput(adapter: NodeFs) {
  return {
    items: await Promise.all(
      Array.from({ length: 112 }, async (_, i) => {
        const nodeId = `node-n${String(i).padStart(3, "0")}`;
        return {
          op: "update" as const,
          nodeId,
          baseEtag: (await readNodeForEdit(adapter, nodeId)).etag,
          body: `new ${i}\n`,
        };
      }),
    ),
  };
}
function child(args: string[], ipc = false) {
  const process = spawn(globalThis.process.execPath, args, {
    windowsHide: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  process.stdout!.on("data", (b) => (stdout += b));
  process.stderr!.on("data", (b) => (stderr += b));
  const done = new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve) =>
    process.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { process, done };
}

test("SQLite safety 1: native Markdown edits are retained exactly and selected reads do not capture peers", async (t) => {
  const { adapter, root } = await fixture(t),
    before = (await adapter.history.pathVersions("N000/N000.md")).latest!,
    peer = await adapter.history.pathVersions("N001/N001.md");
  const raw = (await adapter.readFile("N000/N000.md")) + "NATIVE\n";
  await fs.writeFile(path.join(root, "N000/N000.md"), raw);
  assert.deepEqual((await captureNativeNodeEdits(adapter)).invalidNodes, []);
  const selected = await readNodeForEdit(adapter, "node-n000", { capture: true });
  assert.equal(selected.raw, raw);
  assert.equal(await adapter.history.read(selected.version!), raw);
  assert.match(await adapter.history.read(before), /old 0/);
  assert.deepEqual(await adapter.history.pathVersions("N001/N001.md"), peer);
});

test("SQLite safety 2: real Core write-many retains all 112 saved documents in one event", async (t) => {
  const { adapter, env } = await fixture(t),
    result = await writeNodesBatch(env, await batchInput(adapter));
  assert.equal(result.results.length, 112);
  const event = (await adapter.history.changesInRange({ to: result.commit })).at(-1)!;
  assert.equal(event.operation, "node.write-many");
  assert.equal(event.changes.length, 112);
  const versions = result.results.map((r) => ({
    commit: result.commit!,
    path: `${r.path}/${path.posix.basename(r.path)}.md`,
  }));
  const retained = await adapter.history.readVersions(versions);
  for (let i = 0; i < versions.length; i++) {
    const saved = retained[i]!;
    assert.ok(!(saved instanceof Error));
    assert.equal(saved.raw, await adapter.readFile(versions[i]!.path));
  }
});

test("SQLite safety 3: Card pins read historical bytes, ABA stays changed and archive undo rejects later edits", async (t) => {
  const { adapter, root, env } = await fixture(t),
    card = await createCardDocument(adapter, {
      cardId: "card-safety",
      prompt: "fixed input",
      sources: [{ resource: "../N000/N000.md" }],
    });
  const page = await readCardDocument(adapter, card.cardId),
    source = (page.sources as { resource: string; version: DocumentVersion }[])[0]!,
    old = await verifyCardSourceVersion(adapter, card.path, source);
  await writeNodeDocument(adapter, "node-n000", {
    baseEtag: (await readNodeForEdit(adapter, "node-n000")).etag,
    body: "CURRENT\n",
  });
  assert.match((await readNodeForEdit(adapter, "node-n000")).body, /CURRENT/);
  assert.equal((await verifyCardSourceVersion(adapter, card.path, source)).raw, old.raw);
  const historical = await readNode(adapter, "ws-safety", {
    nodeId: "node-n000",
    version: source.version,
    view: "raw",
  });
  assert.ok("text" in historical.node);
  assert.equal(historical.node.text, old.raw);
  await fs.writeFile(path.join(root, "N000/N000.md"), old.raw);
  assert.deepEqual((await captureNativeNodeEdits(adapter)).invalidNodes, []);
  assert.equal(await adapter.history.changedSince(source.version), true);
  const archived = await archiveNode(env, "node-n002"),
    archivedRaw = await readNodeForEdit(adapter, "node-n002");
  await writeNodeDocument(adapter, "node-n002", {
    baseEtag: archivedRaw.etag,
    body: "intervening",
  });
  await fs.writeFile(path.join(root, "N002/N002.md"), archivedRaw.raw);
  await captureNativeNodeEdits(adapter);
  await assert.rejects(
    restoreNode(env, "node-n002", archived.commit!),
    /conflicts with later edits/,
  );
});

test("SQLite safety 4: two independent CLI writers share the same ETag conflict boundary", async (t) => {
  const { adapter, workspace } = await fixture(t),
    base = await readNodeForEdit(adapter, "node-n000"),
    entry = fileURLToPath(new URL("../src/cli/tent.ts", import.meta.url));
  const workers = ["one", "two"].map((name) =>
    child([
      "--import",
      "tsx",
      entry,
      "node",
      "write",
      "node-n000",
      "--base-etag",
      base.etag,
      "--body",
      `writer ${name}`,
      "--workspace",
      workspace,
      "--json",
    ]),
  );
  const results = await Promise.all(workers.map((w) => w.done));
  assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.code === 1).length, 1, JSON.stringify(results));
  assert.match(results.find((r) => r.code === 1)!.stderr, /etag conflict/i);
  for (const result of results)
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  const latest = await readNodeForEdit(adapter, "node-n000", { capture: true });
  assert.match(latest.body, /writer (one|two)/);
  assert.equal(await adapter.history.read(latest.version!), latest.raw);
});

test("SQLite safety 5: file and database publication cuts settle whole groups and preserve external edits", async (t) => {
  for (const cut of [
    "file-replaced",
    "before-publication",
    "before-commit",
    "after-commit",
    "external-edit",
  ]) {
    const f = await fixture(t);
    await f.adapter.close();
    const point = cut === "external-edit" ? "file-replaced" : cut,
      entry = fileURLToPath(new URL("./fixtures/sqlite-safety-child.ts", import.meta.url)),
      worker = child(["--import", "tsx", entry, f.workspace, point], true);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error(`Checkpoint timeout: ${cut}`)), 60000);
        worker.process.once("message", (message) => {
          clearTimeout(timeout);
          assert.equal((message as { point: string }).point, point);
          resolve();
        });
        worker.process.once("close", async (code) => {
          clearTimeout(timeout);
          const outcome = await worker.done;
          reject(Error(`Exited before checkpoint (${code}): ${cut}: ${JSON.stringify(outcome)}`));
        });
      });
      if (cut === "external-edit")
        await fs.writeFile(
          path.join(f.root, "N000/N000.md"),
          "---\nid: node-n000\ntype: goal\n---\nEXTERNAL\n",
        );
      worker.process.kill("SIGKILL");
      const outcome = await worker.done;
      assert.equal(outcome.signal, "SIGKILL");
      assert.doesNotMatch(outcome.stderr, /SQLite is an experimental feature/);
    } finally {
      if (worker.process.exitCode === null) worker.process.kill("SIGKILL");
      await worker.done;
    }
    const reopened = openTestFs(f.root);
    try {
      await reopened.ready();
      for (let i = 0; i < 112; i++) {
        const body = (await readNodeForEdit(reopened, `node-n${String(i).padStart(3, "0")}`)).body;
        assert.match(
          body,
          new RegExp(
            cut === "external-edit" && i === 0
              ? "EXTERNAL"
              : `${cut === "after-commit" ? "new" : "old"} ${i}`,
          ),
        );
      }
      assert.equal(await reopened.exists(TRANSACTION_PATH), false);
      if (cut === "external-edit") assert.deepEqual(reopened.recoveryConflicts, ["N000/N000.md"]);
    } finally {
      await reopened.close();
    }
    const db = new DatabaseSync(path.join(f.root, ".git/history.sqlite"));
    try {
      assert.deepEqual(
        db
          .prepare("PRAGMA integrity_check")
          .all()
          .map((r) => r.integrity_check),
        ["ok"],
      );
    } finally {
      db.close();
    }
  }
});

test("SQLite safety 6: move, rename and deletion retain old pin addresses without showing history as current", async (t) => {
  const { adapter, env } = await fixture(t),
    card = await createCardDocument(adapter, {
      cardId: "card-move",
      prompt: "fixed input",
      sources: [{ resource: "../N000/N000.md" }],
    }),
    page = await readCardDocument(adapter, card.cardId),
    source = (page.sources as { resource: string; version: DocumentVersion }[])[0]!,
    fixed = await verifyCardSourceVersion(adapter, card.path, source);
  await moveNode(env, "node-n000", "node-n001", { mode: "inside" });
  await renameNode(env, "node-n000", "Moved");
  assert.equal((await readNodeForEdit(adapter, "node-n000")).path, "N001/Moved");
  assert.equal((await verifyCardSourceVersion(adapter, card.path, source)).raw, fixed.raw);
  await deleteNode(env, "node-n000");
  await assert.rejects(readNodeForEdit(adapter, "node-n000"), /Node not found/);
  assert.equal((await verifyCardSourceVersion(adapter, card.path, source)).raw, fixed.raw);
  assert.equal(
    (await adapter.retainedDocumentPaths())!.some((p) => p.includes("Moved/")),
    false,
  );
});
