import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import http from "node:http";
import net from "node:net";
import { userInfo } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeFixtureWorkspace } from "./scratch.js";
import { writeNodeDocument } from "../src/core/graph/node-document-write.js";
import { createNode, deleteNode, renameNode } from "../src/core/graph/ops.js";
import { readWorkspaceSettings } from "../src/core/workspace/workspace-settings.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { linkNodeOutput } from "../src/core/graph/node-sync.js";
import { takeCardDocument, returnCardDocument } from "../src/core/graph/card-document.js";
import { startUiServer, workspacePort } from "../src/ui-server/server.js";
import {
  defaultWorkspacesFile,
  readWorkspaces,
  rememberWorkspace,
} from "../src/ui-server/workspaces.js";
import type { CodeFacts, Snapshot } from "../src/ui/data/types.js";
import { testScratchRoot } from "./scratch.js";
import { incompleteNodeReadEtag } from "../src/core/base/node-read-basis.js";
import { contentEtag } from "../src/core/base/etag.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { readWorkspaceRevision } from "../src/core/workspace/workspace-revision.js";
import type { ModuleDependencyResponse } from "../src/core/read/module-dependency-query.js";
import type { WorkspaceMap } from "../src/core/read/workspace-map.js";
import { git } from "./helpers.js";

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };
type Call = (
  method: string,
  target: string,
  options?: { headers?: Record<string, string>; json?: unknown; token?: string | null },
) => Promise<Reply>;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-server-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const workspace = path.join(root, "ws");
  await initializeFixtureWorkspace(workspace);
  const tent = new NodeFs(path.join(workspace, ".tent"));
  await tent.writeFile(
    "Main/Main.md",
    "---\nid: node-main\ntype: prompt\n---\nSee [other](../Other/Other.md).\n",
  );
  await tent.writeFile("Other/Other.md", "---\nid: node-other\ntype: goal\n---\nThe goal.\n");
  await fs.mkdir(path.join(workspace, "docs"));
  await fs.writeFile(path.join(workspace, "docs/shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(workspace, "docs/notes.txt"), "not an image");
  const dist = path.join(root, "dist");
  await fs.mkdir(dist);
  await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>Tent</title>");

  const server = await startUiServer({ workspaceRoot: workspace, staticDir: dist, port: 0 });
  t.after(() => server.close());
  const token = new URL(server.url).hash.replace("#token=", "");
  const origin = `http://127.0.0.1:${server.port}`;
  const call: Call = (method, target, options = {}) =>
    new Promise((resolve, reject) => {
      const body = options.json === undefined ? undefined : JSON.stringify(options.json);
      const auth =
        options.token === null ? {} : { Authorization: `Bearer ${options.token ?? token}` };
      const request = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          method,
          path: target,
          headers: {
            ...auth,
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": String(Buffer.byteLength(body)),
                  Origin: origin,
                }),
            ...options.headers,
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode!, headers: response.headers, body: text }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  return { workspace, tent, dist, server, call, origin };
}

const json = <T>(reply: Reply) => JSON.parse(reply.body) as T;

test("Node detail endpoints are authenticated pure reads with independent sections", async (t) => {
  const { tent, call, workspace } = await fixture(t);
  const tentRoot = path.join(workspace, ".tent");
  const head = await git(tentRoot, "rev-parse", "--verify", "HEAD").catch(() => null);
  const dirty = await git(tentRoot, "status", "--porcelain");
  for (const section of [
    "history",
    "cards",
    "relations?direction=outgoing",
    "relations?direction=incoming",
  ]) {
    const route = `/api/nodes/node-main/${section}`;
    assert.equal((await call("GET", route, { token: null })).status, 401);
    const reply = await call("GET", route);
    assert.equal(reply.status, 200, reply.body);
    assert.equal(json<{ nodeId: string }>(reply).nodeId, "node-main");
    assert.equal(reply.headers["cache-control"], "no-store");
  }
  assert.equal((await call("GET", "/api/nodes/node-main/relations?direction=both")).status, 400);
  assert.equal((await call("GET", "/api/nodes/node-missing/history")).status, 404);
  assert.equal((await call("GET", "/api/nodes/invalid/cards")).status, 422);
  await tent.writeFile(
    "Other/Other.md",
    "---\nid: node-other\ntype: goal\n---\n[Main](/Main/Main.md)\n",
  );
  const incoming = await call("GET", "/api/nodes/node-main/relations?direction=incoming");
  assert.equal(
    json<{ incoming: { from: { id: string } }[] }>(incoming).incoming[0]?.from.id,
    "node-other",
  );
  await tent.writeFile("Other/Other.md", "---\nid: node-other\ntype: goal\n---\nThe goal.\n");
  assert.equal(await git(tentRoot, "rev-parse", "--verify", "HEAD").catch(() => null), head);
  assert.equal(await git(tentRoot, "status", "--porcelain"), dirty);
});

test("invalid stale_after is isolated while map and sync keep serving the workspace", async (t) => {
  const { tent, call } = await fixture(t);
  await tent.writeFile(
    "Bad/Bad.md",
    "---\nid: node-bad\ntype: goal\nstale_after: someday\n---\nBad date\n",
  );
  const map = await call("GET", "/api/map");
  assert.equal(map.status, 200, map.body);
  const bad = json<WorkspaceMap>(map).nodes.find((node) => node.id === "node-bad")!;
  assert.equal(bad.invalid, true);
  assert.match(bad.invalidReason!, /stale_after/);
  assert.equal(bad.stale, false);
  assert.equal(
    json<WorkspaceMap>(map).nodes.find((node) => node.id === "node-main")!.invalid,
    false,
  );
  const sync = await call("GET", "/api/sync");
  assert.equal(sync.status, 200, sync.body);
  assert.equal(json<{ nodes: Record<string, unknown> }>(sync).nodes["node-bad"], undefined);
  assert.equal((await call("GET", "/api/snapshot")).status, 200);
  await tent.writeFile(
    "Bad/Bad.md",
    "---\nid: node-bad\ntype: goal\nstale_after: 2000-01-01T00:00:00Z\n---\nRepaired\n",
  );
  const repaired = json<WorkspaceMap>(await call("GET", "/api/map")).nodes.find(
    (node) => node.id === "node-bad",
  )!;
  assert.equal(repaired.invalid, false);
  assert.equal(repaired.stale, true);
  const repairedSync = await call("GET", "/api/sync");
  assert.equal(repairedSync.status, 200, repairedSync.body);
  assert.ok(
    json<{ nodes: Record<string, { behind?: unknown }> }>(repairedSync).nodes["node-bad"]?.behind,
  );
});

test("map API exposes a header-only skeleton and leaves document details on demand", async (t) => {
  const { tent, call } = await fixture(t);
  await tent.writeFile(
    "Main/Child/Child.md",
    "---\nid: node-child\ntype: output\nstale_after: 2000-01-01T00:00:00Z\n---\nChild body\n",
  );
  await tent.writeFile("cards/card-broken.md", "---\ninvalid: [\n---\nPrivate Card");
  assert.equal((await call("GET", "/api/map", { token: null })).status, 401);
  const originalFile = NodeFs.prototype.readFile;
  const originalBinary = NodeFs.prototype.readBinary;
  NodeFs.prototype.readFile = function (file) {
    assert.ok(!file.endsWith(".md"), `Map read a body: ${file}`);
    return originalFile.call(this, file);
  };
  NodeFs.prototype.readBinary = function (file) {
    assert.ok(!file.endsWith(".md"), `Map revision read a document: ${file}`);
    return originalBinary.call(this, file);
  };
  let reply: Reply;
  try {
    reply = await call("GET", "/api/map");
  } finally {
    NodeFs.prototype.readFile = originalFile;
    NodeFs.prototype.readBinary = originalBinary;
  }
  assert.equal(reply.status, 200, reply.body);
  const map = json<WorkspaceMap>(reply);
  const child = map.nodes.find((node) => node.id === "node-child")!;
  assert.equal(child.parentId, "node-main");
  assert.equal(child.stale, true);
  assert.equal(child.depth, 1);
  assert.deepEqual(map.nodes.find((node) => node.id === "node-main")!.childIds, ["node-child"]);
  assert.deepEqual(Object.keys(map).sort(), ["modules", "nodes", "workspace"]);
  assert.equal(Object.prototype.hasOwnProperty.call(child, "body"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(child, "history"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(child, "links"), false);
  const detail = json<{ body: string }>(await call("GET", "/api/nodes/node-child"));
  assert.equal(detail.body.trim(), "Child body");
});

test("concurrent map requests keep their own observed Node headers", async (t) => {
  const { tent, call } = await fixture(t);
  const original = NodeFs.prototype.readFrontmatter;
  let unblock!: () => void;
  const paused = new Promise<void>((resolve) => (unblock = resolve));
  let sampled!: () => void;
  const observed = new Promise<void>((resolve) => (sampled = resolve));
  let first = true;
  NodeFs.prototype.readFrontmatter = async function (file) {
    const header = await original.call(this, file);
    if (file === "Main/Main.md" && first) {
      first = false;
      sampled();
      await paused;
    }
    return header;
  };
  try {
    const older = call("GET", "/api/map");
    await observed;
    await tent.writeFile("Main/Main.md", "---\nid: node-main\ntype: goal\n---\nNew body\n");
    const newer = await call("GET", "/api/map");
    assert.equal(newer.status, 200, newer.body);
    assert.equal(
      json<WorkspaceMap>(newer).nodes.find((node) => node.id === "node-main")!.type,
      "goal",
    );
    unblock();
    const previous = await older;
    assert.equal(previous.status, 200, previous.body);
    assert.equal(
      json<WorkspaceMap>(previous).nodes.find((node) => node.id === "node-main")!.type,
      "prompt",
    );
    assert.notEqual(
      json<WorkspaceMap>(previous).workspace.revision,
      json<WorkspaceMap>(newer).workspace.revision,
    );
  } finally {
    unblock();
    NodeFs.prototype.readFrontmatter = original;
  }
});

test("canvas API queues CAS writes and exposes current state, history and security errors", async (t) => {
  const { tent, call } = await fixture(t);
  const target = "/api/canvas";
  const canvas = {
    version: 2,
    positions: { "node-absent": [12, -3] },
    regions: [{ id: "r1", name: "", box: [0, 0, 100, 80] }],
    drawings: [{ id: "ink", kind: "pen", points: [[1, 2]], custom: { keep: true } }],
  };
  assert.deepEqual(json(await call("GET", target)), { etag: null, canvas: null });
  assert.equal(await tent.exists("canvas.json"), false);
  assert.equal((await call("GET", target, { token: null })).status, 401);
  assert.equal(
    (
      await call("PUT", target, {
        json: { baseEtag: null, canvas },
        headers: { Origin: "https://other.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("PUT", target, {
        json: { baseEtag: null, canvas },
        headers: { Host: "other.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("PUT", target, {
        json: { baseEtag: null, canvas },
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
  const before = json<{ revision: string }>(await call("GET", "/api/revision"));
  const concurrent = await Promise.all([
    call("PUT", target, { json: { baseEtag: null, canvas } }),
    call("PUT", target, { json: { baseEtag: null, canvas } }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  const saved = json<{ etag: string; version: { commit: string; path: string } }>(
    concurrent.find((r) => r.status === 200)!,
  );
  const current = json(await call("GET", target));
  assert.deepEqual(current, { etag: saved.etag, canvas });
  assert.deepEqual(
    json<{ error: { code: string; details: { current: unknown } } }>(
      concurrent.find((r) => r.status === 409)!,
    ).error,
    {
      code: "ETAG_CONFLICT",
      message: "Canvas changed; reread before saving",
      details: { current },
    },
  );
  assert.notEqual(
    json<{ revision: string }>(await call("GET", "/api/revision")).revision,
    before.revision,
  );
  const historical = await call(
    "GET",
    `/api/history/document?at=${saved.version.commit}:canvas.json`,
  );
  assert.equal(historical.status, 200);
  assert.deepEqual(JSON.parse(json<{ raw: string }>(historical).raw), canvas);
  for (const input of [
    { canvas },
    { baseEtag: saved.etag, canvas: {} },
    { baseEtag: saved.etag, canvas: { version: 1, forms: {}, positions: {}, drawings: [] } },
    {
      baseEtag: saved.etag,
      canvas: { ...canvas, regions: [...canvas.regions, ...canvas.regions] },
    },
    {
      baseEtag: saved.etag,
      canvas: { ...canvas, drawings: [{ id: "d", kind: "pen", node: null }] },
    },
  ]) {
    const invalid = await call("PUT", target, { json: input });
    assert.equal(invalid.status, 422);
    assert.equal(json<{ error: { code: string } }>(invalid).error.code, "INVALID_INPUT");
  }
  const huge = await call("PUT", target, {
    json: {
      baseEtag: saved.etag,
      canvas: {
        ...canvas,
        drawings: [{ id: "x", kind: "text", text: "x".repeat(5 * 1024 * 1024 + 1024) }],
      },
    },
  });
  assert.equal(huge.status, 413);
  assert.deepEqual(json(await call("GET", target)), current);
  await tent.writeFile("canvas.json", "broken");
  assert.equal((await call("GET", target)).status, 422);
  assert.equal((await call("PUT", target, { json: { baseEtag: saved.etag, canvas } })).status, 422);
  assert.equal(await tent.readFile("canvas.json"), "broken");
});

test("canvas API reports a busy workspace lock without writing", async (t) => {
  const { tent, call } = await fixture(t);
  await tent.withLock("mutation.lock", async () => {
    const reply = await call("PUT", "/api/canvas", {
      json: { baseEtag: null, canvas: { version: 2, positions: {}, regions: [], drawings: [] } },
    });
    assert.equal(reply.status, 503);
    assert.equal(json<{ error: { code: string } }>(reply).error.code, "BUSY");
    assert.equal(await tent.exists("canvas.json"), false);
  });
});

test("module dependency endpoint is protected, read-only and refreshes while the repository stays dirty", async (t) => {
  const { call, tent, workspace } = await fixture(t);
  await git(workspace, "init", "-b", "main");
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\nignored/\n");
  for (const dir of ["a", "b", "ignored"]) await fs.mkdir(path.join(workspace, dir));
  await fs.writeFile(path.join(workspace, "a/main.ts"), 'import "../b/lib.js";');
  await fs.writeFile(path.join(workspace, "b/lib.ts"), "export const n = 1;");
  await fs.writeFile(path.join(workspace, "ignored/hidden.ts"), 'import "../a/main.js";');
  for (const name of ["a", "b"])
    await tent.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter(
        {
          id: `node-${name}`,
          type: "prompt",
          sources: [{ resource: `../../${name}/`, track: "structure" }],
        },
        "Rules.",
      ),
    );
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "fixture");
  const head = (await git(workspace, "rev-parse", "HEAD")).trim();
  const revision = await readWorkspaceRevision(tent);
  const index = await fs.readFile(path.join(workspace, ".git/index"));
  const endpoint = "/api/modules/deps";
  const current = async (matches: (result: ModuleDependencyResponse) => boolean) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const reply = await call("GET", endpoint);
      assert.equal(reply.status, 200, reply.body);
      const value = json<ModuleDependencyResponse>(reply);
      assert.equal(value.mode, "verify");
      if (value.fresh && matches(value)) return value;
      assert.ok(Date.now() < deadline, "dependency change was not observed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  assert.equal((await call("GET", endpoint, { token: null })).status, 401);
  assert.equal(
    (await call("GET", endpoint, { headers: { Origin: "https://foreign.example" } })).status,
    403,
  );
  assert.equal((await call("POST", endpoint, { json: {} })).status, 404);
  const first = await call("GET", endpoint);
  assert.equal(first.status, 200, first.body);
  const result = json<ModuleDependencyResponse>(first);
  assert.equal(result.mode, "verify");
  assert.equal(result.fresh, true);
  assert.ok(!Number.isNaN(Date.parse(result.computedAt)));
  const again = json<ModuleDependencyResponse>(await call("GET", endpoint));
  assert.deepEqual({ ...again, computedAt: result.computedAt }, result);
  assert.deepEqual(result.basis, { head });
  assert.deepEqual(result.modules, [
    { nodeId: "node-a", files: 1 },
    { nodeId: "node-b", files: 1 },
  ]);
  assert.deepEqual(result.edges, [{ from: "node-a", to: "node-b", imports: 1 }]);
  assert.equal(await readWorkspaceRevision(tent), revision);
  assert.deepEqual(await fs.readFile(path.join(workspace, ".git/index")), index);
  assert.equal((await git(workspace, "rev-parse", "HEAD")).trim(), head);

  await fs.writeFile(path.join(workspace, "a/main.ts"), 'import "../missing.js";');
  const missing = await current((value) => value.unresolved === 1);
  assert.deepEqual(missing.basis, { head });
  assert.deepEqual(missing.edges, []);
  assert.equal(missing.unresolved, 1);
  await fs.writeFile(path.join(workspace, "a/main.ts"), 'import "../b/lib.js"; // still dirty');
  const changedAgain = await current((value) => value.unresolved === 0);
  assert.deepEqual(changedAgain.basis, missing.basis);
  assert.deepEqual(changedAgain.edges, result.edges);
  assert.equal(changedAgain.unresolved, 0);
  await tent.writeFile(
    "b/b.md",
    serializeFrontmatter({ id: "node-b", type: "prompt" }, "No module now."),
  );
  const changedNode = await current((value) => value.modules.length === 1);
  assert.deepEqual(changedNode.modules, [{ nodeId: "node-a", files: 1 }]);
  assert.equal(changedNode.uncovered, 1);
  await fs.writeFile(path.join(workspace, "tsconfig.json"), "{ broken");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const failed = await call("GET", endpoint);
    if (failed.status === 422) break;
    assert.equal(failed.status, 200, failed.body);
    assert.ok(Date.now() < deadline, "invalid configuration must not leave a cached graph");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("module dependency HTTP requests verify current inputs without starting notifications", async (t) => {
  const { call, workspace } = await fixture(t);
  await git(workspace, "init", "-b", "main");
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  const original = nodeFs.watch;
  let watches = 0;
  let first: Reply;
  nodeFs.watch = (() => {
    watches++;
    throw new Error("watch unavailable for test");
  }) as typeof nodeFs.watch;
  syncBuiltinESMExports();
  try {
    first = await call("GET", "/api/modules/deps");
  } finally {
    nodeFs.watch = original;
    syncBuiltinESMExports();
  }
  assert.equal(first.status, 200, first.body);
  const result = json<ModuleDependencyResponse>(first);
  assert.equal(result.mode, "verify");
  assert.equal(watches, 0);
  assert.match(result.reason!, /validated on each request/);
  assert.equal(result.fresh, true);
  await fs.writeFile(path.join(workspace, "entry.ts"), 'import "./missing.js";');
  const updated = json<ModuleDependencyResponse>(await call("GET", "/api/modules/deps"));
  assert.equal(updated.mode, "verify");
  assert.equal(updated.unresolved, 1);
  await fs.writeFile(path.join(workspace, "entry.ts"), "export const n = 1;");
  assert.equal(
    json<ModuleDependencyResponse>(await call("GET", "/api/modules/deps")).unresolved,
    0,
  );
});

test("Web confirmation records the local human or explicit actor with full-document CAS", async (t) => {
  const { tent, call } = await fixture(t);
  const target = "/api/nodes/node-main";
  const read = async () =>
    json<{ etag: string; body: string; trustTier: string }>(await call("GET", target));
  const initial = await read();
  assert.equal(initial.trustTier, "unverified");
  const saved = await call("PUT", target, {
    json: { baseEtag: initial.etag, body: "A reviewed fact." },
  });
  assert.equal(saved.status, 200, saved.body);
  const before = parseFrontmatter(await tent.readFile("Main/Main.md"));
  assert.equal((before.data.generated as { by: string }).by, `human:${userInfo().username}`);
  const editing = await read();
  const confirmed = await call("POST", `${target}/confirm`, { json: { baseEtag: editing.etag } });
  assert.equal(confirmed.status, 200, confirmed.body);
  assert.equal(json<{ trustTier: string }>(confirmed).trustTier, "human-reviewed");
  const after = parseFrontmatter(await tent.readFile("Main/Main.md"));
  assert.equal(after.body, before.body);
  assert.deepEqual(after.data.generated, before.data.generated);
  assert.equal((after.data.verified as { by: string }[])[0]!.by, `human:${userInfo().username}`);
  assert.equal((await read()).trustTier, "human-reviewed");
  for (let i = 0; i < 2; i++) {
    const reply = await call("POST", `${target}/confirm`, {
      json: { baseEtag: (await read()).etag, by: "human:reviewer" },
    });
    assert.equal(reply.status, 200, reply.body);
  }
  const latest = await tent.readFile("Main/Main.md");
  const verified = parseFrontmatter(latest).data.verified as { by: string }[];
  assert.equal(verified.filter((entry) => entry.by === "human:reviewer").length, 1);
  const stale = await call("POST", `${target}/confirm`, { json: { baseEtag: editing.etag } });
  assert.equal(stale.status, 409, stale.body);
  assert.equal(json<{ error: { code: string } }>(stale).error.code, "ETAG_CONFLICT");
  const incomplete = await call("POST", `${target}/confirm`, {
    json: { baseEtag: incompleteNodeReadEtag(contentEtag(latest)) },
  });
  assert.equal(incomplete.status, 422, incomplete.body);
  assert.equal(json<{ error: { code: string } }>(incomplete).error.code, "INCOMPLETE_READ");
  for (const input of [
    {},
    { baseEtag: (await read()).etag, by: "" },
    { baseEtag: (await read()).etag, by: 1 },
  ]) {
    assert.equal((await call("POST", `${target}/confirm`, { json: input })).status, 422);
  }
  assert.equal(
    (
      await call("POST", `${target}/confirm`, {
        json: { baseEtag: (await read()).etag },
        token: null,
      })
    ).status,
    401,
  );
  assert.equal(await tent.readFile("Main/Main.md"), latest);
});

test("Web Node edits retain legacy material addresses and reject changed addresses with a repair", async (t) => {
  const { tent, call } = await fixture(t);
  const note = "Main/Main.md";
  const parsed = parseFrontmatter(await tent.readFile(note));
  parsed.data.resource = "/../spec/x.md";
  parsed.data.sources = [{ resource: "/../spec/x.md" }];
  await tent.writeFile(note, serializeFrontmatter(parsed.data, parsed.body));
  const read = async () =>
    json<{ etag: string; frontmatter: Record<string, unknown> }>(
      await call("GET", "/api/nodes/node-main"),
    );
  const live = await read();
  const body = await call("PUT", "/api/nodes/node-main", {
    json: { baseEtag: live.etag, body: "Web update" },
  });
  assert.equal(body.status, 200, body.body);
  assert.deepEqual(parseFrontmatter(await tent.readFile(note)).data.sources, parsed.data.sources);
  assert.equal(
    (await tent.history.nodeRecords())["node-main"],
    undefined,
    "a body-only save does not establish a baseline for existing legacy declarations",
  );
  const confirmed = await call("POST", "/api/nodes/node-main/confirm", {
    json: { baseEtag: (await read()).etag },
  });
  assert.equal(confirmed.status, 200, confirmed.body);
  const record = (await tent.history.nodeRecords())["node-main"]!;
  assert.equal(record.v, 1);
  assert.equal(record.materials.length, 2);
  assert.ok(
    record.materials.every((material) =>
      /^unresolved-sha256:[a-f0-9]{64}$/.test(material.identity),
    ),
  );
  assert.ok(record.materials.every((material) => material.version === undefined));
  const current = await read();
  const raw = await call("PUT", "/api/nodes/node-main", {
    json: {
      baseEtag: current.etag,
      raw: serializeFrontmatter(current.frontmatter, "raw Web update"),
    },
  });
  assert.equal(raw.status, 200, raw.body);
  assert.deepEqual((await tent.history.nodeRecords())["node-main"], record);
  const next = await read();
  const before = await tent.readFile(note);
  for (const fields of [{ resource: "/../new.md" }, { sources: [{ resource: "/../new.md" }] }]) {
    const rejected = await call("PUT", "/api/nodes/node-main", {
      json: { baseEtag: next.etag, frontmatter: fields },
    });
    assert.equal(rejected.status, 422);
    const error = json<{ error: { code: string; message: string } }>(rejected).error;
    assert.equal(error.code, "INVALID_EDIT");
    assert.match(error.message, /Invalid (resource|sources\[0\]\.resource):.*\.\.\/\.\.\/new.md/);
    assert.equal(await tent.readFile(note), before);
  }
  const declared = await call("PUT", "/api/nodes/node-main", {
    json: {
      baseEtag: next.etag,
      frontmatter: {
        sources: [...(parsed.data.sources as object[]), { resource: "../../docs/notes.txt" }],
      },
    },
  });
  assert.equal(declared.status, 200, declared.body);
  const observed = (await tent.history.nodeRecords())["node-main"]!;
  assert.equal(observed.materials.length, 3);
  assert.deepEqual(observed.materials.slice(0, 2), record.materials);
  assert.ok(observed.materials[2]!.version, "a newly declared material is observed on save");
});

test("Node HTTP content replacement rejects incomplete read bases with 422", async (t) => {
  const { tent, call } = await fixture(t);
  const raw = await tent.readFile("Main/Main.md");
  const baseEtag = incompleteNodeReadEtag(contentEtag(raw));
  for (const edit of [{ body: "fragment" }, { raw: "fragment" }]) {
    const reply = await call("PUT", "/api/nodes/node-main", { json: { baseEtag, ...edit } });
    assert.equal(reply.status, 422);
    assert.equal(json<{ error: { code: string } }>(reply).error.code, "INCOMPLETE_READ");
    assert.equal(await tent.readFile("Main/Main.md"), raw);
  }
  const metadata = await call("PUT", "/api/nodes/node-main", {
    json: { baseEtag, frontmatter: { description: "reviewed" } },
  });
  assert.equal(metadata.status, 200);
  assert.equal(json<{ body: string }>(metadata).body, "See [other](../Other/Other.md).\n");
});

test("the service answers only its own page, with the printed token", async (t) => {
  const { call, server } = await fixture(t);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]{43}$/);

  const page = await call("GET", "/", { token: null });
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal((await call("GET", "/..%2f..%2fdist%2findex.html", { token: null })).status, 404);
  assert.equal((await call("GET", "//[", { token: null })).status, 400);

  assert.equal((await call("GET", "/api/revision", { token: null })).status, 401);
  assert.equal((await call("GET", "/api/revision", { token: "wrong" })).status, 401);
  assert.equal(
    (await call("GET", "/api/revision", { headers: { Host: "evil.test" } })).status,
    403,
    "a rebound name is refused",
  );
  assert.equal(
    (await call("GET", "/api/revision", { headers: { Origin: "http://evil.test" } })).status,
    403,
  );
  assert.equal((await call("GET", "/api/revision")).status, 200);

  const put = (headers: Record<string, string>) =>
    call("PUT", "/api/nodes/node-main", {
      headers: { "Content-Type": "application/json", ...headers },
    });
  assert.equal((await put({})).status, 403, "writes must name their origin");
  assert.equal(
    (await put({ Origin: `http://127.0.0.1:${server.port}`, "Content-Type": "text/plain" })).status,
    415,
  );
});

test("retired drawing files remain untouched and have no UI API or snapshot state", async (t) => {
  const { call, tent } = await fixture(t);
  const before = json<Snapshot>(await call("GET", "/api/snapshot"));
  await tent.writeFile("annotations.json", "old drawing bytes, no longer parsed");
  assert.equal((await call("GET", "/api/annotations")).status, 404);
  assert.equal((await call("PUT", "/api/annotations", { json: { document: {} } })).status, 404);
  const after = json<Snapshot>(await call("GET", "/api/snapshot"));
  assert.equal("annotations" in after, false);
  assert.equal(after.workspace.revision, before.workspace.revision);
  assert.equal(await tent.readFile("annotations.json"), "old drawing bytes, no longer parsed");
});

test("the snapshot is built from Core and revalidates by revision", async (t) => {
  const { call, tent } = await fixture(t);
  const first = await call("GET", "/api/snapshot");
  assert.equal(first.status, 200);
  const snapshot = json<Snapshot>(first);
  const main = snapshot.nodes.find((n) => n.id === "node-main")!;
  assert.deepEqual(
    main.links.map((l) => l.ref),
    [{ kind: "node", id: "node-other" }],
  );
  assert.deepEqual(snapshot.nodes.find((n) => n.id === "node-other")!.incoming, [
    { from: { kind: "node", id: "node-main" }, via: "link" },
  ]);
  assert.equal(first.headers.etag, `"${snapshot.workspace.revision}"`);
  assert.equal(
    (await call("GET", "/api/snapshot", { headers: { "If-None-Match": first.headers.etag! } }))
      .status,
    304,
  );

  // An edit made outside Tent changes the revision too.
  await tent.writeFile("Other/Other.md", "---\nid: node-other\ntype: goal\n---\nA changed goal.\n");
  const { revision } = json<{ revision: string }>(await call("GET", "/api/revision"));
  assert.notEqual(revision, snapshot.workspace.revision);
  const next = await call("GET", "/api/snapshot", {
    headers: { "If-None-Match": first.headers.etag! },
  });
  assert.equal(next.status, 200);
  assert.equal(
    json<Snapshot>(next).nodes.find((n) => n.id === "node-other")!.body,
    "A changed goal.\n",
  );
});

test("queued snapshot readers observe intervening edits and keep individual conditional responses", async (t) => {
  const { call, server, tent, workspace } = await fixture(t);
  const baseline = await call("GET", "/api/snapshot");
  const token = new URL(server.url).hash.replace("#token=", "");
  const pipeline = (etag: string) =>
    new Promise<Reply[]>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: server.port });
      const chunks: Buffer[] = [];
      socket.on("error", reject);
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("connect", () =>
        socket.write(
          ["/api/snapshot", "/api/snapshot?fresh=1", "/api/snapshot"]
            .map(
              (target, index) =>
                `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${token}\r\nIf-None-Match: ${etag}\r\nConnection: ${index === 2 ? "close" : "keep-alive"}\r\n\r\n`,
            )
            .join(""),
        ),
      );
      socket.on("end", () => {
        try {
          const bytes = Buffer.concat(chunks),
            replies: Reply[] = [];
          let offset = 0;
          while (offset < bytes.length) {
            const end = bytes.indexOf("\r\n\r\n", offset);
            assert.ok(end >= 0);
            const lines = bytes.subarray(offset, end).toString("utf8").split("\r\n");
            const headers = Object.fromEntries(
              lines.slice(1).map((line) => {
                const split = line.indexOf(":");
                return [line.slice(0, split).toLowerCase(), line.slice(split + 1).trim()];
              }),
            );
            const length = Number(headers["content-length"] ?? 0);
            offset = end + 4;
            replies.push({
              status: Number(lines[0]!.split(" ")[1]),
              headers,
              body: bytes.subarray(offset, offset + length).toString("utf8"),
            });
            offset += length;
          }
          resolve(replies);
        } catch (error) {
          reject(error);
        }
      });
    });
  const original = NodeFs.prototype.readContentDigest;
  let observations = 0;
  NodeFs.prototype.readContentDigest = async function (file) {
    const value = await original.call(this, file);
    if (this.workspaceRoot === workspace && file === "Main/Main.md" && ++observations === 1)
      await tent.writeFile(
        "Main/Main.md",
        "---\nid: node-main\ntype: prompt\n---\nChanged between batches.\n",
      );
    return value;
  };
  try {
    const changed = await pipeline(String(baseline.headers.etag));
    assert.deepEqual(
      changed.map((reply) => reply.status),
      [304, 200, 200],
    );
    for (const reply of changed.slice(1))
      assert.equal(
        json<Snapshot>(reply).nodes.find((node) => node.id === "node-main")!.body,
        "Changed between batches.\n",
      );
    assert.equal(observations, 2);
    const unchanged = await pipeline(String(changed[1]!.headers.etag));
    assert.deepEqual(
      unchanged.map((reply) => reply.status),
      [304, 200, 304],
    );
    assert.equal(unchanged[1]!.headers.etag, changed[1]!.headers.etag);
    assert.equal(observations, 4);
  } finally {
    NodeFs.prototype.readContentDigest = original;
  }
});

test("disconnected sync requests drop queued work and skip inspection after the active revision", async (t) => {
  const { call, server, workspace } = await fixture(t);
  const token = new URL(server.url).hash.replace("#token=", "");
  let arrived!: () => void, disconnected!: () => void, observed!: () => void;
  let release!: () => void, completed!: () => void;
  const arrivals = new Promise<void>((resolve) => (arrived = resolve));
  const closures = new Promise<void>((resolve) => (disconnected = resolve));
  const firstDigest = new Promise<void>((resolve) => (observed = resolve));
  const hold = new Promise<void>((resolve) => (release = resolve));
  const firstScope = new Promise<void>((resolve) => (completed = resolve));
  const emit = http.Server.prototype.emit;
  const digest = NodeFs.prototype.readContentDigest;
  const header = NodeFs.prototype.readFrontmatter;
  const scope = NodeFs.prototype.observationScope;
  let requests = 0,
    closed = 0,
    digests = 0,
    inspections = 0,
    scopeStarted = false;
  http.Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const [req] = args as [http.IncomingMessage, http.ServerResponse];
      if (req.url === "/api/sync" && req.headers.authorization === `Bearer ${token}`) {
        if (++requests === 3) arrived();
        req.socket.once("close", () => {
          if (++closed === 3) disconnected();
        });
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  };
  NodeFs.prototype.readContentDigest = async function (file) {
    const value = await digest.call(this, file);
    if (this.workspaceRoot === workspace && file === "Main/Main.md" && ++digests === 1) {
      observed();
      await hold;
    }
    return value;
  };
  NodeFs.prototype.readFrontmatter = function (file) {
    if (this.workspaceRoot === workspace && file === "Main/Main.md") inspections++;
    return header.call(this, file);
  };
  NodeFs.prototype.observationScope = function <T>(
    action: () => Promise<T>,
    options?: { forceContent?: boolean },
  ) {
    const first = this.workspaceRoot === workspace && !scopeStarted;
    if (first) scopeStarted = true;
    const result = scope.call(this, action, options) as Promise<T>;
    return first ? result.finally(completed) : result;
  };
  const socket = net.createConnection({ host: "127.0.0.1", port: server.port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.on("error", reject);
    });
    socket.write(
      Array.from(
        { length: 3 },
        () =>
          `GET /api/sync HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${token}\r\nConnection: keep-alive\r\n\r\n`,
      ).join(""),
    );
    await Promise.all([arrivals, firstDigest]);
    socket.destroy();
    await closures;
    release();
    await firstScope;
    assert.equal(inspections, 0, "disconnected callers must not start the expensive sync phase");
    const next = await call("GET", "/api/sync");
    assert.equal(next.status, 200, next.body);
    assert.equal(digests, 2, "only the first read and the new live request should run");
    assert.ok(inspections > 0, "a later live request must still inspect current Nodes");
  } finally {
    socket.destroy();
    release();
    http.Server.prototype.emit = emit;
    NodeFs.prototype.readContentDigest = digest;
    NodeFs.prototype.readFrontmatter = header;
    NodeFs.prototype.observationScope = scope;
  }
});

test("saving checks the version the edit started from", async (t) => {
  const { call, tent } = await fixture(t);
  const opened = json<{ etag: string; version?: { commit: string } }>(
    await call("GET", "/api/nodes/node-main?capture=true"),
  );
  assert.ok(opened.version, "starting an edit records the base in history");

  const saved = await call("PUT", "/api/nodes/node-main", {
    json: { baseEtag: opened.etag, body: "Edited in the UI.\n" },
  });
  assert.equal(saved.status, 200);
  const result = json<{ etag: string; body: string; changed: boolean }>(saved);
  assert.equal(result.body, "Edited in the UI.\n");
  assert.equal(result.changed, true);

  await writeNodeDocument(tent, "node-main", {
    baseEtag: result.etag,
    body: "Edited elsewhere.\n",
  });
  const stale = await call("PUT", "/api/nodes/node-main", {
    json: { baseEtag: result.etag, body: "Mine.\n" },
  });
  assert.equal(stale.status, 409);
  const error = json<{ error: { code: string; details: { current: { body: string } } } }>(
    stale,
  ).error;
  assert.equal(error.code, "ETAG_CONFLICT");
  assert.equal(error.details.current.body, "Edited elsewhere.\n");

  const snapshot = json<Snapshot>(await call("GET", "/api/snapshot"));
  const change = snapshot.commits.find((c) => c.entry === "ui" && c.operation === "node.write")!;
  const file = change.files.find((f) => f.ref?.id === "node-main")!;
  const diff = json<{ text: string }>(
    await call(
      "GET",
      `/api/history/diff?from=${encodeURIComponent(`${file.before!.commit}:${file.before!.path}`)}&to=${encodeURIComponent(`${file.after!.commit}:${file.after!.path}`)}`,
    ),
  );
  assert.match(diff.text, /\+Edited in the UI\./);
  const before = json<{ raw: string }>(
    await call(
      "GET",
      `/api/history/document?at=${encodeURIComponent(`${file.before!.commit}:${file.before!.path}`)}`,
    ),
  );
  assert.match(before.raw, /See \[other\]/);
  const invalid = await call("GET", "/api/history/document?at=nothex:Main/Main.md");
  assert.equal(invalid.status, 422);
  const invalidError = json<{ error: { code: string; message: string } }>(invalid).error;
  assert.equal(invalidError.code, "INVALID_INPUT");
  assert.match(invalidError.message, /^commit: Invalid string/);
  assert.doesNotMatch(invalidError.message, /^\[|"code"|"path"/);
});

test("Cards are published with pinned sources", async (t) => {
  const { call } = await fixture(t);
  const created = await call("POST", "/api/cards", {
    json: { prompt: "Please look.", sources: [{ resource: "/Other/Other.md" }] },
  });
  assert.equal(created.status, 200);
  const { cardId } = json<{ cardId: string }>(created);
  const card = json<Snapshot>(await call("GET", "/api/snapshot")).cards.find(
    (c) => c.id === cardId,
  )!;
  assert.equal(card.state, "pending");
  assert.equal(card.sources[0]!.id, "node-other");
  assert.ok(card.sources[0]!.version, "the source is pinned");
  assert.equal((await call("POST", "/api/cards", { json: { prompt: 3 } })).status, 422);
});

test("workspace files are served by suffix; paths leaving the workspace are refused with 403", async (t) => {
  const { call, workspace } = await fixture(t);
  const image = await call("GET", "/api/files?path=docs/shot.png");
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/png");
  await fs.writeFile(path.join(workspace, "docs/page.html"), "<script>parent.x = 1</script>");
  const page = await call("GET", "/api/files?path=docs/page.html");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  // A direct visit could not run the page as the UI's origin.
  assert.equal(page.headers["content-security-policy"], "sandbox");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  const notes = await call("GET", "/api/files?path=docs/notes.txt");
  assert.equal(notes.status, 200);
  assert.equal(notes.headers["content-type"], "application/octet-stream");

  // A junction inside the workspace that leads out of it.
  const outside = path.join(path.dirname(workspace), "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(outside, path.join(workspace, "docs/out"), "junction");
  // A junction that stays inside the workspace but leads into its Git directory.
  await fs.symlink(
    path.join(workspace, ".tent/.git"),
    path.join(workspace, "docs/git"),
    "junction",
  );
  for (const target of [
    "../outside/secret.txt",
    "docs/../../outside/secret.txt",
    "docs/out/secret.txt",
    "docs/git/HEAD",
    ".tent/.git/HEAD",
    "/docs/shot.png",
    "C:/Windows/win.ini",
    "docs\\shot.png",
  ]) {
    const refused = await call("GET", `/api/files?path=${encodeURIComponent(target)}`);
    assert.equal(refused.status, 403, target);
    assert.equal(json<{ error: { code: string } }>(refused).error.code, "FORBIDDEN_PATH");
  }
  const info = await call("POST", "/api/files/info", { json: { paths: ["docs/git/HEAD"] } });
  assert.deepEqual(json<{ files: unknown }>(info).files, { "docs/git/HEAD": null });
  assert.equal((await call("GET", "/api/files?path=")).status, 422);
  assert.equal((await call("GET", "/api/files?path=docs/missing.png")).status, 404);
});

test("a Node's text files are read through the Node, only the ones it names and up to a cap", async (t) => {
  const { call, tent, workspace } = await fixture(t);
  await fs.writeFile(path.join(workspace, "docs/conf.json"), '{ "a": 1 }\n');
  await fs.writeFile(path.join(workspace, "docs/big.log"), "line of text\n".repeat(30_000));
  await fs.writeFile(path.join(workspace, "docs/blob.txt"), Buffer.from([0x61, 0x00, 0x62]));
  await tent.writeFile(
    "Code/Code.md",
    [
      "---",
      "id: node-code",
      "type: prompt",
      "resource: ../../docs/notes.txt",
      "sources:",
      "  - resource: ../../docs/conf.json",
      "  - resource: ../../docs/big.log",
      "  - resource: ../../docs/blob.txt",
      "---",
      "Code.",
      "",
    ].join("\n"),
  );
  const text = (p: string, id = "node-code") =>
    call("GET", `/api/nodes/${id}/text?path=${encodeURIComponent(p)}`);
  type Read = { text: string; size: number; truncated: boolean };

  const own = await text("docs/notes.txt");
  assert.equal(own.status, 200, own.body);
  assert.deepEqual((({ text, size, truncated }) => ({ text, size, truncated }))(json<Read>(own)), {
    text: "not an image",
    size: 12,
    truncated: false,
  });
  assert.equal(json<Read>(await text("docs/conf.json")).text, '{ "a": 1 }\n');
  // A long file comes as its head, cut at a line end.
  const big = json<Read>(await text("docs/big.log"));
  assert.equal(big.truncated, true);
  assert.equal(big.size, 13 * 30_000);
  assert.ok(big.text.length <= 256 * 1024 && big.text.endsWith("text\n"), String(big.text.length));
  assert.equal((await text("docs/blob.txt")).status, 415);
  // Files the Node does not name, even inside the workspace, are not read here.
  for (const p of ["docs/page.html", "Main/Main.md", ".tent/Main/Main.md", "docs/shot.png"])
    assert.equal((await text(p)).status, 403, p);
  assert.equal((await text("docs/notes.txt", "node-main")).status, 403);
  assert.equal((await text("docs/notes.txt", "node-nope")).status, 404);
});

test("file info reports sizes, and null for missing or refused paths", async (t) => {
  const { call, workspace } = await fixture(t);
  const info = await call("POST", "/api/files/info", {
    json: { paths: ["docs/shot.png", "docs/missing.png", "../outside.txt", "docs/shot.png"] },
  });
  assert.equal(info.status, 200);
  const files = json<{ files: Record<string, { size: number; modifiedAt: string } | null> }>(
    info,
  ).files;
  assert.equal(files["docs/shot.png"]!.size, 4);
  assert.ok(Date.parse(files["docs/shot.png"]!.modifiedAt));
  assert.equal(files["docs/missing.png"], null);
  assert.equal(files["../outside.txt"], null);

  // Any file name is a key of its own, `__proto__` included, whether the file is there or not.
  const named = async () =>
    json<{ files: Record<string, unknown> }>(
      await call("POST", "/api/files/info", { json: { paths: ["__proto__"] } }),
    ).files;
  await fs.writeFile(path.join(workspace, "__proto__"), "abc");
  const present = await named();
  assert.ok(Object.prototype.hasOwnProperty.call(present, "__proto__"));
  assert.equal((present["__proto__"] as { size: number }).size, 3);
  await fs.rm(path.join(workspace, "__proto__"));
  const gone = await named();
  assert.ok(Object.prototype.hasOwnProperty.call(gone, "__proto__"));
  assert.equal(gone["__proto__"], null);
  assert.equal(
    (await call("POST", "/api/files/info", { json: { paths: "docs/shot.png" } })).status,
    422,
  );
  assert.equal(
    (await call("POST", "/api/files/info", { json: { paths: Array(2001).fill("x") } })).status,
    422,
  );
});

test("filesystem failures other than a missing path are not reported as 404", async (t) => {
  const { call, dist } = await fixture(t);
  const failure = (code: string) => Object.assign(new Error(`${code}: injected failure`), { code });
  const realpath = fs.realpath;
  const stat = fs.stat;
  const image = path.join("docs", "shot.png");
  const index = path.resolve(dist, "index.html");
  const mocks = [
    t.mock.method(fs, "realpath", (async (target: string, options?: unknown) => {
      if (String(target).endsWith(image)) throw failure("EACCES");
      return realpath(target, options as never);
    }) as unknown as typeof fs.realpath),
    t.mock.method(fs, "stat", (async (target: string, options?: unknown) => {
      if (path.resolve(String(target)) === index) throw failure("EIO");
      return stat(target, options as never);
    }) as unknown as typeof fs.stat),
  ];
  // The server imports the fs/promises namespace; publish the mocks to its live bindings.
  syncBuiltinESMExports();
  try {
    const denied = await call("GET", "/api/files?path=docs/shot.png");
    assert.equal(denied.status, 500);
    assert.equal(json<{ error: { code: string } }>(denied).error.code, "INTERNAL");
    assert.equal((await call("GET", "/", { token: null })).status, 500);
    assert.equal((await call("GET", "/api/files?path=docs/missing.png")).status, 404);
    assert.equal((await call("GET", "/api/files?path=docs/shot.png/inner.png")).status, 404);
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await call("GET", "/api/files?path=docs/shot.png")).status, 200);
  assert.equal((await call("GET", "/", { token: null })).status, 200);
});

test("direct Card publication supports immutable reads, pending moves and reception conflicts", async (t) => {
  const { call, tent } = await fixture(t);
  await createRoleContext(tent, { roleId: "role-review", title: "Review", body: "Review" });
  await createRoleContext(tent, { roleId: "role-owner", title: "Owner", body: "Owner" });
  const created = await call("POST", "/api/cards", {
    json: {
      prompt: "Review this",
      sources: [{ resource: "/Other/Other.md" }],
      target: "role-review",
      returnTo: "role-owner",
    },
  });
  assert.equal(created.status, 200, created.body);
  const { cardId, etag } = json<{ cardId: string; etag: string }>(created);
  const endpoint = `/api/cards/${cardId}`;
  const opened = json<{ text: string; state: string; returnTo: string }>(
    await call("GET", endpoint),
  );
  assert.equal(opened.text, "Review this");
  assert.equal(opened.state, "pending");
  assert.equal(opened.returnTo, "role-owner");
  assert.equal(Object.prototype.hasOwnProperty.call(opened, "progress"), false);
  const live = json<Snapshot>(await call("GET", "/api/snapshot")).cards.find(
    (c) => c.id === cardId,
  )!;
  assert.ok(live.publishedAt);
  assert.ok(live.sources[0]!.version);
  assert.equal(live.state, "pending");
  assert.equal(live.returnTo, "role-owner");
  for (const [method, target] of [
    ["PUT", endpoint],
    ["DELETE", endpoint],
    ["POST", `${endpoint}/publish`],
    ["POST", "/api/cards/drafts"],
  ])
    assert.equal(
      (await call(method!, target!, { json: { baseEtag: etag, prompt: "unavailable" } })).status,
      404,
    );
  assert.equal(
    (await call("POST", `${endpoint}/move`, { json: { baseEtag: "stale", target: null } })).status,
    409,
  );
  assert.equal(
    (await call("POST", `${endpoint}/move`, { json: { baseEtag: etag, target: "role-missing" } }))
      .status,
    422,
  );
  const moved = await call("POST", `${endpoint}/move`, { json: { baseEtag: etag, target: null } });
  assert.equal(moved.status, 200, moved.body);
  await takeCardDocument(tent, cardId, "role-review");
  assert.equal(
    json<Snapshot>(await call("GET", "/api/snapshot")).cards.find((c) => c.id === cardId)!.state,
    "consumed",
  );
  const conflict = await call("POST", `${endpoint}/move`, {
    json: { baseEtag: json<{ etag: string }>(moved).etag, target: "role-review" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    json<{ error: { details: { current: { receivedBy: string } } } }>(conflict).error.details
      .current.receivedBy,
    "role-review",
  );
  const cardBytes = await tent.readFile(`cards/${cardId}.md`);
  const output = await linkNodeOutput(tent, "node-other", {
    resource: "docs/notes.txt",
    roleId: "role-review",
  });
  const completed = json<Snapshot>(await call("GET", "/api/snapshot"));
  const after = completed.cards.find((c) => c.id === cardId)!;
  assert.equal(after.state, "consumed");
  for (const key of ["progress", "goalCount", "totalGoalCount", "outputNodeIds"])
    assert.equal(Object.prototype.hasOwnProperty.call(after, key), false);
  const activity = completed.nodes.find((n) => n.id === output.nodeId)!.outputAt;
  assert.ok(activity && Number.isFinite(Date.parse(activity)));
  const document = json<{ etag: string }>(await call("GET", `/api/nodes/${output.nodeId}`));
  assert.equal(
    (
      await call("PUT", `/api/nodes/${output.nodeId}`, {
        json: { baseEtag: document.etag, body: "Ordinary wording update." },
      })
    ).status,
    200,
  );
  const edited = json<Snapshot>(await call("GET", "/api/snapshot"));
  assert.ok(
    Date.parse(edited.nodes.find((n) => n.id === output.nodeId)!.outputAt!) > Date.parse(activity),
  );
  assert.equal(await tent.readFile(`cards/${cardId}.md`), cardBytes);
  const result = `done ${output.nodeId}`;
  await returnCardDocument(tent, cardId, { roleId: "role-review", result });
  const returned = json<Snapshot>(await call("GET", "/api/snapshot")).cards.find(
    (c) => c.id === cardId,
  )!;
  assert.equal(returned.state, "returned");
  assert.equal(returned.receivedBy, "role-review");
  assert.equal(returned.returnTo, "role-owner");
  assert.equal(returned.result, result);
  await takeCardDocument(tent, cardId, "role-owner");
  const closed = json<Snapshot>(await call("GET", "/api/snapshot")).cards.find(
    (c) => c.id === cardId,
  )!;
  assert.equal(closed.state, "closed");
  assert.equal(closed.result, result);
});

for (const goalMaterialChanges of [false, true]) {
  const material = goalMaterialChanges ? "goal" : "output-only";
  test(`a fresh snapshot follows a ${material} material change outside Tent at the same revision`, async (t) => {
    const { call, tent, workspace } = await fixture(t);
    // Output-only material drift keeps completion; a changed goal basis needs new evidence.
    if (goalMaterialChanges)
      await tent.writeFile(
        "Other/Other.md",
        "---\nid: node-other\ntype: goal\nsources:\n  - resource: ../../docs/notes.txt\n---\nThe goal.\n",
      );
    await createRoleContext(tent, { roleId: "role-review", title: "Review", body: "Review" });
    await createRoleContext(tent, { roleId: "role-owner", title: "Owner", body: "Owner" });
    const created = await call("POST", "/api/cards", {
      json: {
        prompt: "Review this",
        sources: [{ resource: "/Other/Other.md" }],
        target: "role-review",
        returnTo: "role-owner",
      },
    });
    const { cardId } = json<{ cardId: string }>(created);
    await takeCardDocument(tent, cardId, "role-review");
    const output = await linkNodeOutput(tent, "node-other", {
      resource: "docs/notes.txt",
      roleId: "role-review",
    });
    const done = await call("GET", "/api/snapshot");
    const card = (r: typeof done) => json<Snapshot>(r).cards.find((c) => c.id === cardId)!;
    assert.equal(card(done).state, "consumed");
    const outputAt = json<Snapshot>(done).nodes.find((n) => n.id === output.nodeId)!.outputAt;
    assert.ok(outputAt);

    // No Tent commit: the revision stays, so the cached snapshot still says done.
    await fs.writeFile(path.join(workspace, "docs/notes.txt"), "changed outside Tent");
    const cached = await call("GET", "/api/snapshot");
    assert.equal(
      json<Snapshot>(cached).workspace.revision,
      json<Snapshot>(done).workspace.revision,
    );
    assert.equal(card(cached).state, "consumed");

    const fresh = await call("GET", "/api/snapshot?fresh=1", {
      headers: { "If-None-Match": done.headers.etag! },
    });
    assert.equal(fresh.status, 200);
    assert.equal(card(fresh).state, "consumed");
    assert.equal(Object.prototype.hasOwnProperty.call(card(fresh), "progress"), false);
    assert.equal(
      json<Snapshot>(fresh).nodes.find((n) => n.id === output.nodeId)!.outputAt,
      outputAt,
    );
    // Later reads share the rebuilt snapshot.
    assert.equal(card(await call("GET", "/api/snapshot")).state, "consumed");
  });
}

test("removed Card endpoints and invalid create requests never write Card files", async (t) => {
  const { call } = await fixture(t);
  for (const input of [
    { prompt: 4 },
    { prompt: "" },
    { prompt: "request", target: "role-missing" },
    { prompt: "request", returnTo: "role-missing" },
    { prompt: "request", returnTo: 4 },
    { prompt: "request", sources: ["invalid"] },
  ])
    assert.equal((await call("POST", "/api/cards", { json: input })).status, 422);
  assert.equal(
    (await call("POST", "/api/cards/drafts", { json: { prompt: "request" } })).status,
    404,
  );
  assert.equal(json<Snapshot>(await call("GET", "/api/snapshot")).cards.length, 0);
});

test("snapshot keeps Card source and Node history attached to identity after a move", async (t) => {
  const { call, tent, workspace } = await fixture(t);
  const created = json<{ cardId: string }>(
    await call("POST", "/api/cards", {
      json: { prompt: "Review Other", sources: [{ resource: "/Other/Other.md" }] },
    }),
  );
  await renameNode(
    {
      fs: tent,
      tentRoot: path.join(workspace, ".tent"),
      tentName: "UI",
      clock: { now: () => new Date().toISOString() },
    },
    "node-other",
    "Renamed",
  );
  await tent.writeFile(
    "Other/Other.md",
    "---\nid: node-replacement\ntype: goal\n---\nA different document.\n",
  );
  const snapshot = json<Snapshot>(await call("GET", "/api/snapshot"));
  const source = snapshot.cards.find((c) => c.id === created.cardId)!.sources[0]!;
  assert.equal(source.id, "node-other");
  assert.equal(source.changedSince, true);
  assert.equal(source.version!.path, "Other/Other.md");
  const node = snapshot.nodes.find((n) => n.id === "node-other")!;
  assert.ok(node.incoming.some((r) => r.from.id === created.cardId && r.via === "card-source"));
  assert.ok(node.history.length >= 2);
  const moved = snapshot.commits
    .find((c) => c.operation === "node.rename")!
    .files.find((f) => f.ref?.id === "node-other")!;
  assert.equal(moved.before!.path, "Other/Other.md");
  assert.equal(moved.after!.path, "Renamed/Renamed.md");
});

test("each workspace keeps its own port", () => {
  const port = workspacePort("ws-Tent-example");
  assert.equal(port, workspacePort("ws-Tent-example"));
  assert.ok(port >= 47800 && port < 48800);
});

test("a taken workspace port falls back to a free one and says so", async (t) => {
  const { workspace, tent, dist } = await fixture(t);
  const own = workspacePort((await readWorkspaceSettings(tent)).workspaceId!);
  const holder = http.createServer();
  // Something else may hold the port already; either way it is taken.
  await new Promise<void>((resolve) =>
    holder.once("error", () => resolve()).listen(own, "127.0.0.1", resolve),
  );
  t.after(() => holder.close());

  const server = await startUiServer({ workspaceRoot: workspace, staticDir: dist });
  t.after(() => server.close());
  assert.notEqual(server.port, own);
  assert.equal(server.portTaken, own);
});

/** One request to any service: the token comes from the URL it printed. */
function ask(
  served: { url: string; port: number },
  method: string,
  target: string,
  body?: unknown,
) {
  const token = new URL(served.url).hash.replace("#token=", "");
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<Reply>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: served.port,
        method,
        path: target,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(text === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(text)),
                Origin: `http://127.0.0.1:${served.port}`,
              }),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, headers: response.headers, body: data }),
        );
      },
    );
    request.on("error", reject);
    request.end(text);
  });
}

test("the list of opened workspaces lives per user, outside any .tent", () => {
  const home = path.join("/home", "dev");
  const appData = String.raw`C:\Users\dev\AppData\Roaming`;
  assert.equal(
    defaultWorkspacesFile({ APPDATA: appData }, "win32", home),
    path.join(appData, "tent", "ui-workspaces.json"),
  );
  assert.equal(
    defaultWorkspacesFile({}, "darwin", home),
    path.join(home, "Library", "Application Support", "tent", "ui-workspaces.json"),
  );
  assert.equal(
    defaultWorkspacesFile({}, "linux", home),
    path.join(home, ".local", "state", "tent", "ui-workspaces.json"),
  );
  for (const platform of ["win32", "darwin", "linux"] as const)
    assert.ok(!defaultWorkspacesFile({}, platform, home).split(/[\/]/).includes(".tent"));
});

test("remembered workspaces come newest first, once each, and at most twelve", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "ui-workspaces-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "ui-workspaces.json");
  assert.deepEqual(await readWorkspaces(file), []);
  for (let i = 0; i < 14; i++)
    await rememberWorkspace(
      file,
      { root: path.join(dir, `ws${i}`), name: `ws${i}`, id: `ws-${i}` },
      new Date(Date.UTC(2026, 9, 1, 0, i)),
    );
  await rememberWorkspace(file, { root: path.join(dir, "ws5"), name: "ws5", id: "ws-5" });
  const list = await readWorkspaces(file);
  assert.equal(list.length, 12);
  assert.deepEqual(
    list.slice(0, 3).map((w) => w.name),
    ["ws5", "ws13", "ws12"],
  );
  assert.equal(list.filter((w) => w.name === "ws5").length, 1);
  await fs.writeFile(file, "{ not json");
  assert.deepEqual(await readWorkspaces(file), []);
});

test("concurrent recent-workspace writes retain every entry", async (t) => {
  const dir = await fs.mkdtemp(path.join(testScratchRoot(), "ui-workspaces-concurrent-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ui-workspaces.json");
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      rememberWorkspace(file, { root: path.join(dir, `ws${i}`), name: `ws${i}`, id: `ws-${i}` }),
    ),
  );
  assert.deepEqual(
    (await readWorkspaces(file)).map((w) => w.name),
    ["ws7", "ws6", "ws5", "ws4", "ws3", "ws2", "ws1", "ws0"],
  );
});

test(
  "closing waits for a workspace still starting and closes its listener",
  { timeout: 15_000 },
  async (t) => {
    const { workspace, dist } = await fixture(t);
    const other = path.join(path.dirname(workspace), "starting");
    await initializeFixtureWorkspace(other);
    const { workspaceId } = await readWorkspaceSettings(new NodeFs(path.join(other, ".tent")));
    const first = await startUiServer({ workspaceRoot: workspace, staticDir: dist, port: 0 });
    t.after(() => first.close());
    let release!: () => void;
    let hit!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      hit = resolve;
    });
    const readFile = NodeFs.prototype.readFile;
    t.mock.method(NodeFs.prototype, "readFile", async function (this: NodeFs, file: string) {
      const value = await readFile.call(this, file);
      if (file === "settings.json" && JSON.parse(value).workspaceId === workspaceId) {
        hit();
        await gate;
      }
      return value;
    });
    const children: http.Server[] = [];
    let listened!: () => void;
    const listening = new Promise<void>((resolve) => {
      listened = resolve;
    });
    const listen = http.Server.prototype.listen;
    t.mock.method(
      http.Server.prototype,
      "listen",
      function (this: http.Server, ...args: Parameters<typeof listen>) {
        children.push(this);
        this.once("listening", listened);
        return listen.apply(this, args);
      },
    );
    t.after(async () => {
      release();
      for (const child of children) {
        if (!child.listening) continue;
        await new Promise<void>((resolve) => {
          child.close(() => resolve());
          child.closeAllConnections();
        });
      }
    });
    const opening = ask(first, "POST", "/api/workspaces/open", { path: other }).catch(
      () => undefined,
    );
    await blocked;
    let closed = false;
    const closing = first.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closedBeforeStartup = closed;
    release();
    await listening;
    await closing;
    await opening;
    assert.equal(closedBeforeStartup, false);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.listening, false);
  },
);

test("the page can switch to another workspace, served by the same process", async (t) => {
  const { workspace, dist } = await fixture(t);
  const root = path.dirname(workspace);
  const other = path.join(root, "other");
  await initializeFixtureWorkspace(other);
  const gone = path.join(root, "gone");
  await initializeFixtureWorkspace(gone);
  const file = path.join(root, "state", "ui-workspaces.json");

  const first = await startUiServer({
    workspaceRoot: workspace,
    staticDir: dist,
    port: 0,
    workspacesFile: file,
  });
  t.after(() => first.close());
  await rememberWorkspace(file, { root: gone, name: "gone", id: "ws-gone" });
  await fs.rm(gone, { recursive: true, force: true });
  const listed = json<{ workspaces: { name: string; current: boolean }[] }>(
    await ask(first, "GET", "/api/workspaces"),
  );
  // A folder that is no longer a workspace drops out; the current one is marked.
  assert.deepEqual(listed.workspaces, [{ root: workspace, name: "ws", current: true }]);

  const refused = await ask(first, "POST", "/api/workspaces/open", {
    path: path.join(root, "dist"),
  });
  assert.equal(refused.status, 422);
  assert.equal(json<{ error: { code: string } }>(refused).error.code, "NOT_A_WORKSPACE");
  const relative = await ask(first, "POST", "/api/workspaces/open", { path: "other" });
  assert.equal(json<{ error: { code: string } }>(relative).error.code, "INVALID_INPUT");

  const opened = await ask(first, "POST", "/api/workspaces/open", { path: other });
  assert.equal(opened.status, 200);
  const { url } = json<{ url: string }>(opened);
  const second = { url, port: Number(new URL(url).port) };
  assert.notEqual(second.port, first.port);
  const there = json<{ workspaces: { name: string; current: boolean }[] }>(
    await ask(second, "GET", "/api/workspaces"),
  );
  assert.deepEqual(
    there.workspaces.map((w) => [w.name, w.current]),
    [
      ["other", true],
      ["ws", false],
    ],
  );
  // Opening it again, or going back, finds the service already running.
  const again = json<{ url: string }>(
    await ask(first, "POST", "/api/workspaces/open", { path: other }),
  );
  assert.equal(again.url, url);
  const back = json<{ url: string }>(
    await ask(second, "POST", "/api/workspaces/open", { path: workspace }),
  );
  assert.equal(back.url, first.url);

  // Closing the service the command started closes what the page opened.
  await first.close();
  await assert.rejects(ask(second, "GET", "/api/revision"));
});

test("the page renames, archives, restores and deletes Nodes, archives Roles and withdraws Cards", async (t) => {
  const { tent, call } = await fixture(t);
  const snapshot = async () => json<Snapshot>(await call("GET", "/api/snapshot?fresh=1"));
  const node = async (id: string) => (await snapshot()).nodes.find((n) => n.id === id);

  const renamed = await call("POST", "/api/nodes/node-other/rename", { json: { name: "Goal" } });
  assert.equal(renamed.status, 200, renamed.body);
  assert.equal((await node("node-other"))?.name, "Goal");
  assert.match(await tent.readFile("Main/Main.md"), /\.\.\/Goal\/Goal\.md/);
  const clash = await call("POST", "/api/nodes/node-other/rename", { json: { name: "Main" } });
  assert.equal(clash.status, 409, clash.body);

  const archived = await call("POST", "/api/nodes/node-other/archive", { json: {} });
  assert.equal(archived.status, 200, archived.body);
  const commit = json<{ commit: string }>(archived).commit;
  assert.equal((await node("node-other"))?.status, "deprecated");
  const restored = await call("POST", "/api/nodes/node-other/restore", {
    json: { archiveCommit: commit },
  });
  assert.equal(restored.status, 200, restored.body);
  assert.equal((await node("node-other"))?.status, "stable");

  const deleted = await call("DELETE", "/api/nodes/node-other", { json: {} });
  assert.equal(deleted.status, 200, deleted.body);
  assert.equal(await node("node-other"), undefined);
  assert.equal((await call("DELETE", "/api/nodes/node-other", { json: {} })).status, 404);

  await createRoleContext(tent, { roleId: "role-review", title: "Review", body: "Review" });
  const role = json<{ etag: string }>(await call("GET", "/api/roles/role-review"));
  const off = await call("POST", "/api/roles/role-review/status", {
    json: { baseEtag: role.etag, archived: true },
  });
  assert.equal(off.status, 200, off.body);
  assert.equal((await snapshot()).roles[0]?.status, "deprecated");
  const stale = await call("POST", "/api/roles/role-review/status", {
    json: { baseEtag: role.etag, archived: false },
  });
  assert.equal(stale.status, 409, stale.body);
  const on = await call("POST", "/api/roles/role-review/status", {
    json: { baseEtag: json<{ etag: string }>(await call("GET", "/api/roles/role-review")).etag },
  });
  assert.equal(on.status, 200, on.body);
  assert.equal((await snapshot()).roles[0]?.status, "stable");
  assert.doesNotMatch(await tent.readFile("roles/role-review.md"), /^status:/m);

  const card = json<{ cardId: string; etag: string }>(
    await call("POST", "/api/cards", { json: { prompt: "Check it", target: "role-review" } }),
  );
  const withdrawn = await call("POST", `/api/cards/${card.cardId}/deprecate`, {
    json: { baseEtag: card.etag },
  });
  assert.equal(withdrawn.status, 200, withdrawn.body);
  assert.equal((await snapshot()).cards.find((c) => c.id === card.cardId)?.status, "deprecated");
});

test("Role delete HTTP reports unfinished returns and permits deprecated receipts", async (t) => {
  const { tent, call } = await fixture(t);
  const worker = await createRoleContext(tent, { roleId: "role-worker", title: "Worker" });
  const owner = await createRoleContext(tent, { roleId: "role-owner", title: "Owner" });
  const card = json<{ cardId: string }>(
    await call("POST", "/api/cards", {
      json: { prompt: "Return this", target: worker.roleId, returnTo: owner.roleId },
    }),
  );
  await takeCardDocument(tent, card.cardId, worker.roleId);
  for (const role of [worker, owner]) {
    const blocked = await call("DELETE", `/api/roles/${role.roleId}`, {
      json: { baseEtag: role.etag },
    });
    assert.equal(blocked.status, 409, blocked.body);
    assert.deepEqual(
      json<{ error: { code: string; details: { cardIds: string[] } } }>(blocked).error,
      {
        code: "PENDING_CARDS",
        message: `Role has unfinished Cards: ${card.cardId}. Deprecate them, or move pending ones, before deleting it.`,
        details: { cardIds: [card.cardId] },
      },
    );
  }
  await returnCardDocument(tent, card.cardId, { roleId: worker.roleId, result: "done" });
  assert.equal(
    (await call("DELETE", `/api/roles/${worker.roleId}`, { json: { baseEtag: worker.etag } }))
      .status,
    200,
  );
  assert.equal(
    (await call("DELETE", `/api/roles/${owner.roleId}`, { json: { baseEtag: owner.etag } })).status,
    409,
  );
  const current = json<{ etag: string }>(await call("GET", `/api/cards/${card.cardId}`));
  const cancelled = await call("POST", `/api/cards/${card.cardId}/deprecate`, {
    json: { baseEtag: current.etag },
  });
  assert.equal(cancelled.status, 200, cancelled.body);
  assert.equal(
    (await call("DELETE", `/api/roles/${owner.roleId}`, { json: { baseEtag: owner.etag } })).status,
    200,
  );
});

test("the page deletes a Role only once no pending Card waits for it", async (t) => {
  const { tent, call } = await fixture(t);
  const snapshot = async () => json<Snapshot>(await call("GET", "/api/snapshot?fresh=1"));
  await createRoleContext(tent, { roleId: "role-review", title: "Review", body: "Review" });
  const etag = json<{ etag: string }>(await call("GET", "/api/roles/role-review")).etag;
  const make = async (prompt: string) =>
    json<{ cardId: string; etag: string }>(
      await call("POST", "/api/cards", { json: { prompt, target: "role-review" } }),
    );
  const done = await make("Already received");
  await takeCardDocument(tent, done.cardId, "role-review");
  const waiting = [await make("Still waiting"), await make("Also waiting")];

  // Every pending Card is named so the page can list them.
  const blocked = await call("DELETE", "/api/roles/role-review", { json: { baseEtag: etag } });
  assert.equal(blocked.status, 409, blocked.body);
  const error = json<{ error: { code: string; details: { cardIds: string[] } } }>(blocked).error;
  assert.equal(error.code, "PENDING_CARDS");
  assert.deepEqual(error.details.cardIds, waiting.map((c) => c.cardId).sort());

  // One moves to the public area, the other is withdrawn; then the Role can go.
  const moved = await call("POST", `/api/cards/${waiting[0]!.cardId}/move`, {
    json: { baseEtag: waiting[0]!.etag, target: null },
  });
  assert.equal(moved.status, 200, moved.body);
  const withdrawn = await call("POST", `/api/cards/${waiting[1]!.cardId}/deprecate`, {
    json: { baseEtag: waiting[1]!.etag },
  });
  assert.equal(withdrawn.status, 200, withdrawn.body);
  const missing = await call("DELETE", "/api/roles/role-review", { json: {} });
  assert.equal(missing.status, 422, missing.body);
  const deleted = await call("DELETE", "/api/roles/role-review", { json: { baseEtag: etag } });
  assert.equal(deleted.status, 200, deleted.body);

  const after = await snapshot();
  assert.equal(after.roles.length, 0);
  // What it received stays a fact of the Card.
  assert.equal(after.cards.find((c) => c.id === done.cardId)?.receivedBy, "role-review");
  assert.equal(
    (await call("DELETE", "/api/roles/role-review", { json: { baseEtag: etag } })).status,
    404,
  );
});

test("the page carries no inline script, which its policy would block", async () => {
  const html = await fs.readFile(path.resolve("src/ui/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs!, /\bsrc="\/[^"]+"/);
    assert.equal(body!.trim(), "");
  }
});

test("code facts endpoint is protected, read-only and names the tests importing each part", async (t) => {
  const { call, tent, workspace } = await fixture(t);
  await git(workspace, "init", "-b", "main");
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  for (const dir of ["a", "b", "test"]) await fs.mkdir(path.join(workspace, dir));
  await fs.writeFile(path.join(workspace, "a/main.ts"), 'import "../b/lib.js";');
  await fs.writeFile(path.join(workspace, "b/lib.ts"), "export const n = 1;");
  await fs.writeFile(path.join(workspace, "test/main.test.ts"), 'import "../a/main.js";');
  for (const name of ["a", "b"])
    await tent.writeFile(
      `${name}/${name}.md`,
      serializeFrontmatter(
        {
          id: `node-${name}`,
          type: "goal",
          sources: [{ resource: `../../${name}/`, track: "structure" }],
        },
        "What this part is for.",
      ),
    );
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "fixture");
  const head = (await git(workspace, "rev-parse", "HEAD")).trim();
  const index = await fs.readFile(path.join(workspace, ".git/index"));
  const endpoint = "/api/modules/facts";
  assert.equal((await call("GET", endpoint, { token: null })).status, 401);
  assert.equal((await call("POST", endpoint, { json: {} })).status, 404);
  const reply = await call("GET", endpoint);
  assert.equal(reply.status, 200, reply.body);
  const facts = json<CodeFacts>(reply);
  assert.equal(facts.head, head);
  const a = facts.modules.find((m) => m.id === "node-a");
  assert.deepEqual(a?.testedBy, ["test/main.test.ts"]);
  assert.ok(Array.isArray(a?.coChanges));
  assert.deepEqual(await fs.readFile(path.join(workspace, ".git/index")), index);
  assert.equal((await git(workspace, "rev-parse", "HEAD")).trim(), head);
});

for (const change of ["rename", "delete"] as const) {
  test(`creating a child preserves parent identity across ${change} and path reuse`, async (t) => {
    const { call, tent, workspace } = await fixture(t);
    const env = {
      fs: tent,
      clock: { now: () => new Date().toISOString() },
      tentName: "Parent race",
    };
    const withLock = NodeFs.prototype.withLock;
    let injected = false;
    let replacement = "";
    t.mock.method(NodeFs.prototype, "withLock", async function <
      T,
    >(this: NodeFs, file: string, action: () => Promise<T>): Promise<T> {
      if (this.workspaceRoot === workspace && !injected) {
        injected = true;
        if (change === "rename") await renameNode(env, "node-other", "Renamed");
        else await deleteNode(env, "node-other");
        replacement = await createNode(env, { parentPath: "", name: "Other", type: "goal" });
      }
      return withLock.call(this, file, action) as Promise<T>;
    });
    const made = await call("POST", "/api/nodes", {
      json: { name: "Child", type: "prompt", parent: "node-other" },
    });
    assert.equal(injected, true);
    const map = json<WorkspaceMap>(await call("GET", "/api/map"));
    assert.ok(map.nodes.some((node) => node.id === replacement && node.path === "Other"));
    if (change === "rename") {
      assert.equal(made.status, 200, made.body);
      const child = map.nodes.find((node) => node.id === json<{ nodeId: string }>(made).nodeId);
      assert.equal(child?.parentId, "node-other");
      assert.equal(child?.path, "Renamed/Child");
    } else {
      assert.ok(made.status >= 400 && made.status < 500, made.body);
      assert.equal(
        map.nodes.some((node) => node.name === "Child"),
        false,
      );
    }
    assert.equal(await tent.exists("Other/Child"), false);
  });
}

test("the sidebar makes a Node under another and moves Nodes, keeping links that point at them", async (t) => {
  const { tent, call } = await fixture(t);
  const snapshot = async () => json<Snapshot>(await call("GET", "/api/snapshot?fresh=1"));
  const node = async (id: string) => (await snapshot()).nodes.find((n) => n.id === id);

  const made = await call("POST", "/api/nodes", {
    json: { name: "Plan", type: "prompt", parent: "node-other" },
  });
  assert.equal(made.status, 200, made.body);
  const planId = json<{ nodeId: string }>(made).nodeId;
  assert.equal((await node(planId))?.parentId, "node-other");
  const top = await call("POST", "/api/nodes", {
    json: { name: "Notes", type: "goal", parent: null },
  });
  assert.equal(top.status, 200, top.body);
  assert.equal((await node(json<{ nodeId: string }>(top).nodeId))?.parentId, null);
  assert.equal(
    (
      await call("POST", "/api/nodes", {
        json: { name: "Plan", type: "prompt", parent: "node-other" },
      })
    ).status,
    409,
  );
  assert.equal(
    (await call("POST", "/api/nodes", { json: { name: "X", type: "prompt", parent: "../etc" } }))
      .status,
    422,
  );

  // Into another Node: the folder goes with it and links to it still resolve.
  const moved = await call("POST", "/api/nodes/node-other/move", { json: { parent: "node-main" } });
  assert.equal(moved.status, 200, moved.body);
  assert.equal((await node("node-other"))?.parentId, "node-main");
  assert.equal((await node(planId))?.parentId, "node-other");
  assert.match(await tent.readFile("Main/Main.md"), /Other\/Other\.md/);
  // Back to the top, before Main.
  const back = await call("POST", "/api/nodes/node-other/move", {
    json: { parent: null, before: "node-main" },
  });
  assert.equal(back.status, 200, back.body);
  const roots = (await snapshot()).nodes.filter((n) => n.parentId === null).map((n) => n.id);
  assert.ok(roots.indexOf("node-other") < roots.indexOf("node-main"), roots.join(" "));
  // Not into itself.
  assert.equal(
    (await call("POST", "/api/nodes/node-other/move", { json: { parent: planId } })).status,
    409,
  );
});
