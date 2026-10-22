import { RoleCardsError } from "../src/core/graph/role-cards.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { scaffoldInWorkspace } from "./scaffold.js";
import {
  createRoleContext,
  editRoleContext,
  requireRoleDocument,
} from "../src/core/read/role-context.js";
import { deleteRole } from "../src/core/write/role-delete.js";
import {
  createCardDocument,
  deprecateCardDocument,
  moveCardDocument,
  takeCardDocument,
  parseCardDocument,
  returnCardDocument,
  verifyCardSourceVersion,
} from "../src/core/graph/card-document.js";
import { checkGraph } from "../src/core/check/graph-check.js";
import { contentEtag } from "../src/core/base/etag.js";
import { DELETE_PENDING_PATH, executeDeleteUnlocked } from "../src/core/store/delete-recovery.js";
import { runRoleCommand, roleHelpText } from "../src/cli/role-commands.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "role-delete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await scaffoldInWorkspace(new NodeFs(root), { name: "roles" });
  const systemRoot = path.join(root, ".tent");
  await git(systemRoot, "init");
  const adapter = new NodeFs(systemRoot);
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
  const result = await deleteRole(adapter, role.roleId, { baseEtag: contentEtag(raw) });
  assert.deepEqual(result, { roleId: role.roleId, path: role.path });
  assert.equal(await adapter.exists(role.path), false);
  assert.equal(await adapter.readFile(card.path), cardRaw);
  assert.equal(await adapter.readFile(nodePath), nodeRaw);
  const source = parseCardDocument(card.cardId, cardRaw).data.sources[0]!;
  assert.equal((await verifyCardSourceVersion(adapter, card.path, source)).raw, raw);
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
  assert.ok(!checked.errors.some((error) => /source.*version/i.test(error.reason)));
  await assert.rejects(
    createRoleContext(adapter, { roleId: role.roleId, title: "New" }),
    /already exists in history/,
  );
  await assert.rejects(deleteRole(adapter, role.roleId, { baseEtag: role.etag }), /Role not found/);
});

test("Role deletion rejects missing and stale ETags without writes", async (t) => {
  const { adapter, role } = await fixture(t);
  const head = await adapter.history.currentCommit();
  const before = await adapter.readFile(role.path);
  for (const baseEtag of ["", "stale"])
    await assert.rejects(
      deleteRole(adapter, role.roleId, { baseEtag }),
      /changed or baseEtag missing/,
    );
  assert.equal(await adapter.readFile(role.path), before);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.exists(DELETE_PENDING_PATH), false);
});

test("pending targeted Cards list every blocker; moving and cancelling them permit deletion", async (t) => {
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
  await createCardDocument(adapter, { cardId: "card-public", prompt: "Public" });
  await adapter.writeFile(
    "cards/card-invalid.md",
    "---\ntype: card\nid: card-invalid\nschemaVersion: 3\ntarget: role-review\nstate: pending\n---\nMalformed sources",
  );
  const head = await adapter.history.currentCommit();
  await assert.rejects(deleteRole(adapter, role.roleId, { baseEtag: role.etag }), (error) => {
    assert.ok(error instanceof RoleCardsError);
    assert.equal(error.code, "PENDING_CARDS");
    assert.deepEqual(error.details.cardIds, [first.cardId, second.cardId]);
    assert.match(error.message, /card-first, card-second/);
    return true;
  });
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.exists(DELETE_PENDING_PATH), false);
  await moveCardDocument(adapter, first.cardId, { target: null, expectedEtag: first.etag });
  await deprecateCardDocument(adapter, second.cardId, second.etag);
  const cancelled = await adapter.readFile(second.path);
  await deleteRole(adapter, role.roleId, { baseEtag: role.etag });
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
    await assert.rejects(
      deleteRole(adapter, subject.roleId, { baseEtag: subject.etag }),
      (error) => {
        assert.ok(error instanceof RoleCardsError);
        assert.deepEqual(error.details.cardIds, blockers);
        assert.equal(
          error.message,
          `Role has unfinished Cards: ${blockers.join(", ")}. Collect returned Cards, finish outstanding returns, move pending targets, or deprecate the Cards before retiring the Role.`,
        );
        return true;
      },
    );
  }
  assert.equal(await adapter.history.currentCommit(), head);
  assert.equal(await adapter.exists(DELETE_PENDING_PATH), false);
  await moveCardDocument(adapter, cards[0]!.cardId, { target: null, expectedEtag: cards[0]!.etag });
  await returnCardDocument(adapter, cards[1]!.cardId, { roleId: worker.roleId, result: "done" });
  await deleteRole(adapter, worker.roleId, { baseEtag: worker.etag });
  // The return address remains protected even after its original target is moved.
  await assert.rejects(deleteRole(adapter, role.roleId, { baseEtag: role.etag }), (error) => {
    assert.ok(error instanceof RoleCardsError);
    assert.deepEqual(error.details.cardIds, ["card-consumed", "card-pending", "card-returned"]);
    return true;
  });
  const pending = await adapter.readFile(cards[0]!.path);
  await deprecateCardDocument(adapter, cards[0]!.cardId, contentEtag(pending));
  for (const card of cards.slice(1, 3)) await takeCardDocument(adapter, card.cardId, role.roleId);
  const before = await Promise.all(cards.map((card) => adapter.readFile(card.path)));
  await deleteRole(adapter, role.roleId, { baseEtag: role.etag });
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
    await deprecateCardDocument(
      adapter,
      card.cardId,
      contentEtag(await adapter.readFile(card.path)),
    );
  }
  await deleteRole(adapter, worker.roleId, { baseEtag: worker.etag });
  await deleteRole(adapter, role.roleId, { baseEtag: role.etag });
});

test("CLI Role delete requires its id and ETag and reports a JSON deletion receipt", async (t) => {
  const { root, adapter, role } = await fixture(t);
  const missing = await runRoleCommand("delete", [role.roleId], { workspace: root });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Role delete requires --base-etag/);
  const wrong = await runRoleCommand("delete", [role.roleId, "--base-etag", "stale"], {
    workspace: root,
  });
  assert.equal(wrong.exitCode, 1);
  assert.match(wrong.stderr, /Next: tent role show role-review/);
  const deleted = await runRoleCommand(
    "delete",
    [role.roleId, "--base-etag", role.etag, "--json"],
    { workspace: root },
  );
  assert.equal(deleted.exitCode, 0, deleted.stderr);
  assert.equal(JSON.parse(deleted.stdout).roleId, role.roleId);
  assert.equal(JSON.parse(deleted.stdout).workspaceRoot, root);
  assert.equal(await adapter.exists(role.path), false);
  assert.ok(
    roleHelpText().includes(
      "Delete removes the Role document; Tent Git keeps its history and its id is never reused. Unfinished Cards block deletion: deprecate them, or move pending ones, first.",
    ),
  );
});

for (const point of [
  "before-move",
  "after-move",
  "commit",
  "history",
  "cleanup",
  "journal",
] as const) {
  test(`Role deletion resumes after ${point} failure with one deletion history entry`, async (t) => {
    const { adapter, role, systemRoot } = await fixture(t);
    const move = adapter.move.bind(adapter),
      write = adapter.writeFile.bind(adapter),
      remove = adapter.remove.bind(adapter),
      capture = adapter.history.captureUnlocked.bind(adapter.history);
    adapter.move = async (from, to) => {
      if (point === "before-move") throw new Error("injected");
      await move(from, to);
      if (point === "after-move") throw new Error("injected");
    };
    adapter.writeFile = async (file, raw) => {
      if (point === "commit" && file === DELETE_PENDING_PATH && JSON.parse(raw).committed)
        throw new Error("injected");
      await write(file, raw);
    };
    adapter.history.captureUnlocked = async (changes, metadata) => {
      if (point === "history" && metadata?.operation === "role.delete") throw new Error("injected");
      return capture(changes, metadata);
    };
    adapter.remove = async (file) => {
      if (
        (point === "cleanup" && file === "temp/delete-pending") ||
        (point === "journal" && file === DELETE_PENDING_PATH)
      )
        throw new Error("injected");
      await remove(file);
    };
    await assert.rejects(deleteRole(adapter, role.roleId, { baseEtag: role.etag }), /injected/);
    assert.equal(await adapter.exists(DELETE_PENDING_PATH), true);
    if (point === "before-move")
      assert.equal((await requireRoleDocument(adapter, role.roleId)).etag, role.etag);
    else assert.equal(await adapter.exists(role.path), false);
    const restarted = new NodeFs(systemRoot);
    await deleteRole(restarted, role.roleId, { baseEtag: role.etag });
    assert.equal(await restarted.exists(role.path), false);
    assert.equal(await restarted.exists(DELETE_PENDING_PATH), false);
    assert.equal(await restarted.exists("temp/delete-pending"), false);
    assert.equal(
      (await restarted.history.changesInRange()).filter(
        (entry) => entry.operation === "role.delete",
      ).length,
      1,
    );
  });
}

test("Role recovery rejects changed isolated bytes and a recreated live identity", async (t) => {
  const { adapter, role, systemRoot } = await fixture(t);
  const raw = await adapter.readFile(role.path);
  const move = adapter.move.bind(adapter);
  adapter.move = async (from, to) => {
    await move(from, to);
    throw new Error("interrupted");
  };
  await assert.rejects(deleteRole(adapter, role.roleId, { baseEtag: role.etag }), /interrupted/);
  const restarted = new NodeFs(systemRoot);
  await restarted.writeFile("temp/delete-pending", raw + "changed");
  await assert.rejects(
    deleteRole(restarted, role.roleId, { baseEtag: role.etag }),
    /Pending deletion conflict/,
  );
  assert.equal(await restarted.readFile("temp/delete-pending"), raw + "changed");
  await restarted.writeFile("temp/delete-pending", raw);
  await restarted.writeFile(role.path, raw + "replacement");
  await assert.rejects(
    deleteRole(restarted, role.roleId, { baseEtag: role.etag }),
    /Pending deletion conflict/,
  );
  assert.equal(await restarted.readFile(role.path), raw + "replacement");
  assert.equal(await restarted.exists(DELETE_PENDING_PATH), true);
});

test("Role delete plans cannot remove another path or introduce associated writes", async (t) => {
  const { adapter, role } = await fixture(t);
  const raw = await adapter.readFile(role.path);
  await adapter.writeFile("other.md", raw);
  for (const input of [
    { source: "other.md", writes: [] },
    { source: role.path, writes: [{ path: "order.json", before: null, after: "{}" }] },
  ])
    await assert.rejects(
      executeDeleteUnlocked(adapter, { kind: "role", id: role.roleId, raw, ...input }),
      /Pending deletion conflict/,
    );
  assert.equal(await adapter.readFile(role.path), raw);
  assert.equal(await adapter.readFile("other.md"), raw);
  assert.equal(await adapter.exists(DELETE_PENDING_PATH), false);
});

test("Role deprecation protects delivery addresses and preserves failed writes", async (t) => {
  const { adapter, role, root } = await fixture(t);
  const worker = await createRoleContext(adapter, { roleId: "role-worker", title: "Worker" });
  const card = await createCardDocument(adapter, {
    cardId: "card-return",
    prompt: "Work",
    target: worker.roleId,
    returnTo: role.roleId,
  });
  async function blocked(subject: typeof role, raw = false) {
    const before = await adapter.readFile(subject.path);
    const head = await adapter.history.currentCommit();
    await assert.rejects(
      editRoleContext(adapter, subject.roleId, {
        baseEtag: subject.etag,
        ...(raw
          ? { raw: before.replace("type: role", "type: role\nstatus: deprecated") }
          : { frontmatter: { status: "deprecated" } }),
      }),
      (error) => {
        assert.ok(error instanceof RoleCardsError);
        assert.equal(error.code, "PENDING_CARDS");
        assert.deepEqual(error.details.cardIds, [card.cardId]);
        return true;
      },
    );
    assert.equal(await adapter.readFile(subject.path), before);
    assert.equal(await adapter.history.currentCommit(), head);
  }
  await blocked(worker);
  await blocked(role, true);
  const cli = await runRoleCommand(
    "write",
    [worker.roleId, "--base-etag", worker.etag, "--status", "deprecated"],
    { workspace: root },
  );
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderr, /card-return/);
  await takeCardDocument(adapter, card.cardId, worker.roleId);
  await blocked(worker, true);
  await blocked(role);
  await returnCardDocument(adapter, card.cardId, { roleId: worker.roleId, result: "done" });
  await editRoleContext(adapter, worker.roleId, {
    baseEtag: worker.etag,
    frontmatter: { status: "deprecated" },
  });
  await blocked(role);
  await takeCardDocument(adapter, card.cardId, role.roleId);
  await editRoleContext(adapter, role.roleId, {
    baseEtag: role.etag,
    frontmatter: { status: "deprecated" },
  });
});

test("Role deprecation ignores completed and cancelled Cards and still checks CAS", async (t) => {
  const { adapter, role } = await fixture(t);
  const done = await createCardDocument(adapter, { prompt: "One-way", target: role.roleId });
  await takeCardDocument(adapter, done.cardId, role.roleId);
  const cancelled = await createCardDocument(adapter, { prompt: "Cancelled", target: role.roleId });
  await deprecateCardDocument(adapter, cancelled.cardId, cancelled.etag);
  const before = await adapter.readFile(role.path);
  for (const baseEtag of ["", "stale"])
    await assert.rejects(
      editRoleContext(adapter, role.roleId, { baseEtag, frontmatter: { status: "deprecated" } }),
      /baseEtag/,
    );
  assert.equal(await adapter.readFile(role.path), before);
  const retired = await editRoleContext(adapter, role.roleId, {
    baseEtag: role.etag,
    frontmatter: { status: "deprecated" },
  });
  const restored = await editRoleContext(adapter, role.roleId, {
    baseEtag: retired.etag,
    frontmatter: { status: "stable" },
  });
  assert.ok(restored.changed);
});
