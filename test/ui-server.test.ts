import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { renameNode } from "../src/core/ops.js";
import { readWorkspaceSettings } from "../src/core/workspace-settings.js";
import { createRoleContext } from "../src/core/role-context.js";
import { transitionCardDocument } from "../src/core/card-document.js";
import { startUiServer, workspacePort } from "../src/ui-server/server.js";
import {
  defaultWorkspacesFile,
  readWorkspaces,
  rememberWorkspace,
} from "../src/ui-server/workspaces.js";
import type { Snapshot } from "../src/ui/data/types.js";
import { testScratchRoot } from "./scratch.js";
import { incompleteNodeReadEtag } from "../src/core/node-read-basis.js";
import { contentEtag } from "../src/core/etag.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };
type Call = (
  method: string,
  target: string,
  options?: { headers?: Record<string, string>; json?: unknown; token?: string | null },
) => Promise<Reply>;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "ui-server-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "ws");
  await initializeTentWorkspace(workspace);
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
  const current = await read();
  const raw = await call("PUT", "/api/nodes/node-main", {
    json: {
      baseEtag: current.etag,
      raw: serializeFrontmatter(current.frontmatter, "raw Web update"),
    },
  });
  assert.equal(raw.status, 200, raw.body);
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

test("annotations are saved whole, against the version they started from", async (t) => {
  const { call } = await fixture(t);
  assert.deepEqual(json(await call("GET", "/api/annotations")), { etag: null, document: null });
  const document = (x: number) => ({
    schemaVersion: 1,
    map: {
      elements: [
        {
          id: "el-1",
          type: "freedraw",
          x,
          y: 0,
          points: [
            [0, 0],
            [4, 2],
          ],
        },
      ],
      anchors: { "el-1": { node: "node-main", x: 10, y: 20 } },
    },
  });
  const first = await call("PUT", "/api/annotations", {
    json: { baseEtag: null, document: document(1) },
  });
  assert.equal(first.status, 200);
  const { etag } = json<{ etag: string }>(first);
  assert.equal(
    (await call("PUT", "/api/annotations", { json: { baseEtag: etag, document: document(2) } }))
      .status,
    200,
  );
  const stale = await call("PUT", "/api/annotations", {
    json: { baseEtag: etag, document: document(3) },
  });
  assert.equal(stale.status, 409);
  const current = json<{
    error: { details: { current: { document: { map: { elements: Array<{ x: number }> } } } } };
  }>(stale);
  assert.equal(current.error.details.current.document.map.elements[0]!.x, 2);
  const invalid = document(4);
  invalid.map.anchors["el-1"]!.node = "not-a-node";
  const rejected = await call("PUT", "/api/annotations", {
    json: {
      baseEtag: json<{ etag: string }>(await call("GET", "/api/annotations")).etag,
      document: invalid,
    },
  });
  assert.equal(rejected.status, 422);

  const commits = json<Snapshot>(await call("GET", "/api/snapshot")).commits;
  assert.equal(commits.filter((c) => c.operation === "annotations.write").length, 2);
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

test("only images inside the workspace are served", async (t) => {
  const { call } = await fixture(t);
  const image = await call("GET", "/api/files?path=docs/shot.png");
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/png");
  for (const target of [
    "docs/notes.txt",
    "../ws/docs/shot.png",
    ".tent/.git/HEAD",
    "/docs/shot.png",
  ])
    assert.equal(
      (await call("GET", `/api/files?path=${encodeURIComponent(target)}`)).status,
      422,
      target,
    );
  assert.equal((await call("GET", "/api/files?path=docs/missing.png")).status, 404);
});

test("workspace drafts support reload, CAS, publication, movement and reception conflicts", async (t) => {
  const { call, tent } = await fixture(t);
  await createRoleContext(tent, { roleId: "role-review", title: "Review", body: "Review" });
  const initial = json<Snapshot>(await call("GET", "/api/snapshot")).workspace.revision;
  const created = await call("POST", "/api/cards/drafts", { json: { prompt: "", sources: [] } });
  assert.equal(created.status, 200, created.body);
  const { cardId, etag } = json<{ cardId: string; etag: string }>(created);
  const endpoint = `/api/cards/${cardId}`;
  const snapshot = json<Snapshot>(await call("GET", "/api/snapshot"));
  assert.notEqual(snapshot.workspace.revision, initial);
  assert.equal(snapshot.cards.find((c) => c.id === cardId)!.publishedAt, null);
  const opened = json<{ etag: string; text: string; draft: boolean }>(await call("GET", endpoint));
  assert.equal(opened.etag, etag);
  assert.equal(opened.text, "");
  assert.equal(opened.draft, true);
  const saved = await call("PUT", endpoint, {
    json: {
      baseEtag: etag,
      prompt: "Review this",
      sources: [{ resource: "/Other/Other.md" }],
      target: "role-review",
    },
  });
  assert.equal(saved.status, 200, saved.body);
  const next = json<{ etag: string }>(saved).etag;
  assert.equal(
    (await call("PUT", endpoint, { json: { baseEtag: etag, prompt: "stale" } })).status,
    409,
  );
  assert.equal((await call("DELETE", endpoint, { json: { baseEtag: etag } })).status, 409);
  assert.equal(
    (await call("POST", `${endpoint}/publish`, { json: { baseEtag: etag } })).status,
    409,
  );
  const published = await call("POST", `${endpoint}/publish`, { json: { baseEtag: next } });
  assert.equal(published.status, 200, published.body);
  let baseEtag = json<{ etag: string }>(published).etag;
  const live = json<Snapshot>(await call("GET", "/api/snapshot")).cards.find(
    (c) => c.id === cardId,
  )!;
  assert.ok(live.publishedAt);
  assert.ok(live.sources[0]!.version);
  assert.equal(
    (await call("PUT", endpoint, { json: { baseEtag, prompt: "rewrite" } })).status,
    409,
  );
  assert.equal((await call("DELETE", endpoint, { json: { baseEtag } })).status, 409);
  assert.equal(
    (await call("POST", `${endpoint}/move`, { json: { baseEtag, target: "role-missing" } })).status,
    422,
  );
  assert.equal((await call("POST", `${endpoint}/move`, { json: { baseEtag } })).status, 422);
  const moved = await call("POST", `${endpoint}/move`, { json: { baseEtag, target: null } });
  assert.equal(moved.status, 200, moved.body);
  assert.equal(
    json<Snapshot>(await call("GET", "/api/snapshot")).cards.find((c) => c.id === cardId)!.target,
    null,
  );
  baseEtag = json<{ etag: string }>(moved).etag;
  await transitionCardDocument(tent, cardId, "role-review", "take");
  const conflict = await call("POST", `${endpoint}/move`, {
    json: { baseEtag, target: "role-review" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    json<{ error: { details: { current: { receivedBy: string } } } }>(conflict).error.details
      .current.receivedBy,
    "role-review",
  );
});

test("deleting a draft updates the snapshot and invalid draft requests do not write", async (t) => {
  const { call } = await fixture(t);
  for (const input of [
    { prompt: 4 },
    { prompt: "", target: "role-missing" },
    { prompt: "", sources: ["invalid"] },
  ])
    assert.equal((await call("POST", "/api/cards/drafts", { json: input })).status, 422);
  assert.equal(json<Snapshot>(await call("GET", "/api/snapshot")).cards.length, 0);
  const draft = json<{ cardId: string; etag: string }>(
    await call("POST", "/api/cards/drafts", { json: { prompt: "" } }),
  );
  const endpoint = `/api/cards/${draft.cardId}`;
  assert.equal(
    (await call("POST", `${endpoint}/publish`, { json: { baseEtag: draft.etag } })).status,
    422,
  );
  assert.equal((await call("DELETE", endpoint, { json: { baseEtag: draft.etag } })).status, 200);
  assert.equal((await call("GET", endpoint)).status, 404);
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
    await initializeTentWorkspace(other);
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
  await initializeTentWorkspace(other);
  const gone = path.join(root, "gone");
  await initializeTentWorkspace(gone);
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
