import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { cardOrderKey, cardOrderBetween, validCardOrder } from "../src/core/base/card-order.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { contentEtag } from "../src/core/base/etag.js";
import {
  createCardDocument,
  takeCardDocument,
  returnCardDocument,
  moveCardDocument,
  watchCardDocuments,
  listCardDocuments,
  deprecateCardDocument,
} from "../src/core/graph/card-document.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { inspectCurrentContext, makeContextBrief } from "../src/core/read/context-brief.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { startUiServer } from "../src/ui-server/server.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "card-order-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await initializeFixtureWorkspace(root);
  const adapter = new NodeFs(path.join(root, ".tent"));
  for (const id of ["role-a", "role-b"])
    await createRoleContext(adapter, { roleId: id, title: id, body: "Work" });
  const create = (id: string, target?: string, returnTo?: string) =>
    createCardDocument(adapter, {
      cardId: id,
      target,
      returnTo,
      prompt: "Keep this input",
      title: id,
    });
  const pending = async (roleId: string, includeOpen = false) =>
    (await watchCardDocuments(adapter, roleId, 0, { includeOpen })).map((item) => item.cardId);
  return { root, adapter, create, pending };
}

test("fractional Card keys retain exact default ties and allow repeated insertion at every boundary", () => {
  const time = "2026-01-01T08:00:00+08:00";
  const keys = [
    cardOrderKey("card-a", time),
    cardOrderKey("card-aa", time),
    cardOrderKey("card-z", time),
  ];
  assert.equal(keys[0], "2026-01-01T00:00:00.000Z|card-a");
  const tail = cardOrderBetween("card-moved", keys.at(-1));
  assert.equal(tail, `${keys.at(-1)}~card-moved`);
  assert.ok(tail < cardOrderKey("card-next", "2026-01-01T00:00:01.000Z"));
  for (let i = 0; i < 1000; i++) {
    const position = i % 3 === 0 ? 0 : i % 3 === 1 ? keys.length : (i * 7919) % keys.length;
    const lower = keys[position - 1],
      upper = keys[position];
    const key = cardOrderBetween(`card-${i}`, lower, upper);
    assert.ok(lower === undefined || lower < key);
    assert.ok(upper === undefined || key < upper);
    assert.ok(validCardOrder(`card-${i}`, key));
    assert.ok(!validCardOrder("card-other", key));
    keys.splice(position, 0, key);
  }
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(new Set(keys).size, keys.length);
});

test("same-second insertion moves only one Card, retains its input, and no-op and stale ETags stay distinct", async (t) => {
  const { adapter, create, pending } = await fixture(t);
  const a = await create("card-a", "role-a"),
    c = await create("card-c", "role-a"),
    b = await create("card-b", "role-a");
  t.mock.method(
    adapter.history,
    "firstCommitTimes",
    async (paths: readonly string[]) =>
      new Map(
        paths.map((p) => [
          p,
          p === "cards/card-later.md"
            ? "2026-01-01T00:00:02.000Z"
            : p === b.path
              ? "2026-01-01T00:00:01.000Z"
              : "2026-01-01T00:00:00.000Z",
        ]),
      ),
  );
  const queueTimes = adapter.history.cardQueueTimes.bind(adapter.history);
  t.mock.method(
    adapter.history,
    "cardQueueTimes",
    async (head: string, paths: readonly string[]) => ({
      ...(await queueTimes(head, paths)),
      published: await adapter.history.firstCommitTimes(paths),
    }),
  );
  assert.deepEqual(await pending("role-a"), [a.cardId, c.cardId, b.cardId]);
  const fixed = [await adapter.readFile(a.path), await adapter.readFile(c.path)];
  const before = await adapter.history.currentCommit();
  const moved = await moveCardDocument(adapter, b.cardId, {
    before: c.cardId,
    expectedEtag: b.etag,
  });
  assert.deepEqual(await pending("role-a"), [a.cardId, b.cardId, c.cardId]);
  const events = await adapter.history.changesInRange({ from: before! });
  assert.deepEqual(
    events.flatMap((e) => e.changes.map((c) => c.objectId)),
    [b.cardId],
  );
  assert.deepEqual([await adapter.readFile(a.path), await adapter.readFile(c.path)], fixed);
  const saved = parseFrontmatter(await adapter.readFile(b.path));
  assert.equal(saved.body.trim(), "Keep this input");
  assert.equal(saved.data.title, b.cardId);
  assert.ok(validCardOrder(b.cardId, saved.data.order));
  const noop = await moveCardDocument(adapter, b.cardId, {
    after: a.cardId,
    expectedEtag: moved.etag,
  });
  assert.deepEqual(noop.version, moved.version);
  await assert.rejects(
    moveCardDocument(adapter, b.cardId, { after: a.cardId, expectedEtag: b.etag }),
    (e: any) => e.code === "STATE_CHANGED",
  );
  const first = await moveCardDocument(adapter, b.cardId, {
    before: a.cardId,
    expectedEtag: moved.etag,
  });
  assert.deepEqual(await pending("role-a"), [b.cardId, a.cardId, c.cardId]);
  const last = await moveCardDocument(adapter, b.cardId, { expectedEtag: first.etag });
  assert.deepEqual(await pending("role-a"), [a.cardId, c.cardId, b.cardId]);
  const listed = (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items;
  assert.deepEqual(
    listed.map((x) => x.cardId),
    await pending("role-a"),
  );
  const later = await create("card-later", "role-a");
  assert.deepEqual(await pending("role-a"), [a.cardId, c.cardId, b.cardId, later.cardId]);
  assert.equal(parseFrontmatter(await adapter.readFile(later.path)).data.order, undefined);
  const raw = await adapter.readFile(b.path);
  const changed = serializeFrontmatter(
    { ...saved.data, order: cardOrderBetween(b.cardId) },
    saved.body,
  );
  await adapter.writeFile(b.path, changed);
  await assert.rejects(
    takeCardDocument(adapter, b.cardId, "role-a"),
    (e: any) => e.code === "STATE_CHANGED",
  );
  await adapter.writeFile(b.path, raw);
  await takeCardDocument(adapter, b.cardId, "role-a");
  await assert.rejects(
    moveCardDocument(adapter, b.cardId, { before: a.cardId, expectedEtag: last.etag }),
    (e: any) => e.code === "RECEPTION_CONFLICT",
  );
});

test("positions are destination-local and public Cards are opt-in, ordered and claimed only once", async (t) => {
  const { root, adapter, create, pending } = await fixture(t);
  const a = await create("card-own", "role-a"),
    b = await create("card-other", "role-b"),
    open = await create("card-open"),
    second = await create("card-second");
  assert.deepEqual(await pending("role-a"), [a.cardId]);
  assert.deepEqual(
    (await watchCardDocuments(adapter, "role-a", 0, { includeOpen: true }))
      .filter((x) => x.fromPublic)
      .map((x) => x.cardId),
    [open.cardId, second.cardId],
  );
  await assert.rejects(
    moveCardDocument(adapter, a.cardId, { before: b.cardId, expectedEtag: a.etag }),
    /destination queue/,
  );
  await assert.rejects(
    moveCardDocument(adapter, a.cardId, { before: a.cardId, expectedEtag: a.etag }),
    /own position/,
  );
  await assert.rejects(
    moveCardDocument(adapter, a.cardId, {
      before: open.cardId,
      after: second.cardId,
      expectedEtag: a.etag,
    }),
    /not both/,
  );
  const moved = await moveCardDocument(adapter, a.cardId, {
    target: null,
    after: open.cardId,
    expectedEtag: a.etag,
  });
  assert.deepEqual(await pending("role-a", true), [open.cardId, a.cardId, second.cardId]);
  const assigned = await moveCardDocument(adapter, a.cardId, {
    target: "role-b",
    before: b.cardId,
    expectedEtag: moved.etag,
  });
  assert.deepEqual(await pending("role-b"), [a.cardId, b.cardId]);
  const brief = makeContextBrief(await inspectCurrentContext(adapter, { roleId: "role-b" }), {
    roleId: "role-b",
  });
  assert.deepEqual(
    brief.cardInputs.map((card) => card.cardId),
    [a.cardId, b.cardId, open.cardId, second.cardId],
  );
  await deprecateCardDocument(adapter, b.cardId, b.etag);
  await assert.rejects(
    moveCardDocument(adapter, a.cardId, { before: b.cardId, expectedEtag: assigned.etag }),
    /destination queue/,
  );
  const race = await Promise.allSettled([
    takeCardDocument(adapter, open.cardId, "role-a"),
    takeCardDocument(new NodeFs(path.join(root, ".tent")), open.cardId, "role-b"),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  const winner = (race.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<any>).value
    .receivedBy;
  const loser = (race.find((x) => x.status === "rejected") as PromiseRejectedResult).reason;
  assert.equal(loser.code, "RECEPTION_CONFLICT");
  assert.equal(loser.details.current.receivedBy, winner);
  assert.match(loser.message, new RegExp(winner));
});

test("watch emits the role queue, then opted-in public queue, then returns in return-time order", async (t) => {
  const { root, adapter, create, pending } = await fixture(t);
  const r1 = await create("card-returna", "role-b", "role-a"),
    r2 = await create("card-returnz", "role-b", "role-a");
  for (const card of [r1, r2]) await takeCardDocument(adapter, card.cardId, "role-b");
  await returnCardDocument(adapter, r2.cardId, {
    roleId: "role-b",
    result: "second published, first returned",
  });
  await returnCardDocument(adapter, r1.cardId, {
    roleId: "role-b",
    result: "first published, second returned",
  });
  const events = await adapter.history.changesInRange();
  const queueTimes = adapter.history.cardQueueTimes.bind(adapter.history);
  const retained = await queueTimes((await adapter.history.currentCommit())!, [r1.path, r2.path]);
  for (const card of [r1, r2])
    assert.equal(
      retained.returned.get(card.path),
      events.find(
        (event) => event.operation === "card.return" && event.objectIds.includes(card.cardId),
      )!.time,
    );
  t.mock.method(
    adapter.history,
    "cardQueueTimes",
    async (head: string, paths: readonly string[]) => ({
      ...(await queueTimes(head, paths)),
      returned: new Map([
        [r2.path, "2026-01-01T00:00:01.000Z"],
        [r1.path, "2026-01-01T00:00:02.000Z"],
      ]),
    }),
  );
  const own = await create("card-own", "role-a"),
    open = await create("card-open");
  assert.deepEqual(await pending("role-a"), [own.cardId, r2.cardId, r1.cardId]);
  assert.deepEqual(await pending("role-a", true), [own.cardId, open.cardId, r2.cardId, r1.cardId]);
  const head = await adapter.history.currentCommit();
  await pending("role-a", true);
  assert.equal(await adapter.history.currentCommit(), head);
  const git = path.join(root, ".tent", ".git");
  const diskState = async () => {
    const hash = createHash("sha256");
    for (const name of (await fs.readdir(git, { recursive: true })).sort()) {
      const file = path.join(git, name),
        stat = await fs.stat(file);
      if (stat.isFile())
        hash
          .update(name)
          .update(String(stat.mtimeMs))
          .update(await fs.readFile(file));
    }
    return hash.digest("hex");
  };
  for (const cache of ["missing", "corrupt"] as const) {
    for (const name of await fs.readdir(git))
      if (name.startsWith("tent-") && name.endsWith(".json")) await fs.rm(path.join(git, name));
    if (cache === "corrupt")
      await fs.writeFile(path.join(git, "tent-history-index.json"), "broken");
    const before = await diskState();
    const times = await queueTimes(head!, [r1.path, r2.path]);
    assert.deepEqual(times, retained);
    assert.deepEqual(await pending("role-a", true), [
      own.cardId,
      open.cardId,
      r2.cardId,
      r1.cardId,
    ]);
    assert.equal(await diskState(), before, `${cache} cache must stay untouched`);
  }
});

test("CLI and HTTP pass queue placement and expose the same snapshot key", async (t) => {
  const { root, adapter, create } = await fixture(t);
  const a = await create("card-a", "role-a"),
    b = await create("card-b", "role-a"),
    open = await create("card-open");
  const run = (sub: string, args: string[], json = true) =>
    runCardCommand(sub, args, { workspace: root, cwd: root, json });
  const moved = await run("move", [b.cardId, "--before", a.cardId, "--base-etag", b.etag]);
  assert.equal(moved.exitCode, 0, moved.stderr);
  assert.ok(JSON.parse(moved.stdout).order);
  const watched = await run(
    "watch",
    ["--role", "role-a", "--include-open", "--timeout", "0"],
    false,
  );
  assert.equal(watched.exitCode, 0, watched.stderr);
  assert.match(watched.stdout, /card-open  \[public\]/);
  assert.equal(
    (
      await run("move", [
        a.cardId,
        "--before",
        b.cardId,
        "--after",
        open.cardId,
        "--base-etag",
        a.etag,
      ])
    ).exitCode,
    1,
  );
  const server = await startUiServer({ workspaceRoot: root, staticDir: root, port: 0 });
  t.after(() => server.close());
  const url = new URL(server.url),
    headers = {
      Authorization: `Bearer ${url.hash.slice(7)}`,
      Origin: url.origin,
      "Content-Type": "application/json",
    };
  const endpoint = new URL(`/api/cards/${open.cardId}/move`, url);
  const body = JSON.stringify({ target: "role-a", after: b.cardId, baseEtag: open.etag });
  assert.equal((await fetch(endpoint, { method: "POST", body })).status, 401);
  const response = await fetch(endpoint, { method: "POST", body, headers });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await fetch(endpoint, { method: "POST", body, headers })).status, 409);
  const snapshotResponse = await fetch(new URL("/api/snapshot", url), { headers });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  const cards = (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items;
  assert.deepEqual(
    cards.map((x) => x.cardId),
    [b.cardId, open.cardId, a.cardId],
  );
  for (const item of cards)
    assert.equal(snapshot.cards.find((x: any) => x.id === item.cardId).orderKey, item.orderKey);
});
