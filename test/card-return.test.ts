import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NodeFs } from "../src/fs/node-fs.js";
import { initializeFixtureWorkspace } from "./scratch.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import {
  createCardDocument,
  takeCardDocument,
  returnCardDocument,
  watchCardDocuments,
  readCardDocument,
  listCardDocuments,
  moveCardDocument,
} from "../src/core/graph/card-document.js";
import { runCardCommand } from "../src/cli/card-commands.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-return-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await initializeFixtureWorkspace(root);
  const adapter = new NodeFs(path.join(root, ".tent"));
  for (const roleId of ["role-worker", "role-owner", "role-other"])
    await createRoleContext(adapter, { roleId, title: roleId, body: "direction" });
  const create = (extra = {}) =>
    createCardDocument(adapter, {
      prompt: "Do work",
      target: "role-worker",
      returnTo: "role-owner",
      ...extra,
    });
  return { root, adapter, create };
}

test("Card returns once, repeatedly wakes its return recipient, then closes without changing the receiver", async (t) => {
  const { adapter, create } = await fixture(t);
  const card = await create();
  const original = parseFrontmatter(await adapter.readFile(card.path));
  await assert.rejects(
    returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result: "done" }),
    /is still pending/,
  );
  await takeCardDocument(adapter, card.cardId, "role-worker");
  for (const roleId of ["role-owner", "role-other"])
    await assert.rejects(
      returnCardDocument(adapter, card.cardId, { roleId, result: "done" }),
      /return it with --role role-worker/,
    );
  const result = "已验收 node-result";
  const returned = await returnCardDocument(adapter, card.cardId, {
    roleId: "role-worker",
    result,
  });
  assert.equal(returned.state, "returned");
  assert.equal(returned.replayed, false);
  const head = await adapter.history.currentCommit();
  assert.equal(
    (await returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result })).replayed,
    true,
  );
  assert.equal(await adapter.history.currentCommit(), head);
  await assert.rejects(
    returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result: "different" }),
    /was already returned/,
  );
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await watchCardDocuments(adapter, "role-owner", 0), [
      { cardId: card.cardId, state: "returned", receivedBy: "role-worker", result },
    ]);
    assert.deepEqual(await watchCardDocuments(adapter, "role-worker", 0), []);
  }
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-worker"), /addressed to/);
  const closed = await takeCardDocument(adapter, card.cardId, "role-owner");
  assert.equal(closed.state, "closed");
  assert.equal(closed.receivedBy, "role-worker");
  assert.equal(closed.result, result);
  assert.deepEqual(await watchCardDocuments(adapter, "role-owner", 0), []);
  const closedHead = await adapter.history.currentCommit();
  assert.equal((await takeCardDocument(adapter, card.cardId, "role-owner")).replayed, true);
  assert.equal(
    (await returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result })).state,
    "closed",
  );
  assert.equal(await adapter.history.currentCommit(), closedHead);
  const saved = parseFrontmatter(await adapter.readFile(card.path));
  assert.equal(saved.body, original.body);
  for (const key of ["sources", "target", "returnTo", "schemaVersion"])
    assert.deepEqual(saved.data[key], original.data[key]);
  assert.equal(saved.data.returnedBy, undefined);
  assert.equal(saved.data.resultNodes, undefined);
  for (const roleId of ["role-owner", "role-worker"])
    assert.equal((await listCardDocuments(adapter, { roleId })).items[0]!.state, "closed");
  for (const key of ["progress", "goalCount", "totalGoalCount", "outputNodeIds"])
    assert.equal(
      Object.prototype.hasOwnProperty.call(await readCardDocument(adapter, card.cardId), key),
      false,
    );
});

test("Return addressing is published input; public Cards require a distinct receiving Role", async (t) => {
  const { adapter, create } = await fixture(t);
  await assert.rejects(create({ returnTo: "role-worker" }), /differ/);
  await assert.rejects(create({ returnTo: "role-missing" }), /Role unavailable/);
  const card = await create({ target: undefined });
  await assert.rejects(takeCardDocument(adapter, card.cardId), /take it with --role/);
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-owner"), /not its input/);
  await assert.rejects(
    moveCardDocument(adapter, card.cardId, { target: "role-owner", expectedEtag: card.etag }),
    /differ/,
  );
  const raw = await adapter.readFile(card.path);
  await adapter.writeFile(card.path, raw.replace("returnTo: role-owner", "returnTo: role-other"));
  await assert.rejects(
    takeCardDocument(adapter, card.cardId, "role-worker"),
    /Published Card input changed/,
  );
  await adapter.writeFile(card.path, raw);
  await takeCardDocument(adapter, card.cardId, "role-worker");
  const notification = await create({ returnTo: undefined });
  await takeCardDocument(adapter, notification.cardId, "role-worker");
  await assert.rejects(
    returnCardDocument(adapter, notification.cardId, { roleId: "role-worker", result: "done" }),
    /returnTo/,
  );
});

test("Results count Unicode characters, reject multiline and preserve exact replay text", async (t) => {
  const { adapter, create } = await fixture(t);
  const card = await create();
  await takeCardDocument(adapter, card.cardId, "role-worker");
  const head = await adapter.history.currentCommit();
  for (const result of [
    "",
    " ",
    "a\nb",
    "a\rb",
    "a\vb",
    "a\fb",
    "a\u2028b",
    "a\u2029b",
    "a\u0085b",
    "😀".repeat(201),
  ])
    await assert.rejects(
      returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result }),
      /single-line|200 characters/,
    );
  assert.equal(await adapter.history.currentCommit(), head);
  const result = "😀".repeat(200);
  assert.equal(
    (await returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result })).result,
    result,
  );
});

test("unpublished return and close roll back; legacy bytes recover exactly and simultaneous changes conflict", async (t) => {
  const { adapter, create } = await fixture(t);
  const card = await create();
  await takeCardDocument(adapter, card.cardId, "role-worker");
  for (const operation of ["card.return", "card.take"]) {
    const before = await adapter.readFile(card.path);
    const beforeHead = await adapter.history.currentCommit();
    let attemptedRaw: string | undefined;
    const capture = adapter.history.captureUnlocked.bind(adapter.history);
    adapter.history.captureUnlocked = async (changes, meta) => {
      if (meta?.operation === operation) {
        attemptedRaw = changes.find((change) => change.path === card.path)?.raw ?? undefined;
        throw new Error("capture interrupted");
      }
      return capture(changes, meta);
    };
    const act = () =>
      operation === "card.return"
        ? returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result: "done" })
        : takeCardDocument(adapter, card.cardId, "role-owner");
    await assert.rejects(act(), /capture interrupted/);
    adapter.history.captureUnlocked = capture;
    assert.equal(await adapter.readFile(card.path), before);
    assert.equal(await adapter.history.currentCommit(), beforeHead);
    assert.equal((await readCardDocument(adapter, card.cardId)).diagnostic, undefined);
    assert.ok(attemptedRaw);
    // Explicit legacy partial delivery: no durable file transaction accompanies these bytes.
    await adapter.writeFile(card.path, attemptedRaw);
    const raw = await adapter.readFile(card.path);
    assert.equal((await readCardDocument(adapter, card.cardId)).diagnostic && true, true);
    const parsed = parseFrontmatter(raw);
    await adapter.writeFile(
      card.path,
      serializeFrontmatter({ ...parsed.data, status: "deprecated" }, parsed.body),
    );
    await assert.rejects(act(), /management fields/);
    await adapter.writeFile(card.path, raw);
    const recovered = await act();
    assert.equal(recovered.replayed, false);
    assert.equal(await adapter.readFile(card.path), raw);
    assert.equal(await adapter.history.read(recovered.version!), raw);
    const head = await adapter.history.currentCommit();
    assert.equal((await act()).replayed, true);
    assert.equal(await adapter.history.currentCommit(), head);
  }
});

test("CLI create, return, watch, list and take expose the same delivery result", async (t) => {
  const { root } = await fixture(t);
  const run = (sub: string, args: string[], json = true) =>
    runCardCommand(sub, args, { workspace: root, json });
  const made = await run("create", [
    "--prompt",
    "work",
    "--target",
    "role-worker",
    "--return-to",
    "role-owner",
  ]);
  assert.equal(made.exitCode, 0, made.stderr);
  const id = JSON.parse(made.stdout).cardId;
  const missingRole = await run("return", [id, "--result", "done"]);
  assert.equal(missingRole.exitCode, 1);
  assert.match(missingRole.stderr, /Return requires --role role-ID, the Role that took the Card\./);
  assert.equal((await run("take", [id, "--role", "role-worker"])).exitCode, 0);
  const returned = await run("return", [
    id,
    "--role",
    "role-worker",
    "--result",
    "done node-result",
  ]);
  assert.equal(returned.exitCode, 0, returned.stderr);
  assert.equal(JSON.parse(returned.stdout).state, "returned");
  const watch = await run("watch", ["--role", "role-owner", "--timeout", "0"], false);
  assert.equal(watch.stdout, `${id} returned by role-worker: done node-result\n`);
  const list = await run("list", ["--role", "role-owner", "--state", "returned"]);
  assert.equal(JSON.parse(list.stdout).items[0].result, "done node-result");
  assert.equal((await run("take", [id, "--role", "role-owner"])).exitCode, 0);
  assert.equal((await run("watch", ["--role", "role-owner", "--timeout", "0"])).exitCode, 2);
});

test("waiting watch wakes on a published return and concurrent returns cannot replace its result", async (t) => {
  const { adapter, create } = await fixture(t);
  const card = await create();
  await takeCardDocument(adapter, card.cardId, "role-worker");
  const watch = watchCardDocuments(adapter, "role-owner", 30);
  await delay(50);
  const results = await Promise.allSettled([
    returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result: "first" }),
    returnCardDocument(adapter, card.cardId, { roleId: "role-worker", result: "second" }),
  ]);
  const successes = results.filter(
    (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof returnCardDocument>>> =>
      r.status === "fulfilled",
  );
  assert.equal(successes.length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const receipt = successes[0]!.value;
  assert.equal((await watch)[0]!.result, receipt.result);
  const operations = (await adapter.history.changesInRange()).filter(
    (c) => c.operation === "card.return",
  );
  assert.equal(operations.length, 1);
  assert.equal((await readCardDocument(adapter, card.cardId)).result, receipt.result);
});
