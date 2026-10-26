import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { importGitHistory } from "../src/fs/import-git-history.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { SqliteDocumentHistory } from "../src/core/store/sqlite-history.js";
import { createNode } from "../src/core/graph/ops.js";
import { startUiServer } from "../src/ui-server/server.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { openTestFs, openTestService, removeTestFixture } from "./node-fs.js";
import { git } from "./helpers.js";

async function inventory(root: string, prefix = ""): Promise<[string, string][]> {
  const rows: [string, string][] = [];
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) rows.push([file, "directory"], ...(await inventory(root, file)));
    else
      rows.push([
        file,
        createHash("sha256")
          .update(await fs.readFile(path.join(root, file)))
          .digest("hex"),
      ]);
  }
  return rows;
}

async function legacy(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-target-")),
    source = path.join(workspace, "source/.tent");
  t.after(() =>
    removeTestFixture(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await fs.mkdir(path.join(source, "Goal"), { recursive: true });
  await git(source, "init", "--quiet", "--initial-branch=main", "--template=");
  await git(source, "config", "core.autocrlf", "false");
  const raw = "---\nid: node-goal\ntype: prompt\n---\nRetained bytes\n";
  await fs.writeFile(path.join(source, "Goal/Goal.md"), raw);
  await git(source, "add", ".");
  await git(source, "commit", "--quiet", "-m", "legacy target boundary");
  return { workspace, source, raw };
}

test("migration rejects source and missing descendants before changing any source bytes", async (t) => {
  const { source } = await legacy(t),
    before = await inventory(source);
  for (const target of [source, path.join(source, "missing/target/.tent")]) {
    await assert.rejects(importGitHistory(source, target), /target must be separate/);
    assert.deepEqual(await inventory(source), before);
  }
});

test("migration rejects a case alias descendant before creating its target", async (t) => {
  const { workspace, source } = await legacy(t),
    alias = path.join(workspace, "SOURCE/.tent");
  if (
    !(await fs.stat(alias).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return false;
        throw e;
      },
    ))
  )
    return t.skip("This filesystem does not resolve the alternate-case fixture parent");
  const before = await inventory(source);
  await assert.rejects(
    importGitHistory(source, path.join(alias, "missing/.tent")),
    /target must be separate/,
  );
  assert.deepEqual(await inventory(source), before);
});

test("migration rejects a junction descendant but allows a separate target through a junction", async (t) => {
  const { workspace, source, raw } = await legacy(t),
    alias = path.join(workspace, "source-alias"),
    external = path.join(workspace, "external"),
    externalAlias = path.join(workspace, "external-alias");
  await fs.symlink(source, alias, "junction");
  const before = await inventory(source);
  await assert.rejects(
    importGitHistory(source, path.join(alias, "missing/.tent")),
    /target must be separate/,
  );
  assert.deepEqual(await inventory(source), before);
  await fs.mkdir(external);
  await fs.symlink(external, externalAlias, "junction");
  const target = path.join(externalAlias, "new/.tent"),
    imported = await importGitHistory(source, target),
    adapter = openTestFs(target);
  assert.equal(
    await adapter.history.read({ commit: imported.targetHead!, path: "Goal/Goal.md" }),
    raw,
  );
  await adapter.close();
  assert.deepEqual(await inventory(source), before);
});

test("migration accepts a separate sibling sharing the source name prefix", async (t) => {
  const { source, raw } = await legacy(t),
    before = await inventory(source),
    target = source + "-separate";
  const imported = await importGitHistory(source, target),
    adapter = openTestFs(target);
  assert.equal(
    await adapter.history.read({ commit: imported.targetHead!, path: "Goal/Goal.md" }),
    raw,
  );
  await adapter.close();
  assert.deepEqual(await inventory(source), before);
});

async function workspace(t: TestContext, beforeCleanup = () => {}) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-service-owner-"));
  t.after(async () => {
    beforeCleanup();
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await initializeFixtureWorkspace(root);
  const system = path.join(root, ".tent"),
    setup = openTestFs(system);
  await createNode(
    { fs: setup, clock: { now: () => new Date().toISOString() }, tentName: "Owner" },
    {
      id: "node-owner",
      name: "Owner",
      parentPath: "",
      type: "prompt",
      body: "published bytes",
    },
  );
  const head = await setup.history.currentCommit(),
    raw = await setup.readFile("Owner/Owner.md");
  await setup.close();
  return { root, system, head, raw };
}

for (const failure of ["occupied port", "invalid settings"] as const) {
  test(
    `Service startup releases a recovery-opened database after ${failure}`,
    { timeout: 20000 },
    async (t) => {
      const { root, system, head, raw } = await workspace(t);
      await fs.writeFile(
        path.join(system, ".git/tent-transaction.json"),
        JSON.stringify({
          version: 1,
          publish: head,
          entries: [
            {
              path: "Owner/Owner.md",
              before: null,
              after: { bytes: Buffer.from(raw).toString("base64") },
              versions: [null, { bytes: Buffer.from(raw).toString("base64") }],
            },
          ],
        }),
      );
      const holder = createServer();
      await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
      t.after(
        () =>
          new Promise<void>((resolve, reject) =>
            holder.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      const closed: NodeFs[] = [],
        close = NodeFs.prototype.close;
      t.mock.method(NodeFs.prototype, "close", async function (this: NodeFs) {
        await close.call(this);
        closed.push(this);
      });
      if (failure === "invalid settings")
        await fs.writeFile(path.join(system, "settings.json"), "{invalid}");
      await assert.rejects(
        startUiServer({
          workspaceRoot: root,
          staticDir: root,
          port: (holder.address() as AddressInfo).port,
        }),
        (error: NodeJS.ErrnoException) =>
          failure === "occupied port" ? error.code === "EADDRINUSE" : error instanceof SyntaxError,
      );
      assert.equal(closed.length, 1);
      await assert.rejects(closed[0]!.readFile("index.md"), /connection is closed/);
      assert.equal(await fs.readFile(path.join(system, "Owner/Owner.md"), "utf8"), raw);
      await assert.rejects(fs.access(path.join(system, ".git/tent-transaction.json")), {
        code: "ENOENT",
      });
      const database = path.join(system, ".git/history.sqlite");
      await fs.rename(database, database + ".closed");
      await fs.rename(database + ".closed", database);
    },
  );
}

for (const route of ["/api/revision", "/api/snapshot"] as const) {
  test(
    `Service close drains the accepted Core batch for ${route} after its socket disconnects`,
    { timeout: 20000 },
    async (t) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
          enter = resolve;
        }),
        blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
      const { root, system } = await workspace(t, () => release());
      const server = await openTestService({ workspaceRoot: root, staticDir: root, port: 0 });
      let active = false,
        finished = false;
      const errors: string[] = [],
        available = SqliteDocumentHistory.prototype.available;
      t.mock.method(
        SqliteDocumentHistory.prototype,
        "available",
        async function (this: SqliteDocumentHistory) {
          try {
            return await available.call(this);
          } catch (error) {
            if (this.systemRoot === system) errors.push(String(error));
            throw error;
          }
        },
      );
      const pause = async () => {
        if (!active) {
          active = true;
          enter();
          await blocked;
        }
      };
      if (route === "/api/revision") {
        const digest = NodeFs.prototype.readContentDigest;
        t.mock.method(
          NodeFs.prototype,
          "readContentDigest",
          async function (this: NodeFs, file: string) {
            if (this.workspaceRoot === root && file === "Owner/Owner.md" && !active) {
              await pause();
              try {
                return await digest.call(this, file);
              } finally {
                finished = true;
              }
            }
            return digest.call(this, file);
          },
        );
      } else {
        const read = NodeFs.prototype.readFile;
        t.mock.method(NodeFs.prototype, "readFile", async function (this: NodeFs, file: string) {
          if (this.workspaceRoot === root && file === "Owner/Owner.md" && !active) {
            await pause();
            try {
              return await read.call(this, file);
            } finally {
              finished = true;
            }
          }
          return read.call(this, file);
        });
      }
      const base = new URL(server.url),
        response = fetch(new URL(route, base), {
          headers: { Authorization: `Bearer ${base.hash.slice(7)}` },
          signal: t.signal,
        }).then(
          (r) => r.text(),
          () => "socket closed",
        );
      await Promise.race([
        entered,
        response.then(() => {
          throw new Error("Request ended before its Core boundary");
        }),
      ]);
      let closed = false;
      const closing = server.close().then(() => {
        closed = true;
      });
      try {
        await response;
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(finished, false);
        assert.equal(
          closed,
          false,
          "HTTP waiter ending must not close the adapter while Core is running",
        );
      } finally {
        release();
      }
      await closing;
      assert.equal(finished, true);
      assert.deepEqual(errors, []);
      const database = path.join(system, ".git/history.sqlite");
      await fs.rename(database, database + ".closed");
      await fs.rename(database + ".closed", database);
    },
  );
}
