import { openTestFs } from "./node-fs.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot } from "./scratch.js";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import { moveNode, renameNode, deleteNode } from "../src/core/graph/ops.js";
import { archiveNode } from "../src/core/graph/node-lifecycle.js";
import { TRANSACTION_PATH } from "../src/core/store/file-transaction.js";
import { editNode, readNodeFile, saveNodesBatch } from "./node-edit.js";
import { readNodeVersion } from "../src/core/read/node-version.js";

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
    adapter.history as import("../src/fs/sqlite-history.js").SqliteDocumentHistory
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
function batchInput() {
  return {
    items: Array.from({ length: 112 }, (_, i) => ({
      op: "create" as const,
      ref: `m${i}`,
      id: `node-m${String(i).padStart(3, "0")}`,
      name: `M${String(i).padStart(3, "0")}`,
      type: "prompt",
      body: `new ${i}\n`,
    })),
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

test("SQLite safety 1: native Markdown edits are retained exactly and unchanged peers keep their versions", async (t) => {
  const { adapter, root } = await fixture(t),
    before = (await adapter.history.pathVersions("N000/N000.md")).latest!,
    peer = await adapter.history.pathVersions("N001/N001.md");
  const raw = (await adapter.readFile("N000/N000.md")) + "NATIVE\n";
  await fs.writeFile(path.join(root, "N000/N000.md"), raw);
  assert.deepEqual((await captureNativeNodeEdits(adapter)).invalidNodes, []);
  const selected = await readNodeFile(adapter, "node-n000", { capture: true });
  assert.equal(selected.raw, raw);
  assert.equal(await adapter.history.read(selected.version!), raw);
  assert.match(await adapter.history.read(before), /old 0/);
  assert.deepEqual(await adapter.history.pathVersions("N001/N001.md"), peer);
});

test("SQLite safety 2: real Core write-many retains all 112 saved documents in one event", async (t) => {
  const { adapter, env } = await fixture(t),
    result = await saveNodesBatch(env, batchInput());
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

test("SQLite safety 3: retained versions read historical bytes and ABA stays changed", async (t) => {
  const { adapter, root, env } = await fixture(t);
  const source = { version: (await adapter.history.pathVersions("N000/N000.md")).latest! },
    old = { raw: await adapter.history.read(source.version) };
  await editNode(adapter, "node-n000", { body: "CURRENT\n" });
  assert.match((await readNodeFile(adapter, "node-n000")).body, /CURRENT/);
  assert.equal(await adapter.history.read(source.version), old.raw);
  assert.equal((await readNodeVersion(adapter, "node-n000", source.version)).text, old.raw);
  await fs.writeFile(path.join(root, "N000/N000.md"), old.raw);
  assert.deepEqual((await captureNativeNodeEdits(adapter)).invalidNodes, []);
  assert.equal(await adapter.history.changedSince(source.version), true);
  const archived = await archiveNode(env, "node-n002"),
    archivedRaw = await readNodeFile(adapter, "node-n002");
  await editNode(adapter, "node-n002", {
    body: "intervening",
  });
  await fs.writeFile(path.join(root, "N002/N002.md"), archivedRaw.raw);
  await captureNativeNodeEdits(adapter);
  assert.equal(
    await adapter.history.changedSince({ commit: archived.commit!, path: "N002/N002.md" }),
    true,
  );
  assert.equal(
    await adapter.history.read({ commit: archived.commit!, path: "N002/N002.md" }),
    archivedRaw.raw,
  );
  const reactivated = await editNode(adapter, "node-n002", {
    frontmatter: { status: "stable" },
  });
  assert.match(reactivated.raw, /status: stable/);
});

test("SQLite safety 4: file and database publication cuts settle whole groups and preserve external edits", async (t) => {
  for (const cut of [
    "file-replaced",
    "before-publication",
    "before-commit",
    "after-commit",
    "external-edit",
  ]) {
    const f = await fixture(t);
    // An existing order file is the batch's one replaced file, so its recovery is covered too.
    const priorOrder =
      JSON.stringify({
        __root__: Array.from({ length: 112 }, (_, i) => `node-n${String(i).padStart(3, "0")}`),
      }) + "\n";
    await f.adapter.writeFile("order.json", priorOrder);
    const priorHead = await f.adapter.history.currentCommit();
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
          path.join(f.root, "M000/M000.md"),
          "---\nid: node-m000\ntype: goal\n---\nEXTERNAL\n",
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
        const name = `M${String(i).padStart(3, "0")}`,
          file = `${name}/${name}.md`;
        if (cut === "after-commit")
          assert.match(
            (await readNodeFile(reopened, `node-m${name.slice(1)}`)).body,
            new RegExp(`new ${i}`),
          );
        else if (cut === "external-edit" && i === 0)
          assert.match(await reopened.readFile(file), /EXTERNAL/);
        else assert.equal(await reopened.exists(name), false, name);
        assert.match(
          (await readNodeFile(reopened, `node-n${name.slice(1)}`)).body,
          new RegExp(`old ${i}`),
        );
      }
      const order = JSON.parse(await reopened.readFile("order.json"));
      if (cut === "after-commit") {
        assert.notEqual(await reopened.history.currentCommit(), priorHead);
        assert.equal(order.__root__.filter((id: string) => id.startsWith("node-m")).length, 112);
      } else {
        assert.equal(await reopened.readFile("order.json"), priorOrder);
        assert.equal(await reopened.history.currentCommit(), priorHead);
      }
      assert.equal(await reopened.exists(TRANSACTION_PATH), false);
      if (cut === "external-edit")
        assert.deepEqual(reopened.recoveryConflicts, ["M000", "M000/M000.md"]);
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

test("SQLite safety 5: move, rename and deletion keep retained versions readable without showing history as current", async (t) => {
  const { adapter, env } = await fixture(t);
  const version = (await adapter.history.pathVersions("N000/N000.md")).latest!,
    fixed = { raw: await adapter.history.read(version) };
  await moveNode(env, "node-n000", "node-n001", { mode: "inside" });
  await renameNode(env, "node-n000", "Moved");
  assert.equal((await readNodeFile(adapter, "node-n000")).directory, "N001/Moved");
  assert.equal(await adapter.history.read(version), fixed.raw);
  await deleteNode(env, "node-n000");
  await assert.rejects(readNodeFile(adapter, "node-n000"), /Node not found/);
  assert.equal(await adapter.history.read(version), fixed.raw);
  assert.equal(
    (await adapter.retainedDocumentPaths())!.some((p) => p.includes("Moved/")),
    false,
  );
});
