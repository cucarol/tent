import { openTestService } from "./node-fs.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { startUiServer } from "../src/ui-server/server.js";
import { createNode } from "../src/core/graph/ops.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

test(
  "a read racing an independent CLI replacement reports SOURCE_CHANGED, then a fresh request reads exact saved bytes",
  { timeout: 30000 },
  async (t) => {
    const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-http-race-"));
    let release = () => {};
    t.after(async () => {
      release();
      await removeTestFixture(workspace, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 200,
      });
    });
    await initializeFixtureWorkspace(workspace);
    const root = path.join(workspace, ".tent"),
      setup = openTestFs(root);
    await createNode(
      { fs: setup, clock: { now: () => new Date().toISOString() }, tentName: "Race" },
      {
        id: "node-race",
        name: "Race",
        parentPath: "",
        type: "prompt",
        body: "old",
      },
    );
    await setup.close();
    const server = await openTestService({
        workspaceRoot: workspace,
        staticDir: workspace,
        port: 0,
      }),
      base = new URL(server.url),
      headers = { Authorization: `Bearer ${base.hash.slice(7)}` },
      get = () => fetch(new URL("/api/nodes/node-race", base), { headers, signal: t.signal });
    const initial = await get();
    assert.equal(initial.status, 200);
    const page = (await initial.json()) as { etag: string };
    const filename = path.join(root, "Race/Race.md");
    // A racy timestamp forces a validated prefix read instead of a prior state hit.
    await fs.utimes(filename, new Date(), new Date());
    let enter!: () => void,
      armed = true;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      original = nodeFs.promises.open;
    t.mock.method(nodeFs.promises, "open", async (...args: Parameters<typeof original>) => {
      const handle = await Reflect.apply(original, nodeFs.promises, args);
      if (armed && String(args[0]) === filename) {
        armed = false;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          enter();
          await blocked;
        };
      }
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const raced = get();
    await Promise.race([
      entered,
      raced.then(() => {
        throw new Error("Read ended before its controlled observation boundary");
      }),
    ]);
    const cli = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli/tent.ts", import.meta.url)),
        "node",
        "write",
        "node-race",
        "--base-etag",
        page.etag,
        "--body",
        "new",
        "--workspace",
        workspace,
        "--json",
      ],
      { windowsHide: true, signal: t.signal },
    );
    const receipt = JSON.parse(cli.stdout) as {
      etag: string;
      version: { commit: string; path: string };
    };
    release();
    const response = await raced,
      error = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(response.status, 409, JSON.stringify(error));
    assert.equal(error.error.code, "SOURCE_CHANGED");
    const next = await get(),
      fresh = (await next.json()) as { body: string; etag: string };
    assert.equal(next.status, 200, JSON.stringify(fresh));
    assert.equal(fresh.body, "new");
    assert.equal(fresh.etag, receipt.etag);
    assert.notEqual(fresh.etag, page.etag);
    const after = openTestFs(root);
    assert.equal(await after.history.read(receipt.version), await fs.readFile(filename, "utf8"));
    assert.equal(await after.history.currentCommit(), receipt.version.commit);
    t.diagnostic(
      JSON.stringify({ racedStatus: response.status, error, nextStatus: next.status, cliExit: 0 }),
    );
  },
);

test(
  "a real Web service stays fresh through independent CLI writes and releases its database on close",
  { timeout: 120000 },
  async (t) => {
    const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-service-"));
    t.after(() =>
      removeTestFixture(workspace, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 200,
      }),
    );
    await initializeFixtureWorkspace(workspace);
    const root = path.join(workspace, ".tent"),
      setup = openTestFs(root);
    try {
      await createNode(
        { fs: setup, clock: { now: () => new Date().toISOString() }, tentName: "Service" },
        { id: "node-service", name: "Service", parentPath: "", type: "prompt", body: "initial" },
      );
    } finally {
      await setup.close();
    }
    const server = await openTestService({
        workspaceRoot: workspace,
        staticDir: workspace,
        port: 0,
      }),
      base = new URL(server.url),
      headers = {
        Authorization: `Bearer ${base.hash.slice("#token=".length)}`,
        Origin: base.origin,
      };
    let stopped = false,
      reads = 0,
      phase = "initial";
    const sourceChanges: { at: string; phase: string; code: string; message: string }[] = [];
    const request = () =>
      fetch(new URL("/api/nodes/node-service", base), {
        headers,
        signal: t.signal,
      });
    const read = async () => {
      const response = await request(),
        payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload as { body: string; etag: string };
    };
    const polling = (async () => {
      while (!stopped) {
        const observedPhase = phase;
        const response = await request(),
          payload = (await response.json()) as {
            error?: { code?: string; message?: string };
          };
        if (response.status === 409 && payload.error?.code === "SOURCE_CHANGED") {
          // No fact was read. Surface this observation's failure; the next scheduled
          // poll starts a fresh request, as the UI does after a failed read.
          const failure = {
            at: new Date().toISOString(),
            phase: observedPhase,
            code: payload.error.code,
            message: payload.error.message ?? "",
          };
          sourceChanges.push(failure);
          t.diagnostic(JSON.stringify({ rejectedPollingRead: failure }));
        } else {
          assert.equal(response.status, 200, JSON.stringify({ phase, payload }));
          reads++;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
    })();
    // Observe rejection immediately; awaiting the original promise below still fails
    // the test, after releasing its service even when a background read failed.
    void polling.catch(() => undefined);
    const start = Date.now(),
      entry = fileURLToPath(new URL("../src/cli/tent.ts", import.meta.url));
    const cli = (etag: string, body: string) =>
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          entry,
          "node",
          "write",
          "node-service",
          "--base-etag",
          etag,
          "--body",
          body,
          "--workspace",
          workspace,
          "--json",
        ],
        { windowsHide: true, signal: t.signal },
      );
    try {
      for (let i = 0; i < 12; i++) {
        phase = `CLI revision ${i}`;
        const before = await read(),
          result = await cli(before.etag, `CLI revision ${i}`);
        assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
        assert.equal((await read()).body, `CLI revision ${i}`);
      }
      const shared = await read();
      phase = "CAS contenders";
      const contenders = await Promise.allSettled([
        cli(shared.etag, "CLI contender"),
        fetch(new URL("/api/nodes/node-service", base), {
          method: "PUT",
          signal: t.signal,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ baseEtag: shared.etag, body: "Web contender" }),
        }).then(async (response) => ({ status: response.status, text: await response.text() })),
      ]);
      const first = contenders[0]!,
        second = contenders[1]!;
      assert.equal(second.status, "fulfilled");
      if (first.status === "fulfilled") {
        assert.equal(second.value.status, 409, second.value.text);
        assert.equal((await read()).body, "CLI contender");
      } else {
        assert.equal(second.value.status, 200, second.value.text);
        assert.equal((await read()).body, "Web contender");
        assert.match(String((first.reason as { stderr?: string }).stderr), /etag conflict/i);
      }
      phase = "quiet after writers";
      const settled = await read();
      const remaining = 30000 - (Date.now() - start);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      const quiet = await read();
      assert.deepEqual(
        { body: quiet.body, etag: quiet.etag },
        { body: settled.body, etag: settled.etag },
      );
      assert.ok(reads > 30, `Only ${reads} successful background requests`);
    } finally {
      stopped = true;
      try {
        await polling;
      } finally {
        await server.close();
        await server.closed;
      }
    }
    // Windows refuses these operations while SQLite still owns a non-delete-shared handle.
    const database = path.join(root, ".git/history.sqlite"),
      moved = database + ".closed";
    await fs.rename(database, moved);
    await fs.rename(moved, database);
    const after = openTestFs(root);
    try {
      const event = await after.history.currentCommit();
      assert.ok(event);
      assert.match(
        await after.history.read({ commit: event, path: "Service/Service.md" }),
        /contender/,
      );
    } finally {
      await after.close();
    }
    t.diagnostic(
      JSON.stringify({
        serviceAliveMs: Date.now() - start,
        successfulPollingReads: reads,
        rejectedSourceChangeReads: sourceChanges,
        independentCliWrites: 12,
        concurrentCasContenders: 2,
        handleRenameAfterClose: true,
      }),
    );
  },
);

test(
  "Web close waits for an accepted Core write before releasing the SQLite connection",
  { timeout: 30000 },
  async (t) => {
    const workspace = await fs.mkdtemp(path.join(testScratchRoot(), "sqlite-close-"));
    let release = () => {};
    t.after(async () => {
      release();
      await removeTestFixture(workspace, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 200,
      });
    });
    await initializeFixtureWorkspace(workspace);
    const root = path.join(workspace, ".tent"),
      setup = openTestFs(root);
    try {
      await createNode(
        { fs: setup, clock: { now: () => new Date().toISOString() }, tentName: "Close" },
        { id: "node-close", name: "Close", parentPath: "", type: "prompt", body: "before" },
      );
    } finally {
      await setup.close();
    }
    const server = await openTestService({
        workspaceRoot: workspace,
        staticDir: workspace,
        port: 0,
      }),
      base = new URL(server.url),
      headers = {
        Authorization: `Bearer ${base.hash.slice("#token=".length)}`,
        Origin: base.origin,
        "Content-Type": "application/json",
      };
    const page = (await fetch(new URL("/api/nodes/node-close", base), {
      headers,
      signal: t.signal,
    }).then((r) => r.json())) as { etag: string };
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r)),
      blocked = new Promise<void>((r) => (release = r));
    const original = NodeFs.prototype.writeFile;
    t.mock.method(
      NodeFs.prototype,
      "writeFile",
      async function (this: NodeFs, file: string, raw: string) {
        if (file === "Close/Close.md" && raw.includes("accepted write")) {
          enter();
          await blocked;
        }
        return original.call(this, file, raw);
      },
    );
    const response = fetch(new URL("/api/nodes/node-close", base), {
      method: "PUT",
      signal: t.signal,
      headers,
      body: JSON.stringify({ baseEtag: page.etag, body: "accepted write" }),
    }).then(
      (r) => r.text(),
      () => "socket closed",
    );
    await Promise.race([
      entered,
      response.then((text) => {
        throw new Error(`Write ended before reaching the accepted-write checkpoint: ${text}`);
      }),
    ]);
    let closed = false;
    const closing = server.close().then(() => (closed = true));
    try {
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(closed, false);
    } finally {
      release();
    }
    await closing;
    await response;
    assert.equal(closed, true);
    const adapter = openTestFs(root);
    try {
      const head = await adapter.history.currentCommit();
      assert.ok(head);
      assert.match(await adapter.readFile("Close/Close.md"), /accepted write/);
      assert.match(
        await adapter.history.read({ commit: head, path: "Close/Close.md" }),
        /accepted write/,
      );
    } finally {
      await adapter.close();
    }
    const database = path.join(root, ".git/history.sqlite");
    await fs.rename(database, database + ".closed");
    await fs.rename(database + ".closed", database);
  },
);
