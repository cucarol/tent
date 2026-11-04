import { openTestFs, removeTestFixture } from "./node-fs.js";
import { initializeFixtureHistory } from "./scratch.js";
import { testScratchRoot } from "./scratch.js";
import { RoleCardsError } from "../src/core/graph/role-cards.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaffoldInWorkspace } from "./scaffold.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { deleteRole } from "../src/core/write/role-delete.js";
import {
  createCardDocument,
  deprecateCardDocument,
  takeCardDocument,
  returnCardDocument,
} from "../src/core/graph/card-document.js";
import { checkGraph } from "../src/core/check/graph-check.js";
import { runRoleCommand, roleHelpText } from "../src/cli/role-commands.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "role-delete-"));
  t.after(() =>
    removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }),
  );
  await scaffoldInWorkspace(openTestFs(root), { name: "roles" });
  const systemRoot = path.join(root, ".tent");
  await initializeFixtureHistory(systemRoot);
  const adapter = openTestFs(systemRoot);
  const role = await createRoleContext(adapter, {
    roleId: "role-review",
    title: "Review",
    body: "Instructions",
  });
  return { root, systemRoot, adapter, role };
}

test("Role deletion retains exact current history, leaves links and reception facts, and forbids identity reuse", async (t) => {
  const { root, adapter, role } = await fixture(t);
  const raw = (await adapter.readFile(role.path)) + "\nNative edit\n";
  await adapter.writeFile(role.path, raw);
  const card = await createCardDocument(adapter, {
    cardId: "card-received",
    prompt: "Review",
    target: role.roleId,
    sources: [{ resource: "/roles/role-review.md" }],
  });
  await takeCardDocument(adapter, card.cardId, role.roleId);
  const cardRaw = await adapter.readFile(card.path);
  const nodePath = "reference/reference.md";
  const nodeRaw = "---\nid: node-reference\ntype: prompt\n---\n[Review](/roles/role-review.md)\n";
  await adapter.writeFile(nodePath, nodeRaw);
  const result = await deleteRole(adapter, role.roleId);
  assert.deepEqual(result, { roleId: role.roleId, path: role.path });
  assert.equal(await adapter.exists(role.path), false);
  assert.equal(await adapter.readFile(card.path), cardRaw);
  assert.equal(await adapter.readFile(nodePath), nodeRaw);
  const deletion = (await adapter.history.changesInRange())
    .reverse()
    .find((entry) => entry.operation === "role.delete")!;
  assert.equal(deletion.changes.length, 1);
  assert.equal(deletion.changes[0]!.after, undefined);
  assert.equal(await adapter.history.read(deletion.changes[0]!.before!), raw);
  const checked = await checkGraph(adapter, root, async (file) =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  );
  assert.ok(
    checked.issues.some((issue) => issue.kind === "unresolved-link" && issue.path === nodePath),
  );
  assert.ok(!checked.errors.some((error) => error.path === card.path));
  await assert.rejects(
    createRoleContext(adapter, { roleId: role.roleId, title: "New" }),
    /already exists in history/,
  );
  await assert.rejects(deleteRole(adapter, role.roleId), /Role not found/);
});

test("pending Cards list every blocker; cancelling them permits deletion", async (t) => {
  const { adapter, role } = await fixture(t);
  const first = await createCardDocument(adapter, {
    cardId: "card-first",
    prompt: "First",
    target: role.roleId,
  });
  const second = await createCardDocument(adapter, {
    cardId: "card-second",
    prompt: "Second",
    target: role.roleId,
  });
  await adapter.writeFile(
    "cards/card-invalid.md",
    "---\ntype: card\nid: card-invalid\nschemaVersion: 3\ntarget: role-review\nstate: pending\n---\nMalformed sources",
  );
  const head = await adapter.history.currentCommit();
  await assert.rejects(deleteRole(adapter, role.roleId), (error) => {
    assert.ok(error instanceof RoleCardsError);
    assert.equal(error.code, "PENDING_CARDS");
    assert.deepEqual(error.details.cardIds, [first.cardId, second.cardId]);
    assert.match(error.message, /card-first, card-second/);
    return true;
  });
  assert.equal(await adapter.history.currentCommit(), head);
  await deprecateCardDocument(adapter, first.cardId);
  await deprecateCardDocument(adapter, second.cardId);
  const cancelled = await adapter.readFile(second.path);
  await deleteRole(adapter, role.roleId);
  assert.equal(await adapter.readFile(second.path), cancelled);
});

test("unfinished returns protect both Roles and release each at its delivery boundary", async (t) => {
  const { adapter, role } = await fixture(t);
  const worker = await createRoleContext(adapter, { roleId: "role-worker", title: "Worker" });
  const cards = [];
  for (const suffix of ["pending", "consumed", "returned", "closed"])
    cards.push(
      await createCardDocument(adapter, {
        cardId: `card-${suffix}`,
        prompt: suffix,
        target: worker.roleId,
        returnTo: role.roleId,
      }),
    );
  for (const card of cards.slice(1)) await takeCardDocument(adapter, card.cardId, worker.roleId);
  for (const card of cards.slice(2))
    await returnCardDocument(adapter, card.cardId, { roleId: worker.roleId, result: "done" });
  await takeCardDocument(adapter, cards[3]!.cardId, role.roleId);
  const head = await adapter.history.currentCommit();
  for (const [subject, blockers] of [
    [role, ["card-consumed", "card-pending", "card-returned"]],
    [worker, ["card-consumed", "card-pending"]],
  ] as const) {
    await assert.rejects(deleteRole(adapter, subject.roleId), (error) => {
      assert.ok(error instanceof RoleCardsError);
      assert.deepEqual(error.details.cardIds, blockers);
      assert.equal(
        error.message,
        `Role has unfinished Cards: ${blockers.join(", ")}. Take or return each one, or cancel it with tent card deprecate <card-id>, then retry.`,
      );
      return true;
    });
  }
  assert.equal(await adapter.history.currentCommit(), head);
  await deprecateCardDocument(adapter, cards[0]!.cardId);
  await returnCardDocument(adapter, cards[1]!.cardId, { roleId: worker.roleId, result: "done" });
  await deleteRole(adapter, worker.roleId);
  // Results owed to the return address keep it protected after the worker is gone.
  await assert.rejects(deleteRole(adapter, role.roleId), (error) => {
    assert.ok(error instanceof RoleCardsError);
    assert.deepEqual(error.details.cardIds, ["card-consumed", "card-returned"]);
    return true;
  });
  for (const card of cards.slice(1, 3)) await takeCardDocument(adapter, card.cardId, role.roleId);
  const before = await Promise.all(cards.map((card) => adapter.readFile(card.path)));
  await deleteRole(adapter, role.roleId);
  assert.deepEqual(await Promise.all(cards.map((card) => adapter.readFile(card.path))), before);
});

test("deprecated return Cards never block either Role in any delivery state", async (t) => {
  const { adapter, role } = await fixture(t);
  const worker = await createRoleContext(adapter, { roleId: "role-worker", title: "Worker" });
  for (const state of ["pending", "consumed", "returned", "closed"]) {
    const card = await createCardDocument(adapter, {
      prompt: state,
      target: worker.roleId,
      returnTo: role.roleId,
    });
    if (state !== "pending") await takeCardDocument(adapter, card.cardId, worker.roleId);
    if (state === "returned" || state === "closed")
      await returnCardDocument(adapter, card.cardId, { roleId: worker.roleId, result: "done" });
    if (state === "closed") await takeCardDocument(adapter, card.cardId, role.roleId);
    await deprecateCardDocument(adapter, card.cardId);
  }
  await deleteRole(adapter, worker.roleId);
  await deleteRole(adapter, role.roleId);
});

test("CLI Role delete requires its id, names blocking Cards and reports a JSON deletion receipt", async (t) => {
  const { root, adapter, role } = await fixture(t);
  const missing = await runRoleCommand("delete", [], { workspace: root });
  assert.equal(missing.exitCode, 1);
  const card = await createCardDocument(adapter, {
    cardId: "card-waiting",
    prompt: "Work",
    target: role.roleId,
  });
  const blocked = await runRoleCommand("delete", [role.roleId], { workspace: root });
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.stderr, /card-waiting/);
  assert.match(blocked.stderr, /tent card deprecate/);
  await deprecateCardDocument(adapter, card.cardId);
  const deleted = await runRoleCommand("delete", [role.roleId, "--json"], { workspace: root });
  assert.equal(deleted.exitCode, 0, deleted.stderr);
  assert.equal(JSON.parse(deleted.stdout).roleId, role.roleId);
  assert.equal(JSON.parse(deleted.stdout).workspaceRoot, root);
  assert.equal(await adapter.exists(role.path), false);
  assert.match(roleHelpText(), /status: deprecated/);
});

test("a Role deletion whose capture fails restores the Role, and a retry records one deletion", async (t) => {
  const { adapter, role, systemRoot } = await fixture(t);
  const before = await adapter.readFile(role.path);
  const beforeHead = await adapter.history.currentCommit();
  const capture = adapter.history.captureUnlocked.bind(adapter.history);
  adapter.history.captureUnlocked = async (changes, metadata) => {
    if (metadata?.operation === "role.delete") throw new Error("injected");
    return capture(changes, metadata);
  };
  await assert.rejects(deleteRole(adapter, role.roleId), /injected/);
  assert.equal(await adapter.readFile(role.path), before);
  assert.equal(await adapter.history.currentCommit(), beforeHead);
  const restarted = openTestFs(systemRoot);
  await deleteRole(restarted, role.roleId);
  assert.equal(await restarted.exists(role.path), false);
  assert.equal(
    (await restarted.history.changesInRange()).filter((entry) => entry.operation === "role.delete")
      .length,
    1,
  );
});

test("check reports each Card left waiting on a Role retired by a native edit", async (t) => {
  const { adapter, role, root } = await fixture(t);
  const worker = await createRoleContext(adapter, { roleId: "role-worker", title: "Worker" });
  const card = await createCardDocument(adapter, {
    cardId: "card-return",
    prompt: "Work",
    target: worker.roleId,
    returnTo: role.roleId,
  });
  const done = await createCardDocument(adapter, { prompt: "One-way", target: role.roleId });
  await takeCardDocument(adapter, done.cardId, role.roleId);
  const cancelled = await createCardDocument(adapter, { prompt: "Cancelled", target: role.roleId });
  await deprecateCardDocument(adapter, cancelled.cardId);
  const retire = async (subject: typeof role, status: string) => {
    const raw = await adapter.readFile(subject.path);
    await adapter.writeFile(
      subject.path,
      raw.replace(/^status: \w+\n/m, "").replace("type: role", `type: role\nstatus: ${status}`),
    );
  };
  const waiting = async () =>
    (
      await checkGraph(adapter, root, async (file) =>
        fs.access(file).then(
          () => true,
          () => false,
        ),
      )
    ).errors
      .filter((error) => /^Card waits on/.test(error.reason))
      .map((error) => [error.path, error.reason]);
  const message = (roleId: string) =>
    `Card waits on ${roleId}, which is not a current Role; cancel it with tent card deprecate ${card.cardId}`;
  assert.deepEqual(await waiting(), []);
  await retire(worker, "deprecated");
  await retire(role, "deprecated");
  assert.deepEqual(await waiting(), [
    [card.path, message(role.roleId)],
    [card.path, message(worker.roleId)],
  ]);
  // A retired Role takes nothing; restore it to finish its part, then retire it again.
  await retire(worker, "stable");
  await takeCardDocument(adapter, card.cardId, worker.roleId);
  await returnCardDocument(adapter, card.cardId, { roleId: worker.roleId, result: "done" });
  await retire(worker, "deprecated");
  assert.deepEqual(await waiting(), [[card.path, message(role.roleId)]]);
  await retire(role, "stable");
  await takeCardDocument(adapter, card.cardId, role.roleId);
  await retire(role, "deprecated");
  assert.deepEqual(await waiting(), []);
});
