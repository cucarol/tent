import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "../src/fs/sqlite-runtime.js";
import { SqliteDocumentHistory } from "../src/fs/sqlite-history.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { createCardDocument } from "../src/core/graph/card-document.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import { testScratchRoot, initializeFixtureHistory } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-open-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), { name: "Open boundary" });
  const system = path.join(root, ".tent"),
    adapter = openTestFs(system);
  await initializeFixtureHistory(system);
  const created = await createRoleContext(adapter, {
    roleId: "role-shared",
    title: "Shared",
    body: "initial",
  });
  return { root, system, adapter, created };
}

async function duringExclusive(t: TestContext, system: string, input: unknown) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/sqlite-open-child.ts", import.meta.url)),
      system,
      JSON.stringify(input),
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (b) => (stdout += b));
  child.stderr!.on("data", (b) => (stderr += b));
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Worker ${child.pid} exited ${code}: ${stderr}`)),
    );
  });
  void exited.catch(() => undefined);
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited.catch(() => undefined);
  });
  const message = (phase: string) =>
    new Promise<any>((resolve, reject) => {
      const handler = (value: any) => {
        if (value.phase === phase) {
          child.off("message", handler);
          resolve(value);
        }
      };
      child.on("message", handler);
      void exited.then(() => {
        child.off("message", handler);
        reject(new Error(`Worker ended before ${phase}: ${stderr}`));
      }, reject);
    });
  await message("ready");
  const db = new DatabaseSync(path.join(system, ".git/history.sqlite"));
  let released = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (!released) {
      db.exec("ROLLBACK");
      released = true;
    }
  };
  try {
    db.exec("BEGIN EXCLUSIVE");
    const attempting = message("attempting"),
      result = message("result");
    child.send("go");
    await attempting;
    timer = setTimeout(release, 250);
    const observed = await result;
    await exited;
    console.log(
      JSON.stringify({
        workerPid: child.pid,
        injection: "BEGIN EXCLUSIVE",
        releasedBeforeResult: released,
        stdout,
        stderr,
        ...observed,
      }),
    );
    return { ...observed, releasedBeforeResult: released, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    release();
    db.close();
  }
}

test(
  "fresh SQLite history opening waits before reading its format while a writer holds EXCLUSIVE",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      head = await f.adapter.history.currentCommit();
    const result = await duringExclusive(t, f.system, { kind: "read" });
    assert.equal(result.ok, true, result.stack);
    assert.equal(result.releasedBeforeResult, true);
    assert.equal(result.value, head);
    assert.equal(result.stderr, "");
  },
);

test(
  "fresh Role CLI opening waits for EXCLUSIVE then reports the original refusal",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    await createCardDocument(f.adapter, {
      cardId: "card-waiting",
      prompt: "Work",
      target: "role-shared",
    });
    const head = await f.adapter.history.currentCommit();
    const result = await duringExclusive(t, f.system, {
      kind: "write",
      workspace: f.root,
      args: ["role-shared"],
    });
    assert.equal(result.ok, true, result.stack);
    assert.equal(result.releasedBeforeResult, true);
    assert.equal(result.value.exitCode, 1);
    assert.match(result.value.stderr, /Role has unfinished Cards: card-waiting/);
    assert.doesNotMatch(result.value.stderr, /database is locked/);
    assert.equal(await f.adapter.exists(f.created.path), true);
    assert.equal(await f.adapter.history.currentCommit(), head);
    assert.match(await f.adapter.history.read(f.created.version!), /initial/);
  },
);

test("opening still rejects an unsupported format and releases its failed connection", async (t) => {
  const f = await fixture(t);
  await f.adapter.close();
  const file = path.join(f.system, ".git/history.sqlite"),
    db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=9");
  db.close();
  const history = new SqliteDocumentHistory(f.system);
  try {
    await assert.rejects(history.currentCommit(), /Unsupported Tent SQLite history format: 9/);
  } finally {
    await history.close();
  }
  await fs.rename(file, file + ".closed");
  await fs.rename(file + ".closed", file);
});
