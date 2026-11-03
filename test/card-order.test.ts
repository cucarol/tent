import { openTestFs, removeTestFixture } from "./node-fs.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { cardOrderKey } from "../src/core/base/card-order.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import {
  createCardDocument,
  takeCardDocument,
  returnCardDocument,
  watchCardDocuments,
  listCardDocuments,
  deprecateCardDocument,
} from "../src/core/graph/card-document.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { runCardCommand } from "../src/cli/card-commands.js";
import { initializeFixtureWorkspace, testScratchRoot } from "./scratch.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(testScratchRoot(), "card-order-"));
  t.after(async () => {
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await initializeFixtureWorkspace(root);
  const adapter = openTestFs(path.join(root, ".tent"));
  for (const id of ["role-a", "role-b"])
    await createRoleContext(adapter, { roleId: id, title: id, body: "Work" });
  const create = (id: string, target: string, returnTo?: string) =>
    createCardDocument(adapter, {
      cardId: id,
      target,
      returnTo,
      prompt: "Keep this input",
      title: id,
    });
  const pending = async (roleId: string) =>
    (await watchCardDocuments(adapter, roleId, 0)).map((item) => item.cardId);
  return { root, adapter, create, pending };
}

test("Card queue keys order by publication time, then by id", () => {
  const time = "2026-01-01T08:00:00+08:00";
  const keys = [
    cardOrderKey("card-a", time),
    cardOrderKey("card-aa", time),
    cardOrderKey("card-z", time),
    cardOrderKey("card-0", "2026-01-01T00:00:01.000Z"),
  ];
  assert.equal(keys[0], "2026-01-01T00:00:00.000Z|card-a");
  assert.deepEqual([...keys].sort(), keys);
});

test("each Role's queue follows publication time and a retired order field is rejected", async (t) => {
  const { adapter, create, pending } = await fixture(t);
  const a = await create("card-a", "role-a"),
    c = await create("card-c", "role-a"),
    b = await create("card-b", "role-a"),
    other = await create("card-other", "role-b");
  t.mock.method(
    adapter.history,
    "firstCommitTimes",
    async (paths: readonly string[]) =>
      new Map(
        paths.map((p) => [
          p,
          p === b.path ? "2026-01-01T00:00:01.000Z" : "2026-01-01T00:00:00.000Z",
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
  assert.deepEqual(await pending("role-b"), [other.cardId]);
  const waiting = async () =>
    (await listCardDocuments(adapter, { roleId: "role-a", waiting: true })).items.map(
      (x) => x.cardId,
    );
  assert.deepEqual(await waiting(), [a.cardId, c.cardId, b.cardId]);
  await deprecateCardDocument(adapter, c.cardId);
  assert.deepEqual(await pending("role-a"), [a.cardId, b.cardId]);
  assert.deepEqual(await waiting(), [a.cardId, b.cardId]);

  const raw = await adapter.readFile(b.path);
  const saved = parseFrontmatter(raw);
  await adapter.writeFile(
    b.path,
    serializeFrontmatter({ ...saved.data, order: "2025-01-01T00:00:00.000Z|card-b" }, saved.body),
  );
  await assert.rejects(takeCardDocument(adapter, b.cardId, "role-a"), /order is retired/);
  await adapter.writeFile(b.path, raw);
  assert.equal((await takeCardDocument(adapter, b.cardId, "role-a")).state, "consumed");
});

test("watch emits the Role queue, then returns in return-time order", async (t) => {
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
  const own = await create("card-own", "role-a");
  assert.deepEqual(await pending("role-a"), [own.cardId, r2.cardId, r1.cardId]);
  const head = await adapter.history.currentCommit();
  await pending("role-a");
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
    assert.deepEqual(await pending("role-a"), [own.cardId, r2.cardId, r1.cardId]);
    assert.equal(await diskState(), before, `${cache} cache must stay untouched`);
  }
});

test("card list --role shows Cards to take, then returns owed, then results returned to it", async (t) => {
  const { root, adapter, create } = await fixture(t);
  const owed = await create("card-owed", "role-a", "role-b");
  await takeCardDocument(adapter, owed.cardId, "role-a");
  const done = await create("card-done", "role-a");
  await takeCardDocument(adapter, done.cardId, "role-a");
  const back = await create("card-back", "role-b", "role-a");
  await takeCardDocument(adapter, back.cardId, "role-b");
  await returnCardDocument(adapter, back.cardId, { roleId: "role-b", result: "checked" });
  const closed = await create("card-closed", "role-b", "role-a");
  await takeCardDocument(adapter, closed.cardId, "role-b");
  await returnCardDocument(adapter, closed.cardId, { roleId: "role-b", result: "read" });
  await takeCardDocument(adapter, closed.cardId, "role-a");
  const todo = await create("card-todo", "role-a");
  const run = (args: string[], json = true) =>
    runCardCommand("list", args, { workspace: root, cwd: root, json });
  const listed = await run(["--role", "role-a"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.deepEqual(
    JSON.parse(listed.stdout).items.map((x: { cardId: string }) => x.cardId),
    [todo.cardId, owed.cardId, back.cardId],
  );
  const text = (await run(["--role", "role-a"], false)).stdout.split("\n");
  assert.match(text[0]!, /^card-todo {2}pending {2}card-todo/);
  assert.match(text[1]!, /^card-owed {2}consumed {2}returnTo: role-b/);
  assert.match(text[2]!, /^card-back {2}returned {2}returnTo: role-a {2}checked/);
  assert.deepEqual(
    JSON.parse((await run(["--role", "role-a", "--state", "consumed"])).stdout)
      .items.map((x: { cardId: string }) => x.cardId)
      .sort(),
    [done.cardId, owed.cardId].sort(),
  );
});
