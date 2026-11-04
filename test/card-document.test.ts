import { initializeFixtureHistory } from "./scratch.js";
import { openTestFs, removeTestFixture } from "./node-fs.js";
import { testScratchRoot } from "./scratch.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createCardDocument,
  takeCardDocument,
  returnCardDocument,
  watchCardDocuments,
  listCardDocuments,
  deprecateCardDocument,
} from "../src/core/graph/card-document.js";
import { createRoleContext } from "../src/core/read/role-context.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { renameNode } from "../src/core/graph/rename-ops.js";
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

test("watch survives one failed poll without losing the unchanged inbox head", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "Work", target: "role-a" });
  const read = adapter.history.readDirectory.bind(adapter.history);
  let calls = 0;
  adapter.history.readDirectory = async (...args) => {
    if (++calls === 1) throw new Error("inbox read failed");
    return read(...args);
  };
  assert.deepEqual(await watchCardDocuments(adapter, "role-a", 10), [{ cardId: card.cardId }]);
  assert.equal(calls, 2);
});

test("watch fails at once for a missing or deprecated Role", async (t) => {
  const { adapter } = await fixture(t);
  const start = performance.now();
  await assert.rejects(watchCardDocuments(adapter, "role-missing", 30), /Role unavailable/);
  assert.ok(performance.now() - start < 1000, "a wrong Role must not wait for a poll");
  await adapter.writeFile(
    "roles/role-a.md",
    (await adapter.readFile("roles/role-a.md")).replace(
      "type: role",
      "type: role\nstatus: deprecated",
    ),
  );
  await assert.rejects(watchCardDocuments(adapter, "role-a", 30), /Role unavailable/);
});

test("watch reports a second failed poll, and any failure once its timeout has passed", async (t) => {
  const { adapter } = await fixture(t);
  const failure = new Error("inbox read failed");
  let reads = 0;
  adapter.history.readDirectory = async () => {
    reads++;
    throw failure;
  };
  await assert.rejects(watchCardDocuments(adapter, "role-a", 10), (error) => error === failure);
  assert.equal(reads, 2);
  await assert.rejects(watchCardDocuments(adapter, "role-a", 0), (error) => error === failure);
  assert.equal(reads, 3, "timeout zero must not sleep or hide a read failure");
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
  await assert.rejects(watchCardDocuments(adapter, "role-a", 10), /Role unavailable/);
  assert.equal(await adapter.history.currentCommit(), head);
});

test("Card commands name a Role read error and the CLI keeps it", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "Work",
    target: "role-a",
    returnTo: "role-b",
  });
  const read = adapter.readFile.bind(adapter);
  adapter.readFile = async (file) => {
    if (file === "roles/role-a.md") throw new Error("disk said no");
    return read(file);
  };
  for (const action of [
    () => createCardDocument(adapter, { prompt: "Work", target: "role-a" }),
    () => takeCardDocument(adapter, card.cardId, "role-a"),
  ]) {
    await assert.rejects(action(), (error: unknown) => {
      assert.match(cliErrorText(error, "tent card take"), /disk said no/);
      return true;
    });
  }
  adapter.readFile = read;
  await takeCardDocument(adapter, card.cardId, "role-a");
  adapter.readFile = async (file) => {
    if (file === "roles/role-a.md") throw new Error("disk said no");
    return read(file);
  };
  await assert.rejects(
    returnCardDocument(adapter, card.cardId, { roleId: "role-a", result: "Done" }),
    /disk said no/,
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
  await assert.rejects(takeCardDocument(adapter, card.cardId, "role-a"), /draft status/);
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
    await assert.rejects(listCardDocuments(adapter, { roleId: "role-a" }), /Role unavailable/);
  }
});

test("take rolls back an unpublished transaction, then takes the Card exactly once", async (t) => {
  const { adapter } = await fixture(t);
  const roleId = "role-a";
  const card = await createCardDocument(adapter, {
    cardId: "card-recoverrole",
    prompt: "Keep the original input",
    target: roleId,
  });
  const before = await adapter.readFile(card.path);
  const beforeHead = await adapter.history.currentCommit();
  const capture = adapter.history.captureUnlocked.bind(adapter.history);
  adapter.history.captureUnlocked = async (changes, metadata) => {
    if (metadata?.operation === "card.take") throw new Error("interrupted before publication");
    return capture(changes, metadata);
  };
  await assert.rejects(
    takeCardDocument(adapter, card.cardId, roleId),
    /interrupted before publication/,
  );
  adapter.history.captureUnlocked = capture;
  assert.equal(await adapter.readFile(card.path), before);
  assert.equal(await adapter.history.currentCommit(), beforeHead);
  assert.equal((await watchCardDocuments(adapter, roleId, 0))[0]!.cardId, card.cardId);
  const taken = (await takeCardDocument(adapter, card.cardId, roleId)) as Record<string, any>;
  assert.equal(taken.replayed, false);
  const savedBytes = await adapter.readFile(card.path);
  assert.equal(parseFrontmatter(savedBytes).data.state, "consumed");
  assert.equal(await adapter.history.read(taken.version!), savedBytes);
  assert.deepEqual(await watchCardDocuments(adapter, roleId, 0), []);
  const head = await adapter.history.currentCommit();
  assert.equal(
    ((await takeCardDocument(adapter, card.cardId, roleId)) as Record<string, any>).replayed,
    true,
  );
  assert.equal(await adapter.history.currentCommit(), head);
  // History is SQLite; this fixture does not own a project Git index.
  assert.equal(
    (await adapter.history.retainedPaths()).filter((file) => file.startsWith("cards/")).length,
    1,
  );
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
    /addressed to role-a/,
  );
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
    /addressed to role-a/,
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
        diagnostic: "Card header unavailable; run tent workspace check",
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
});

test("Card publication checks only Node/Role sources and stores addresses; moving live Nodes does not rewrite input", async (t) => {
  const { adapter } = await fixture(t);
  const reads: string[] = [],
    read = adapter.readFile.bind(adapter);
  adapter.readFile = async (p) => {
    reads.push(p);
    return read(p);
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
  assert.ok(reads.includes("Main/Main.md") && reads.includes("roles/role-a.md"));
  assert.ok(reads.every((p) => !p.startsWith("../")));
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
    /addressed to role-a/,
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
    /addressed to role-a/,
  );
});

test("a hand edit is what the receiver gets; the first publication stays in history", async (t) => {
  const { adapter } = await fixture(t);
  const path = "cards/card-handwritten.md";
  const published = await createCardDocument(adapter, {
    cardId: "card-handwritten",
    prompt: "original",
    target: "role-a",
    sources: [{ resource: "/Main/Main.md", custom: { keep: true } }],
  });
  const initial = await adapter.readFile(path);
  const first = (await adapter.history.pathVersions(path)).first!;
  assert.equal(await adapter.history.read(first), initial);
  await adapter.writeFile(path, initial.replace("state: pending", "state: interrupted"));
  await assert.rejects(
    () => takeCardDocument(adapter, published.cardId, "role-a"),
    /Invalid Card state/,
  );
  await adapter.writeFile(path, initial.replace("state: pending", "state: pending\nstatus: odd"));
  await assert.rejects(
    () => takeCardDocument(adapter, published.cardId, "role-a"),
    /Unsupported Card status/,
  );
  await adapter.writeFile(path, initial.replace("original", "changed prompt"));
  const taken = (await takeCardDocument(adapter, published.cardId, "role-a")) as Record<
    string,
    unknown
  >;
  assert.equal(taken.text, "changed prompt");
  assert.equal(await adapter.history.read(first), initial);
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

test("Card list shows the title and first publication time", async (t) => {
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
