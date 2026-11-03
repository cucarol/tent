import { initializeFixtureHistory } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import {
  createCardDocument,
  takeCardDocument,
  returnCardDocument,
  watchCardDocuments,
  CardDocumentError,
  listCardDocuments,
  deprecateCardDocument,
} from "../src/core/graph/card-document.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { renameNode } from "../src/core/graph/rename-ops.js";
import { ReaderError } from "../src/core/graph/reader-error.js";
import { cliErrorText } from "../src/cli/error-text.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(testScratchRoot());
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-document-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await removeTestFixture(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await initializeFixtureHistory(root);
  const adapter = openTestFs(root);
  const node = "\uFEFF---\r\nid: node-main\r\ntype: prompt\r\n---\r\nexact fact\r\n";
  await adapter.writeFile("Main/Main.md", node);
  await adapter.writeFile("Other/Other.md", "---\nid: node-other\ntype: prompt\n---\nnot selected");
  await createRoleContext(adapter, { roleId: "role-a", title: "A", body: "direction A" });
  await createRoleContext(adapter, { roleId: "role-b", title: "B", body: "direction B" });
  return { root, adapter, node };
}
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;

test("watch retries an atomic Role replacement detected by the real file reader", async (t) => {
  const { root, adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "Work", target: "role-a" });
  const rolePath = path.join(root, "roles/role-a.md");
  const replacement = rolePath + ".replacement";
  const raw = await fs.readFile(rolePath);
  await fs.writeFile(replacement, raw);
  const stat = fs.stat;
  let replaced = false;
  t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    if (!replaced && String(args[0]) === rolePath) {
      replaced = true;
      // Emulate a replacement becoming visible after the old handle was read.
      // Windows itself can deny rename while that handle is still open.
      return stat(replacement, args[1]);
    }
    return stat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(adapter.readFile("roles/role-a.md"), code("SOURCE_CHANGED"));
  await fs.writeFile(replacement, raw);
  replaced = false;
  assert.deepEqual(await watchCardDocuments(adapter, "role-a", 10), [{ cardId: card.cardId }]);
  assert.equal(replaced, true);
});

test("watch retries transient reads without losing the unchanged inbox head", async (t) => {
  for (const errno of ["EPERM", "EACCES", "EBUSY", "ENOENT", "SOURCE_CHANGED"]) {
    const { adapter } = await fixture(t);
    const card = await createCardDocument(adapter, { prompt: "Work", target: "role-a" });
    const read = adapter.history.readDirectory.bind(adapter.history);
    let calls = 0;
    adapter.history.readDirectory = async (...args) => {
      if (++calls === 1) throw Object.assign(new Error(`inbox ${errno}`), { code: errno });
      return read(...args);
    };
    assert.deepEqual(await watchCardDocuments(adapter, "role-a", 10), [{ cardId: card.cardId }]);
    assert.equal(calls, 2);
  }
});

test("watch distinguishes one missing read from a missing or deprecated Role", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "Work", target: "role-a" });
  const read = adapter.readFile.bind(adapter);
  let calls = 0;
  adapter.readFile = async (file) => {
    if (file === "roles/role-a.md" && ++calls === 1)
      throw Object.assign(new Error("replacement ENOENT"), { code: "ENOENT" });
    return read(file);
  };
  assert.deepEqual(await watchCardDocuments(adapter, "role-a", 0), [{ cardId: card.cardId }]);
  const start = performance.now();
  await assert.rejects(watchCardDocuments(adapter, "role-missing", 30), code("ROLE_UNAVAILABLE"));
  assert.ok(performance.now() - start < 1000, "missing Role must not wait for a poll");
  await adapter.writeFile(
    "roles/role-a.md",
    (await read("roles/role-a.md")).replace("type: role", "type: role\nstatus: deprecated"),
  );
  await assert.rejects(watchCardDocuments(adapter, "role-a", 30), code("ROLE_UNAVAILABLE"));
});

test("watch reports persistent and nontransient read failures with their original cause", async (t) => {
  const { adapter } = await fixture(t);
  const failure = Object.assign(new Error("EPERM: read roles/role-a.md"), { code: "EPERM" });
  let reads = 0;
  adapter.readFile = async () => {
    reads++;
    throw failure;
  };
  await assert.rejects(watchCardDocuments(adapter, "role-a", 10), (error: unknown) => {
    assert.equal((error as CardDocumentError).cause, failure);
    assert.match(cliErrorText(error, "tent card watch"), /EPERM: read roles\/role-a.md/);
    return true;
  });
  assert.equal(reads, 2);
  await assert.rejects(watchCardDocuments(adapter, "role-a", 0), code("ROLE_UNAVAILABLE"));
  assert.equal(reads, 3, "timeout zero must not sleep or hide a read failure");
  const invalid = new Error("invalid Role bytes");
  adapter.readFile = async () => {
    throw invalid;
  };
  await assert.rejects(watchCardDocuments(adapter, "role-a", 30), (error: unknown) => {
    assert.equal((error as CardDocumentError).cause, invalid);
    return true;
  });
});

test("waiting watch notices native Role retirement even without a new inbox head", async (t) => {
  const { adapter } = await fixture(t);
  const head = await adapter.history.currentCommit();
  const directory = adapter.history.readDirectory.bind(adapter.history);
  adapter.history.readDirectory = async (...args) => {
    const result = await directory(...args);
    await adapter.writeFile(
      "roles/role-a.md",
      (await adapter.readFile("roles/role-a.md")).replace(
        "type: role",
        "type: role\nstatus: deprecated",
      ),
    );
    return result;
  };
  await assert.rejects(watchCardDocuments(adapter, "role-a", 10), code("ROLE_UNAVAILABLE"));
  assert.equal(await adapter.history.currentCommit(), head);
});

test("Card commands retain Role read errors and the CLI keeps their cause", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "Work",
    target: "role-a",
    returnTo: "role-b",
  });
  const header = adapter.readFrontmatter.bind(adapter);
  const failure = new ReaderError("SOURCE_CHANGED", "Source changed while reading header");
  adapter.readFrontmatter = async (file) => {
    if (file === "roles/role-a.md") throw failure;
    return header(file);
  };
  for (const action of [
    () => createCardDocument(adapter, { prompt: "Work", target: "role-a" }),
    () => takeCardDocument(adapter, card.cardId, "role-a"),
  ]) {
    await assert.rejects(action(), (error: unknown) => {
      assert.equal((error as CardDocumentError).cause, failure);
      assert.match(cliErrorText(error, "tent card take"), /Source changed while reading header/);
      return true;
    });
  }
  adapter.readFrontmatter = header;
  await takeCardDocument(adapter, card.cardId, "role-a");
  adapter.readFrontmatter = async () => {
    throw failure;
  };
  await assert.rejects(
    returnCardDocument(adapter, card.cardId, { roleId: "role-a", result: "Done" }),
    (error: unknown) => {
      assert.equal((error as CardDocumentError).cause, failure);
      return true;
    },
  );
});

test("a draft Card is diagnosed and cannot be taken", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "Decided task", target: "role-a" });
  const raw = (await adapter.readFile(card.path)).replace(
    "state: pending",
    "state: pending\nstatus: draft",
  );
  await adapter.writeFile(card.path, raw);
  const listed = await listCardDocuments(adapter);
  assert.match(
    String(listed.items.find((item) => item.cardId === card.cardId)?.diagnostic),
    /Card header unavailable/,
  );
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code("INVALID_DOCUMENT"));
});

test("draft Roles receive new and existing Cards normally", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "Decided task", target: "role-a" });
  await adapter.writeFile(
    "roles/role-a.md",
    (await adapter.readFile("roles/role-a.md")).replace("type: role", "type: role\nstatus: draft"),
  );
  assert.equal((await takeCardDocument(adapter, card.cardId, "role-a")).state, "consumed");
  const next = await createCardDocument(adapter, { prompt: "Task", target: "role-a" });
  assert.equal(next.target, "role-a");
  assert.match(await adapter.readFile("roles/role-a.md"), /status: draft/);
});

test("draft Role Card filters, actions and watch stay available", async (t) => {
  const { adapter } = await fixture(t);
  const pending = await createCardDocument(adapter, { prompt: "Pending", target: "role-a" });
  const consumed = await createCardDocument(adapter, {
    prompt: "In progress",
    target: "role-a",
    returnTo: "role-b",
  });
  await takeCardDocument(adapter, consumed.cardId, "role-a");
  const returned = await createCardDocument(adapter, {
    prompt: "Await collection",
    target: "role-b",
    returnTo: "role-a",
  });
  await takeCardDocument(adapter, returned.cardId, "role-b");
  await returnCardDocument(adapter, returned.cardId, { roleId: "role-b", result: "Done" });
  await createCardDocument(adapter, { prompt: "Other", target: "role-b" });
  const selected = (await listCardDocuments(adapter, { roleId: "role-a" })).items;
  assert.deepEqual(
    selected.map((item) => item.cardId).sort(),
    [pending.cardId, consumed.cardId, returned.cardId].sort(),
  );
  const roleRaw = (await adapter.readFile("roles/role-a.md")).replace(
    "type: role",
    "type: role\nstatus: draft",
  );
  await adapter.writeFile("roles/role-a.md", roleRaw);
  const withLock = adapter.withLock;
  adapter.withLock = async () => {
    throw new Error("Read-only Role filtering must not acquire the write lock");
  };
  assert.deepEqual((await listCardDocuments(adapter, { roleId: "role-a" })).items, selected);
  assert.deepEqual(
    (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items.map(
      (item) => item.cardId,
    ),
    [pending.cardId],
  );
  assert.equal(await adapter.readFile("roles/role-a.md"), roleRaw);
  adapter.withLock = withLock;
  const next = await createCardDocument(adapter, { prompt: "New", target: "role-a" });
  await createCardDocument(adapter, { prompt: "New", target: "role-b", returnTo: "role-a" });
  await takeCardDocument(adapter, pending.cardId, "role-a");
  await takeCardDocument(adapter, returned.cardId, "role-a");
  await returnCardDocument(adapter, consumed.cardId, { roleId: "role-a", result: "Done" });
  assert.deepEqual(
    (await watchCardDocuments(adapter, "role-a", 0)).map((card) => card.cardId),
    [next.cardId],
  );
});

test("Card Role filters retain unavailable handling for deprecated and unknown Role status", async (t) => {
  const { adapter } = await fixture(t);
  await createCardDocument(adapter, { prompt: "Existing", target: "role-a" });
  const original = await adapter.readFile("roles/role-a.md");
  for (const status of ["deprecated", "mystery"]) {
    await adapter.writeFile(
      "roles/role-a.md",
      original.replace("type: role", `type: role\nstatus: ${status}`),
    );
    await assert.rejects(
      listCardDocuments(adapter, { roleId: "role-a" }),
      code("ROLE_UNAVAILABLE"),
    );
  }
});

test("take rolls back an unpublished transaction and still recovers legacy consumed bytes exactly once", async (t) => {
  const { adapter, root } = await fixture(t);
  for (const roleId of ["role-a"]) {
    const card = await createCardDocument(adapter, {
      cardId: "card-recoverrole",
      prompt: "Keep the original input",
      target: roleId,
    });
    const before = await adapter.readFile(card.path);
    const beforeHead = await adapter.history.currentCommit();
    let attemptedRaw: string | undefined;
    const capture = adapter.history.captureUnlocked.bind(adapter.history);
    adapter.history.captureUnlocked = async (changes, metadata) => {
      if (metadata?.operation === "card.take") {
        attemptedRaw = changes.find((change) => change.path === card.path)?.raw ?? undefined;
        throw new Error("interrupted before publication");
      }
      return capture(changes, metadata);
    };
    await assert.rejects(
      takeCardDocument(adapter, card.cardId, roleId),
      /interrupted before publication/,
    );
    adapter.history.captureUnlocked = capture;
    assert.equal(await adapter.readFile(card.path), before);
    assert.equal(await adapter.history.currentCommit(), beforeHead);
    assert.ok(attemptedRaw);
    // A pre-transaction workspace may contain consumed bytes without a published reception.
    await fs.writeFile(path.join(root, card.path), attemptedRaw);
    const savedBytes = await adapter.readFile(card.path);
    assert.equal(parseFrontmatter(savedBytes).data.state, "consumed");
    assert.equal(parseFrontmatter(await adapter.history.read(card.version)).data.state, "pending");
    assert.equal((await watchCardDocuments(adapter, roleId, 0))[0]!.cardId, card.cardId);
    const taken = (await takeCardDocument(adapter, card.cardId, roleId)) as Record<string, any>;
    assert.equal(taken.replayed, false);
    assert.equal(await adapter.history.read(taken.version!), savedBytes);
    assert.equal(await adapter.readFile(card.path), savedBytes);
    assert.deepEqual(await watchCardDocuments(adapter, roleId, 0), []);
    const head = await adapter.history.currentCommit();
    assert.equal(
      ((await takeCardDocument(adapter, card.cardId, roleId)) as Record<string, any>).replayed,
      true,
    );
    assert.equal(await adapter.history.currentCommit(), head);
  }
  // History is SQLite; this fixture does not own a project Git index.
  assert.equal(
    (await adapter.history!.retainedPaths()).filter((file) => file.startsWith("cards/")).length,
    1,
  );
});

test("interrupted reception recovery rejects simultaneous status, target and input changes", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-recoverconflict",
    prompt: "original",
    target: "role-a",
  });
  const original = await adapter.readFile(card.path);
  for (const [changes, expected] of [
    [{ state: "consumed", receivedBy: "role-a", status: "deprecated" }, "STATE_CHANGED"],
    [{ state: "consumed", receivedBy: "role-b", target: "role-b" }, "STATE_CHANGED"],
  ] as const) {
    const parsed = parseFrontmatter(original);
    await adapter.writeFile(
      card.path,
      serializeFrontmatter({ ...parsed.data, ...changes }, parsed.body),
    );
    await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code(expected));
  }
  await adapter.writeFile(
    card.path,
    original
      .replace("state: pending", "state: consumed\nreceivedBy: role-a")
      .replace("original", "changed"),
  );
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), code("INPUT_CHANGED"));
  assert.equal((await adapter.history.pathVersions(card.path)).latest!.commit, card.version.commit);
});

test("Card deprecation preserves input and reception and replays without capture", async (t) => {
  const { adapter } = await fixture(t);
  const created = await createCardDocument(adapter, {
    prompt: "Read the Node.",
    sources: [{ resource: "node-main" }],
    target: "role-a",
  });
  await takeCardDocument(adapter, created.cardId, "role-a");
  const before = parseFrontmatter(await adapter.readFile(created.path));
  const deprecated = await deprecateCardDocument(adapter, created.cardId);
  const after = parseFrontmatter(await adapter.readFile(created.path));
  assert.deepEqual(after.data, { ...before.data, status: "deprecated" });
  assert.equal(after.body, before.body);
  assert.equal(deprecated.status, "deprecated");
  assert.equal(deprecated.state, "consumed");
  const cancelledHead = await adapter.history.currentCommit();
  assert.deepEqual(await deprecateCardDocument(adapter, created.cardId), deprecated);
  assert.equal(await adapter.history.currentCommit(), cancelledHead);
  assert.equal((await listCardDocuments(adapter, { roleId: "role-a" })).items.length, 0);
  assert.equal(
    (
      await listCardDocuments(adapter, {
        roleId: "role-a",
        state: "consumed",
        includeDeprecated: true,
      })
    ).items.length,
    1,
  );
  const replay = await takeCardDocument(adapter, created.cardId, "role-a");
  assert.equal(replay.text, before.body);
  assert.equal((replay as Record<string, unknown>).replayed, true);
  assert.match(String((replay as Record<string, unknown>).notice), /deprecated/);
  await assert.rejects(
    () => takeCardDocument(adapter, created.cardId, "role-b"),
    code("RECEPTION_CONFLICT"),
  );
});

test("Card deprecation rejects manual input and management edits without changing bytes or history", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "fixed input", target: "role-a" });
  const original = await adapter.readFile(card.path),
    head = await adapter.history.currentCommit();
  for (const [raw, expected] of [
    [original.replace("fixed input", "edited input"), "INPUT_CHANGED"],
    [original.replace("state: pending", "state: consumed\nreceivedBy: role-a"), "STATE_CHANGED"],
    [original.replace("state: pending", "state: pending\nstatus: deprecated"), "STATE_CHANGED"],
  ]) {
    await adapter.writeFile(card.path, raw!);
    await assert.rejects(() => deprecateCardDocument(adapter, card.cardId), code(expected!));
    assert.equal(await adapter.readFile(card.path), raw);
    assert.equal(await adapter.history.currentCommit(), head);
  }
});

test("a deprecated Card still takes with a cancellation notice", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-cancelled",
    prompt: "original input",
    target: "role-a",
  });
  await deprecateCardDocument(adapter, card.cardId);
  await assert.rejects(
    () => takeCardDocument(adapter, card.cardId, "role-b"),
    code("RECEPTION_CONFLICT"),
  );
  const taken = (await takeCardDocument(adapter, card.cardId, "role-a")) as Record<string, unknown>;
  assert.equal(taken.state, "consumed");
  assert.equal(taken.text, "original input");
  assert.match(String(taken.notice), /deprecated/);
});

test("filtered Card lists skip history and keep malformed-header diagnostics", async (t) => {
  const { adapter } = await fixture(t);
  await createCardDocument(adapter, {
    cardId: "card-filtered",
    prompt: "For another role",
    target: "role-b",
  });
  for (const method of ["cardQueueTimes", "firstCommitTimes", "readDirectory"] as const)
    t.mock.method(adapter.history, method, async () => {
      throw new Error("history contents must not be queried");
    });
  assert.deepEqual(
    (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items,
    [],
  );
  assert.deepEqual((await listCardDocuments(adapter, { cardIds: [] })).items, []);
  assert.deepEqual((await listCardDocuments(adapter, { cardIds: ["card-missing"] })).items, []);
  await adapter.writeFile(
    "cards/card-invalid.md",
    "---\nid: different\ntype: card\nschemaVersion: 3\n---\n",
  );
  assert.deepEqual(
    (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items,
    [
      {
        cardId: "card-invalid",
        path: "cards/card-invalid.md",
        diagnostic: "Card header unavailable; inspect raw",
      },
    ],
  );
});

test("Card list batches matching timestamps and excludes untracked handwritten files", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-match",
    prompt: "For A",
    target: "role-a",
  });
  await createCardDocument(adapter, { cardId: "card-excluded", prompt: "For B", target: "role-b" });
  await adapter.writeFile(
    "cards/card-manual.md",
    "---\nid: card-manual\ntype: card\nschemaVersion: 3\ntarget: role-a\nstate: pending\n---\nmanual",
  );
  const expectedTime = (await adapter.history.changesInRange()).find(
    (entry) => entry.commit === card.version.commit,
  )!.time;
  const actual = adapter.history.firstCommitTimes.bind(adapter.history);
  const batch = t.mock.method(
    adapter.history,
    "firstCommitTimes",
    async (paths: readonly string[]) => {
      assert.deepEqual([...paths].sort(), ["cards/card-manual.md", card.path].sort());
      return actual(paths);
    },
  );
  const result = (await listCardDocuments(adapter, { roleId: "role-a", state: "pending" })).items;
  assert.equal(batch.mock.callCount(), 1);
  assert.equal(result.find((item) => item.cardId === card.cardId)!.publishedAt, expectedTime);
  assert.equal(
    result.find((item) => item.cardId === "card-manual"),
    undefined,
  );
  t.mock.method(adapter.history, "available", async () => false);
  const withoutGit = await listCardDocuments(adapter, { roleId: "role-a", state: "pending" });
  assert.equal(withoutGit.items.length, 0);
});

test("Card publication checks only Node/Role sources and stores addresses; moving live Nodes does not rewrite input", async (t) => {
  const { adapter } = await fixture(t);
  const reads: string[] = [],
    binary = adapter.readBinary.bind(adapter);
  adapter.readBinary = async (p) => {
    reads.push(p);
    return binary(p);
  };
  const input = [
    { resource: "/Main/Main.md", extra: { ordered: [2, 1] } },
    { resource: "/roles/role-a.md" },
    { resource: "https://example.invalid/unread" },
    { resource: "客户访谈结论" },
    { resource: "../../external.txt" },
  ];
  const saved = await createCardDocument(adapter, {
    cardId: "card-selected",
    prompt: "Implement this.",
    target: "role-a",
    sources: input,
  });
  assert.deepEqual(reads, ["Main/Main.md", "roles/role-a.md"]);
  const raw = await adapter.readFile(saved.path),
    parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.data.sources, input);
  assert.equal(await adapter.exists("snapshots"), false);
  assert.equal(await adapter.exists("card-consumptions"), false);
  assert.equal(
    (await adapter.history.pathVersions(saved.path)).first!.commit,
    saved.version.commit,
  );
  await renameNode(
    { fs: adapter, clock: { now: () => "test" }, tentName: "test" },
    "node-main",
    "Renamed",
  );
  assert.equal(await adapter.readFile(saved.path), raw);
  assert.deepEqual(parseFrontmatter(raw).data.sources, input);
});

test("one Card has one receiving Role and retries replay reception", async (t) => {
  const { adapter } = await fixture(t);
  const saved = await createCardDocument(adapter, {
    cardId: "card-target",
    prompt: "work",
    target: "role-a",
  });
  await assert.rejects(
    () => takeCardDocument(adapter, saved.cardId, "role-b"),
    code("RECEPTION_CONFLICT"),
  );
  const first = (await takeCardDocument(adapter, saved.cardId, "role-a")) as Record<
    string,
    unknown
  >;
  assert.equal(first.state, "consumed");
  assert.equal(first.replayed, false);
  const replay = (await takeCardDocument(adapter, saved.cardId, "role-a")) as Record<
    string,
    unknown
  >;
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.version, first.version);
  await assert.rejects(
    () => takeCardDocument(adapter, saved.cardId, "role-b"),
    code("RECEPTION_CONFLICT"),
  );
});

test("manual input or management edits stay raw-readable without being retained as reception proof", async (t) => {
  const { adapter } = await fixture(t);
  const path = "cards/card-handwritten.md";
  const published = await createCardDocument(adapter, {
    cardId: "card-handwritten",
    prompt: "original",
    target: "role-a",
    sources: [{ resource: "/Main/Main.md", custom: { keep: true } }],
  });
  const initial = await adapter.readFile(path);
  assert.equal(
    await adapter.history.read((await adapter.history.pathVersions(path)).first!),
    initial,
    "first publication retains the exact published bytes",
  );
  for (const [changed, expected] of [
    [initial.replace("original", "changed prompt"), "INPUT_CHANGED"],
    [initial.replace("keep: true", "keep: false"), "INPUT_CHANGED"],
    [initial.replace("state: pending", "state: pending\nstatus: deprecated"), "STATE_CHANGED"],
    [initial.replace("state: pending", "state: interrupted"), "INVALID_DOCUMENT"],
  ]) {
    await adapter.writeFile(path, changed!);
    assert.equal(
      (await adapter.history.pathVersions(path)).latest!.commit,
      published.version.commit,
    );
    await assert.rejects(
      () => takeCardDocument(adapter, published.cardId, "role-a"),
      code(expected!),
    );
  }
  const malformed = initial.replace("sources:", "sources: [broken");
  await adapter.writeFile(path, malformed);
  await adapter.remove(path);
  await assert.rejects(
    () =>
      createCardDocument(adapter, { cardId: published.cardId, prompt: "reuse", target: "role-a" }),
    /already exists/,
  );
});

test("large Card inputs and source metadata are complete in Core", async (t) => {
  const { adapter } = await fixture(t);
  const prompt = "内容😀\r\n".repeat(4000);
  const card = await createCardDocument(adapter, {
    cardId: "card-large",
    prompt,
    target: "role-a",
    sources: Array.from({ length: 100 }, (_, i) => ({
      resource: `https://example.invalid/${i}`,
      description: "detail".repeat(100),
    })),
  });
  const taken = (await takeCardDocument(adapter, card.cardId, "role-a")) as Record<string, any>;
  assert.equal(taken.text, prompt);
  assert.equal(taken.sources.length, 100);
});

test("Card title remains fixed after publication and list includes first publication time", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-title",
    title: "Review findings",
    prompt: "Review this",
    target: "role-a",
  });
  const listed = (await listCardDocuments(adapter)).items.find(
    (item) => item.cardId === card.cardId,
  )!;
  assert.equal(listed.title, "Review findings");
  assert.match(String(listed.publishedAt), /^\d{4}-\d\d-\d\dT/);
  await adapter.writeFile(
    card.path,
    (await adapter.readFile(card.path)).replace("Review findings", "Changed title"),
  );
  await assert.rejects(
    () => takeCardDocument(adapter, card.cardId, "role-a"),
    code("INPUT_CHANGED"),
  );
});

test("Card publication canonicalizes known Node ids in sources and Markdown links", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "[read](node-main)",
    target: "role-a",
    sources: [{ resource: "node-main" }],
  });
  const published = parseFrontmatter(await adapter.readFile(card.path));
  assert.equal(
    (published.data.sources as Array<{ resource: string }>)[0]!.resource,
    "../Main/Main.md",
  );
  assert.equal(published.body, "[read](../Main/Main.md)");
});

test("manual target and input edits block reception without retaining the edit", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "original", target: "role-a" });
  const raw = await adapter.readFile(card.path);
  for (const [changed, expected] of [
    [raw.replace("role-a", "role-b"), "STATE_CHANGED"],
    [raw.replace("original", "changed"), "INPUT_CHANGED"],
  ]) {
    await adapter.writeFile(card.path, changed!);
    await assert.rejects(() => takeCardDocument(adapter, card.cardId, "role-b"), code(expected!));
    assert.equal(
      (await adapter.history.pathVersions(card.path)).latest!.commit,
      card.version.commit,
    );
  }
});
