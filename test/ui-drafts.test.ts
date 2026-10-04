import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { api, ApiError, type CardInput } from "../src/ui/data/api.js";
import {
  createDraft,
  discardDraft,
  editDraft,
  isDraft,
  loadLocalDrafts,
  localDraftCards,
  moveCard,
  publishDraft,
} from "../src/ui/data/drafts.js";

function browser(t: TestContext) {
  const data = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  loadLocalDrafts(`workspace-${t.name}`);
  const reads = t.mock.method(api, "card", async () => {
    throw new Error("Unexpected backend read");
  });
  const writes = t.mock.method(api, "createCard", async () => ({
    cardId: "card-published",
    path: "cards/card-published.md",
    etag: "etag",
  }));
  const moves = t.mock.method(api, "moveCard", async () => {
    throw new Error("Unexpected backend move");
  });
  return { data, reads, writes, moves };
}

test("unsent editing, source order, local retargeting and discard never call the backend", async (t) => {
  const { reads, writes, moves, data } = browser(t);
  const sources = [
    { resource: "/A/A.md", title: "A", custom: { kept: true } },
    { resource: "/B/B.md" },
  ];
  const id = createDraft(null, sources);
  assert.equal(localDraftCards()[0]!.progress, null);
  assert.equal(localDraftCards()[0]!.totalGoalCount, 0);
  editDraft(id, (input) => ({
    ...input,
    prompt: "Local only",
    sources: [...input.sources].reverse(),
  }));
  await moveCard(localDraftCards()[0]!, "role-ui");
  assert.equal(localDraftCards()[0]!.body, "Local only");
  assert.equal(localDraftCards()[0]!.target, "role-ui");
  assert.deepEqual(
    JSON.parse([...data.values()][0]!).map((d: { input: CardInput }) => d.input.sources),
    [[sources[1], sources[0]]],
  );
  discardDraft(id);
  assert.equal(localDraftCards().length, 0);
  for (const mock of [reads, writes, moves]) assert.equal(mock.mock.callCount(), 0);
});

test("browser refresh restores contents and keeps Workspace edits isolated", (t) => {
  browser(t);
  loadLocalDrafts("workspace-A");
  const a = createDraft("role-a", [{ resource: "/A/A.md" }]);
  editDraft(a, (input) => ({ ...input, prompt: "Workspace A" }));
  loadLocalDrafts("workspace-B");
  assert.equal(localDraftCards().length, 0);
  const b = createDraft(null);
  editDraft(b, (input) => ({ ...input, prompt: "Workspace B" }));
  loadLocalDrafts("workspace-A");
  assert.deepEqual(
    localDraftCards().map((c) => [c.id, c.body, c.target]),
    [[a, "Workspace A", "role-a"]],
  );
  loadLocalDrafts("workspace-B");
  assert.deepEqual(
    localDraftCards().map((c) => [c.id, c.body]),
    [[b, "Workspace B"]],
  );
});

test("sending directly creates a published Card from the latest local input and drops only that edit", async (t) => {
  const { writes, reads } = browser(t);
  const a = createDraft(null, [{ resource: "/A/A.md", title: "context" }]);
  const b = createDraft(null);
  editDraft(a, (input) => ({ ...input, prompt: "Final requirement", target: "role-ui" }));
  const saved = await publishDraft(a);
  assert.equal(saved!.cardId, "card-published");
  assert.deepEqual(writes.mock.calls[0]!.arguments, [
    {
      prompt: "Final requirement",
      target: "role-ui",
      sources: [{ resource: "/A/A.md", title: "context" }],
    },
  ]);
  assert.deepEqual(
    localDraftCards().map((c) => c.id),
    [b],
  );
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(isDraft({ id: "card-published" }), false);
});

test("failed sending keeps the latest local input for retry", async (t) => {
  const { writes, data } = browser(t);
  const id = createDraft(null);
  editDraft(id, (input) => ({ ...input, prompt: "Retry this" }));
  writes.mock.mockImplementation(async () => {
    throw new ApiError(500, "WRITE_FAILED", "Sending failed");
  });
  await assert.rejects(publishDraft(id), /Sending failed/);
  assert.equal(localDraftCards()[0]!.body, "Retry this");
  assert.equal(JSON.parse([...data.values()][0]!)[0].input.prompt, "Retry this");
  writes.mock.mockImplementation(async () => ({
    cardId: "card-retried",
    path: "cards/card-retried.md",
    etag: "ok",
  }));
  await publishDraft(id);
  assert.equal(localDraftCards().length, 0);
});

test("in-flight sending prevents duplicate POSTs, editing and discarding", async (t) => {
  const { writes } = browser(t);
  const id = createDraft(null);
  editDraft(id, (input) => ({ ...input, prompt: "Send once" }));
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  writes.mock.mockImplementation(async () => {
    await pending;
    return { cardId: "card-once", path: "cards/card-once.md", etag: "ok" };
  });
  const sent = publishDraft(id);
  await publishDraft(id);
  editDraft(id, (input) => ({ ...input, prompt: "Too late" }));
  discardDraft(id);
  assert.equal(localDraftCards()[0]!.body, "Send once");
  assert.equal(writes.mock.callCount(), 1);
  release();
  await sent;
  assert.equal(localDraftCards().length, 0);
});

test("sending from Workspace A clears only A after switching to Workspace B", async (t) => {
  const { writes, data } = browser(t);
  loadLocalDrafts("sending-A");
  const a = createDraft(null);
  editDraft(a, (input) => ({ ...input, prompt: "Send from A" }));
  const retained = createDraft(null);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  writes.mock.mockImplementation(async () => {
    await pending;
    return { cardId: "card-from-A", path: "cards/card-from-A.md", etag: "ok" };
  });
  const sent = publishDraft(a);
  loadLocalDrafts("sending-B");
  const b = createDraft("role-b");
  editDraft(b, (input) => ({ ...input, prompt: "Keep B unchanged" }));
  const bBefore = data.get("tent-unsent-cards:sending-B");
  const bMemory = localDraftCards();
  release();
  await sent;
  assert.equal(data.get("tent-unsent-cards:sending-B"), bBefore);
  assert.equal(localDraftCards(), bMemory);
  loadLocalDrafts("sending-A");
  assert.deepEqual(
    localDraftCards().map((c) => c.id),
    [retained],
  );
});

test("empty local contents cannot create a Card", async (t) => {
  const { writes } = browser(t);
  const id = createDraft(null);
  await assert.rejects(publishDraft(id));
  assert.equal(writes.mock.callCount(), 0);
});
