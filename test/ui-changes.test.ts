import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NodeFs } from "../src/fs/node-fs.js";
import { startUiServer, type UiServer } from "../src/ui-server/server.js";
import { cli } from "./helpers.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext, idleTimeout?: number) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-changes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const workspaceRoot = path.join(root, "ws");
  const staticDir = path.join(root, "dist");
  await initializeFixtureWorkspace(workspaceRoot);
  await fs.mkdir(staticDir);
  const note = path.join(workspaceRoot, ".tent/Main/Main.md");
  await fs.mkdir(path.dirname(note));
  await fs.writeFile(note, "---\nid: node-main\ntype: prompt\n---\nInitial body\n");
  const server = await startUiServer({ workspaceRoot, staticDir, port: 0, idleTimeout });
  t.after(() => server.close());
  return { workspaceRoot, note, server };
}

function headers(server: UiServer) {
  return { Authorization: `Bearer ${new URL(server.url).hash.slice(7)}` };
}

async function read(server: UiServer, target: string, extra = {}) {
  return fetch(new URL(target, server.url), { headers: { ...headers(server), ...extra } });
}

function foreignHost(server: UiServer) {
  // fetch normalizes Host; use a raw HTTP request to exercise the server's rebinding guard.
  return new Promise<number>((resolve, reject) => {
    const request = http.get(
      new URL("/api/changes", server.url),
      {
        headers: { ...headers(server), Host: "foreign.invalid" },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      },
    );
    request.on("error", reject);
  });
}

async function stream(t: TestContext, server: UiServer) {
  return new Promise<{
    response: http.IncomingMessage;
    frames: string[];
    wait(count: number): Promise<void>;
    closed: Promise<void>;
    close(): Promise<void>;
  }>((resolve, reject) => {
    const request = http.get(new URL("/api/changes", server.url), { headers: headers(server) });
    request.on("error", reject);
    request.on("response", (response) => {
      assert.equal(response.statusCode, 200);
      const events = new EventEmitter();
      const frames: string[] = [];
      let buffer = "";
      const closed = new Promise<void>((done) => response.once("close", done));
      response.on("error", () => undefined);
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
          frames.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
        events.emit("frames");
      });
      const wait = async (count: number) => {
        if (frames.length >= count) return;
        await new Promise<void>((done, fail) => {
          const timeout = setTimeout(() => {
            events.off("frames", check);
            fail(new Error(`Expected ${count} SSE frames, received ${JSON.stringify(frames)}`));
          }, 5_000);
          function check() {
            if (frames.length < count) return;
            clearTimeout(timeout);
            events.off("frames", check);
            done();
          }
          events.on("frames", check);
          check();
        });
      };
      const close = async () => {
        request.destroy();
        await closed;
      };
      t.after(close);
      resolve({ response, frames, wait, closed, close });
    });
  });
}

function observeWatch(t: TestContext) {
  const original = nodeFs.watch;
  const watchers: nodeFs.FSWatcher[] = [];
  const directories: string[] = [];
  const recursive: boolean[] = [];
  const stopped = new Set<nodeFs.FSWatcher>();
  t.mock.method(nodeFs, "watch", (...args: unknown[]) => {
    const watcher = Reflect.apply(original, nodeFs, args) as nodeFs.FSWatcher;
    directories.push(String(args[0]));
    recursive.push((args[1] as { recursive?: boolean } | undefined)?.recursive === true);
    watchers.push(watcher);
    watcher.once("close", () => stopped.add(watcher));
    return watcher;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { watchers, stopped, directories, recursive };
}

test("change streams enforce Bearer, Host and Origin and release their shared monitor", async (t) => {
  const { server, workspaceRoot } = await fixture(t);
  const observed = observeWatch(t);
  assert.equal((await read(server, "/api/changes", { Authorization: "" })).status, 401);
  assert.equal((await read(server, "/api/changes", { Authorization: "Bearer wrong" })).status, 401);
  assert.equal(await foreignHost(server), 403);
  assert.equal(
    (await read(server, "/api/changes", { Origin: "https://foreign.invalid" })).status,
    403,
  );
  const query = new URL(server.url).hash.slice(7);
  assert.equal(
    (await read(server, `/api/changes?token=${query}`, { Authorization: "" })).status,
    401,
  );
  assert.equal(observed.watchers.length, 0);
  const first = await stream(t, server);
  await first.wait(1);
  assert.deepEqual(first.frames, [": connected"]);
  assert.equal(first.response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(first.response.headers["cache-control"], "no-store");
  const monitorCount = observed.watchers.length;
  if (process.platform === "win32") {
    assert.equal(monitorCount, 1, "one root handle leaves Node subtrees movable");
    assert.deepEqual(observed.directories, [workspaceRoot]);
  } else assert.ok(monitorCount >= 3);
  const second = await stream(t, server);
  await second.wait(1);
  assert.equal(observed.watchers.length, monitorCount);
  await first.close();
  await delay(30);
  assert.equal(observed.stopped.size, 0);
  await second.close();
  await delay(30);
  assert.equal(observed.stopped.size, monitorCount);
  const again = await stream(t, server);
  await again.wait(1);
  assert.equal(observed.watchers.length, monitorCount * 2);
  await server.close();
  await again.closed;
  await delay(30);
  assert.equal(observed.stopped.size, monitorCount * 2);
});

test(
  "disconnecting while a subscription starts releases its monitors",
  { timeout: 10_000 },
  async (t) => {
    const { workspaceRoot, server } = await fixture(t);
    const observed = observeWatch(t);
    if (process.platform === "win32") {
      // Native recursion needs no asynchronous directory walk. Disconnect as the root
      // monitor is created, covering the subscription/close boundary on this path too.
      const watch = nodeFs.watch;
      t.mock.method(nodeFs, "watch", (...args: unknown[]) => {
        const watcher = Reflect.apply(watch, nodeFs, args);
        queueMicrotask(() => request.destroy());
        return watcher;
      });
      syncBuiltinESMExports();
      const request = http.get(new URL("/api/changes", server.url), { headers: headers(server) });
      request.on("error", () => undefined);
      t.after(() => request.destroy());
      await new Promise<void>((resolve) => request.once("close", resolve));
      await delay(50);
      assert.equal(observed.watchers.length, 1);
      assert.equal(observed.stopped.size, 1);
      return;
    }
    const original = fs.readdir;
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(release);
    t.mock.method(fs, "readdir", async (...args: unknown[]) => {
      if (args[0] === workspaceRoot) {
        entered();
        await resumed;
      }
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    const request = http.get(new URL("/api/changes", server.url), { headers: headers(server) });
    request.on("error", () => undefined);
    const disconnected = new Promise<void>((resolve) => request.once("close", resolve));
    t.after(() => request.destroy());
    await blocked;
    request.destroy();
    await disconnected;
    await delay(50);
    assert.equal(observed.watchers.length, 1);
    assert.equal(observed.stopped.size, 1);
    release();
    await delay(50);
    assert.equal(observed.watchers.length, 1);
  },
);

test("CLI writes, editor changes, deletions and workspace materials wake fresh Core reads", async (t) => {
  const { workspaceRoot, note, server } = await fixture(t);
  const live = await stream(t, server);
  await live.wait(1);
  const result = await cli(
    workspaceRoot,
    "node",
    "create",
    "Cli",
    "--type",
    "goal",
    "--id",
    "node-cli",
    "--json",
  );
  assert.equal(result.code, 0, result.stderr);
  await live.wait(2);
  const map = await (await read(server, "/api/map")).json();
  assert.ok(map.nodes.some((node: { id: string }) => node.id === "node-cli"));
  await delay(100);
  let next = live.frames.length + 1;
  await fs.appendFile(note, "Editor body\n");
  await live.wait(next);
  const document = await (await read(server, "/api/nodes/node-main")).json();
  assert.match(document.body, /Editor body/);
  next = live.frames.length + 1;
  await fs.rm(note);
  await live.wait(next);
  const removed = await (await read(server, "/api/map")).json();
  assert.ok(!removed.nodes.some((node: { id: string }) => node.id === "node-main"));
  next = live.frames.length + 1;
  await fs.writeFile(path.join(workspaceRoot, "material.txt"), "Changed material");
  await live.wait(next);
  const nested = path.join(workspaceRoot, "new/sub/material.txt");
  next = live.frames.length + 1;
  await fs.mkdir(path.dirname(nested), { recursive: true });
  await fs.writeFile(nested, "New subtree");
  await live.wait(next);
  await delay(150);
  next = live.frames.length + 1;
  await fs.appendFile(nested, "\nSubsequent edit in the new subtree");
  await live.wait(next);
  for (const frame of live.frames.slice(1)) assert.equal(frame, "event: change\ndata: {}");
});

test(
  "active pages preserve CLI rename, move and deletion of a Node with descendants",
  { timeout: 90_000 },
  async (t) => {
    const { workspaceRoot, server } = await fixture(t);
    const child = path.join(workspaceRoot, ".tent/Main/Child");
    const destination = path.join(workspaceRoot, ".tent/Destination");
    await fs.mkdir(child);
    await fs.mkdir(destination);
    await fs.writeFile(
      path.join(child, "Child.md"),
      "---\nid: node-child\ntype: output\n---\nChild body\n",
    );
    await fs.writeFile(
      path.join(destination, "Destination.md"),
      "---\nid: node-destination\ntype: goal\n---\nDestination\n",
    );
    const before = await cli(workspaceRoot, "node", "rename", "node-main", "Before", "--json");
    assert.equal(before.code, 0, before.stderr);
    const observed = observeWatch(t);
    const pages = await Promise.all(Array.from({ length: 3 }, () => stream(t, server)));
    await Promise.all(pages.map((page) => page.wait(1)));
    if (process.platform === "win32") {
      assert.deepEqual(observed.directories, [workspaceRoot]);
      assert.deepEqual(observed.recursive, [true]);
    }
    const during = await cli(workspaceRoot, "node", "rename", "node-main", "During", "--json");
    assert.equal(during.code, 0, during.stderr);
    await Promise.all(pages.map((page) => page.wait(2)));
    const renamed = await (await read(server, "/api/map")).json();
    assert.equal(
      renamed.nodes.find((node: { id: string }) => node.id === "node-main").name,
      "During",
    );
    assert.equal(
      renamed.nodes.find((node: { id: string }) => node.id === "node-child").parentId,
      "node-main",
    );
    await pages[0]!.close();
    const moved = await cli(
      workspaceRoot,
      "node",
      "move",
      "node-main",
      "--parent",
      "node-destination",
      "--json",
    );
    assert.equal(moved.code, 0, moved.stderr);
    const topology = await (await read(server, "/api/map")).json();
    assert.equal(
      topology.nodes.find((node: { id: string }) => node.id === "node-main").parentId,
      "node-destination",
    );
    const remaining = pages[1]!;
    await delay(100);
    const next = remaining.frames.length + 1;
    await fs.appendFile(
      path.join(destination, "During/Child/Child.md"),
      "Editor after subtree move\n",
    );
    await remaining.wait(next);
    await Promise.all(pages.map((page) => page.close()));
    await delay(50);
    assert.equal(observed.stopped.size, observed.watchers.length);
    const after = await cli(workspaceRoot, "node", "rename", "node-main", "After", "--json");
    assert.equal(after.code, 0, after.stderr);
    const reconnected = await stream(t, server);
    await reconnected.wait(1);
    const deleted = await cli(workspaceRoot, "node", "delete", "node-main", "--json");
    assert.equal(deleted.code, 0, deleted.stderr);
    await reconnected.wait(2);
    const removed = await (await read(server, "/api/map")).json();
    assert.ok(
      !removed.nodes.some((node: { id: string }) => ["node-main", "node-child"].includes(node.id)),
    );
    await reconnected.close();
    await server.close();
    await delay(50);
    assert.equal(observed.stopped.size, observed.watchers.length);
    for (const page of [...pages, reconnected])
      assert.ok(page.frames.slice(1).every((frame) => frame === "event: change\ndata: {}"));
    t.diagnostic(
      JSON.stringify({
        platform: process.platform,
        node: process.version,
        cli: {
          before: before.code,
          during: during.code,
          move: moved.code,
          after: after.code,
          delete: deleted.code,
        },
        monitors: {
          created: observed.watchers.length,
          closed: observed.stopped.size,
          directories: observed.directories,
          recursive: observed.recursive,
        },
      }),
    );
  },
);

test("a burst waits for the existing mutation lock release and emits one empty hint", async (t) => {
  const { workspaceRoot, note, server } = await fixture(t);
  const live = await stream(t, server);
  await live.wait(1);
  const tent = new NodeFs(path.join(workspaceRoot, ".tent"));
  await tent.withLock("mutation.lock", async () => {
    for (let i = 0; i < 20; i++) await fs.appendFile(note, `line ${i}\n`);
    await delay(180);
    assert.deepEqual(live.frames, [": connected"]);
  });
  await live.wait(2);
  await delay(180);
  assert.deepEqual(live.frames, [": connected", "event: change\ndata: {}"]);
  // Releasing the CLI's existing lock is sufficient even if no document event is delivered.
  await tent.withLock("mutation.lock", async () => delay(100));
  await live.wait(3);
});

test("Git caches, temporary files and ordinary Core reads do not create a wakeup loop", async (t) => {
  const { workspaceRoot, server } = await fixture(t);
  for (const relative of [
    ".git/noise",
    ".tent/.git/tent-material-cache/noise",
    ".tent/temp/noise",
    ".tent/mutation.lock.guard/noise",
    ".scratch/noise",
    ".worktrees/noise",
    "node_modules/noise",
  ]) {
    const target = path.join(workspaceRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "noise");
  }
  const observed = observeWatch(t);
  const live = await stream(t, server);
  await live.wait(1);
  if (process.platform === "win32") {
    assert.deepEqual(observed.directories, [workspaceRoot]);
    assert.deepEqual(observed.recursive, [true]);
  } else assert.ok(observed.recursive.every((recursive) => !recursive));
  assert.ok(
    observed.directories.every(
      (directory) =>
        !/(?:^|[\\/])(?:\.git|node_modules|\.worktrees|\.scratch|temp)(?:[\\/]|$)/.test(
          path.relative(workspaceRoot, directory),
        ),
    ),
  );
  for (const relative of [
    ".tent/.git/tent-material-cache/noise",
    ".tent/temp/noise",
    ".scratch/noise",
    "node_modules/noise",
  ])
    await fs.appendFile(path.join(workspaceRoot, relative), "more noise");
  for (let i = 0; i < 2; i++) assert.equal((await read(server, "/api/map")).status, 200);
  await delay(200);
  assert.deepEqual(live.frames, [": connected"]);
});

test("unavailable and failed monitors leave polling usable and permit a fresh subscription", async (t) => {
  const { server } = await fixture(t);
  const original = nodeFs.watch;
  const failure = t.mock.method(nodeFs, "watch", () => {
    throw new Error("watch unsupported");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const rejected = await read(server, "/api/changes");
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, "CHANGES_UNAVAILABLE");
  assert.equal((await read(server, "/api/canvas")).status, 200);
  failure.mock.restore();
  assert.equal(nodeFs.watch, original);
  syncBuiltinESMExports();
  const observed = observeWatch(t);
  const live = await stream(t, server);
  await live.wait(1);
  const monitorCount = observed.watchers.length;
  observed.watchers[0]!.emit("error", new Error("watch lost"));
  await live.closed;
  assert.equal((await read(server, "/api/canvas")).status, 200);
  const again = await stream(t, server);
  await again.wait(1);
  assert.equal(observed.watchers.length, monitorCount * 2);
});

test(
  "an open change stream and pushed hints do not prevent idle shutdown",
  { timeout: 10_000 },
  async (t) => {
    const { note, server } = await fixture(t, 1);
    const live = await stream(t, server);
    await live.wait(1);
    await delay(500);
    await fs.appendFile(note, "Changed while the page is idle\n");
    await live.wait(2);
    await server.closed;
    await live.closed;
    await assert.rejects(read(server, "/api/canvas"));
  },
);
