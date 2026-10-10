import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { userInfo } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { writeNodeDocument } from "../src/core/node-document-write.js";
import { renameNode } from "../src/core/ops.js";
import { readWorkspaceSettings } from "../src/core/workspace-settings.js";
import { createRoleContext } from "../src/core/role-context.js";
import { linkNodeOutput } from "../src/core/node-sync.js";
import { takeCardDocument } from "../src/core/card-document.js";
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
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
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
  const created = await call("POST", "/api/cards", {
    json: {
      prompt: "Review this",
      sources: [{ resource: "/Other/Other.md" }],
      target: "role-review",
    },
  });
  assert.equal(created.status, 200, created.body);
  const { cardId, etag } = json<{ cardId: string; etag: string }>(created);
  const endpoint = `/api/cards/${cardId}`;
  const opened = json<{ text: string; progress: string; outputNodeIds: string[] }>(
    await call("GET", endpoint),
  );
  assert.equal(opened.text, "Review this");
  assert.equal(opened.progress, "pending");
  assert.deepEqual(opened.outputNodeIds, []);
  const live = json<Snapshot>(await call("GET", "/api/snapshot")).cards.find(
    (c) => c.id === cardId,
  )!;
  assert.ok(live.publishedAt);
  assert.ok(live.sources[0]!.version);
  assert.equal(live.progress, "pending");
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
    json<Snapshot>(await call("GET", "/api/snapshot")).cards.find((c) => c.id === cardId)!.progress,
    "received-no-output",
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
  assert.equal(after.progress, "has-output");
  assert.deepEqual(after.outputNodeIds, [output.nodeId]);
  assert.equal(after.goalCount, 1);
  assert.equal(after.totalGoalCount, 1);
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
});

test("a fresh snapshot follows a material change outside Tent at the same revision", async (t) => {
  const { call, tent, workspace } = await fixture(t);
  await createRoleContext(tent, { roleId: "role-review", title: "Review", body: "Review" });
  const created = await call("POST", "/api/cards", {
    json: {
      prompt: "Review this",
      sources: [{ resource: "/Other/Other.md" }],
      target: "role-review",
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
  assert.equal(card(done).progress, "has-output");

  // No Tent commit: the revision stays, so the cached snapshot still says done.
  await fs.writeFile(path.join(workspace, "docs/notes.txt"), "changed outside Tent");
  const cached = await call("GET", "/api/snapshot");
  assert.equal(json<Snapshot>(cached).workspace.revision, json<Snapshot>(done).workspace.revision);
  assert.equal(card(cached).progress, "has-output");

  const fresh = await call("GET", "/api/snapshot?fresh=1", {
    headers: { "If-None-Match": done.headers.etag! },
  });
  assert.equal(fresh.status, 200);
  assert.equal(card(fresh).progress, "needs-review");
  assert.deepEqual(card(fresh).reviewOutputNodeIds, [output.nodeId]);
  assert.equal(
    json<Snapshot>(fresh).nodes.find((n) => n.id === output.nodeId)!.outputAt,
    undefined,
  );
  // Later reads share the rebuilt snapshot.
  assert.equal(card(await call("GET", "/api/snapshot")).progress, "needs-review");
});

test("removed Card endpoints and invalid create requests never write Card files", async (t) => {
  const { call } = await fixture(t);
  for (const input of [
    { prompt: 4 },
    { prompt: "" },
    { prompt: "request", target: "role-missing" },
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
