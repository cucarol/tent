import { openTestService } from "./node-fs.js";
import { removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";
import { startUiServer } from "../src/ui-server/server.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-idle-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  const workspaceRoot = path.join(root, "one"),
    other = path.join(root, "two"),
    staticDir = path.join(root, "dist");
  await initializeFixtureWorkspace(workspaceRoot);
  await initializeFixtureWorkspace(other);
  await fs.mkdir(staticDir);
  await fs.writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>Tent</title>");
  return { workspaceRoot, other, staticDir };
}
function request(
  base: string,
  target: string,
  options: { token?: boolean; headers?: Record<string, string>; body?: unknown } = {},
) {
  const url = new URL(base);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      new URL(target, url),
      {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          ...(options.token === false ? {} : { Authorization: `Bearer ${url.hash.slice(7)}` }),
          ...(options.body === undefined
            ? {}
            : { Origin: url.origin, "Content-Type": "application/json" }),
          ...options.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

test(
  "idle UI ignores unauthenticated, foreign-origin, static and unsuccessful requests",
  { timeout: 15_000 },
  async (t) => {
    const options = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = await openTestService({ ...options, port: 0, idleTimeout: 1 });
    t.after(() => server.close());
    t.mock.timers.tick(900);
    assert.equal((await request(server.url, "/api/canvas", { token: false })).status, 401);
    assert.equal(
      (await request(server.url, "/api/canvas", { headers: { Origin: "https://example.invalid" } }))
        .status,
      403,
    );
    assert.equal((await request(server.url, "/api/missing")).status, 404);
    assert.equal((await request(server.url, "/")).status, 200);
    t.mock.timers.tick(100);
    await server.closed;
    await assert.rejects(request(server.url, "/api/canvas"));
    await server.close();
  },
);

test(
  "authenticated activity in another owned workspace renews one deadline and expiry closes both",
  { timeout: 15_000 },
  async (t) => {
    const options = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = await openTestService({ ...options, port: 0, idleTimeout: 1 });
    t.after(() => server.close());
    let closed = false;
    void server.closed.then(() => {
      closed = true;
    });
    t.mock.timers.tick(900);
    assert.equal((await request(server.url, "/api/canvas")).status, 200);
    t.mock.timers.tick(900);
    assert.equal(closed, false);
    const opened = await request(server.url, "/api/workspaces/open", {
      body: { path: options.other },
    });
    assert.equal(opened.status, 200, opened.body);
    const other = JSON.parse(opened.body).url as string;
    t.mock.timers.tick(900);
    assert.equal((await request(other, "/api/canvas")).status, 200);
    t.mock.timers.tick(900);
    assert.equal(closed, false);
    t.mock.timers.tick(100);
    await server.closed;
    await assert.rejects(request(other, "/api/canvas"));
    await assert.rejects(request(server.url, "/api/canvas"));
  },
);

test(
  "ordinary UI has no idle deadline and manual close cancels an enabled timer",
  { timeout: 15_000 },
  async (t) => {
    const options = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ordinary = await openTestService({ ...options, port: 0 });
    t.after(() => ordinary.close());
    t.mock.timers.tick(3_600_000);
    assert.equal((await request(ordinary.url, "/api/canvas")).status, 200);
    await ordinary.close();
    const idle = await openTestService({ ...options, port: 0, idleTimeout: 1 });
    await idle.close();
    t.mock.timers.tick(3_600_000);
    await idle.closed;
  },
);
