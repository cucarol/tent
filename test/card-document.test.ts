import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  createCardDocument,
  publishCardDocument,
  readCardDocument,
  transitionCardDocument,
  listCardDocuments,
  createCardDraft,
  writeCardDraft,
  deleteCardDraft,
  moveCardDocument,
} from "../src/core/card-document.js";
import { createRoleContext, editRoleContext } from "../src/core/role-context.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { renameNode } from "../src/core/rename-ops.js";
import { contentEtag } from "../src/core/etag.js";
import type { DocumentVersion } from "../src/core/git-history.js";
import { git } from "./helpers.js";

async function fixture(t: TestContext) {
  const scratch = path.resolve(".scratch");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "card-document-"));
  t.after(async () => {
    assert.equal(path.dirname(root), scratch);
    await fs.rm(root, { recursive: true, force: true });
  });
  await git(root, "init");
  const adapter = new NodeFs(root);
  const node = "\uFEFF---\r\nid: node-main\r\ntype: prompt\r\n---\r\nexact fact\r\n";
  await adapter.writeFile("Main/Main.md", node);
  await adapter.writeFile("Other/Other.md", "---\nid: node-other\ntype: prompt\n---\nnot selected");
  await createRoleContext(adapter, { roleId: "role-a", title: "A", body: "direction A" });
  await createRoleContext(adapter, { roleId: "role-b", title: "B", body: "direction B" });
  return { root, adapter, node };
}
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;

test("filtered Card lists skip history and keep malformed-header diagnostics", async (t) => {
  const { adapter } = await fixture(t);
  await createCardDocument(adapter, {
    cardId: "card-filtered",
    prompt: "For another role",
    target: "role-b",
  });
  t.mock.method(adapter.history, "available", async () => {
    throw new Error("history must not be queried");
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
        diagnostic: "Card header unavailable; inspect raw",
      },
    ],
  );
});

test("Card list batches timestamps for matching headers and excludes drafts from reception", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-match",
    prompt: "For A",
    target: "role-a",
  });
  await createCardDocument(adapter, { cardId: "card-excluded", prompt: "For B", target: "role-b" });
  await adapter.writeFile(
    "cards/card-manual.md",
    "---\nid: card-manual\ntype: card\nschemaVersion: 3\nstate: pending\n---\nmanual",
  );
  const expectedTime = await adapter.history.commitTime(card.version.commit);
  const actual = adapter.history.firstCommitTimes.bind(adapter.history);
  const batch = t.mock.method(
    adapter.history,
    "firstCommitTimes",
    async (paths: readonly string[]) => {
      assert.deepEqual([...paths].sort(), ["cards/card-manual.md", card.path].sort());
      return actual(paths);
    },
  );
  const result = (
    await listCardDocuments(adapter, { roleId: "role-a", includeOpen: true, state: "pending" })
  ).items;
  assert.equal(batch.mock.callCount(), 1);
  assert.equal(result.find((item) => item.cardId === card.cardId)!.publishedAt, expectedTime);
  assert.equal(
    result.find((item) => item.cardId === "card-manual"),
    undefined,
  );
  const all = (
    await listCardDocuments(adapter, { roleId: "role-a", includeOpen: true, includeDrafts: true })
  ).items;
  assert.equal(all.find((item) => item.cardId === "card-manual")!.draft, true);
  assert.equal(all.find((item) => item.cardId === "card-manual")!.publishedAt, null);
  assert.equal(
    (
      await listCardDocuments(adapter, {
        roleId: "role-a",
        includeOpen: true,
        includeDrafts: true,
        state: "pending",
      })
    ).items.length,
    1,
  );
  t.mock.method(adapter.history, "available", async () => false);
  const withoutGit = await listCardDocuments(adapter, {
    roleId: "role-a",
    includeOpen: true,
    state: "pending",
  });
  assert.equal(withoutGit.items.length, 0);
});

test("untargeted Card can be received without a Role and preserves that choice across transitions", async (t) => {
  const { adapter } = await fixture(t);
  const saved = await createCardDocument(adapter, { prompt: "ordinary session input" });
  const taken = (await transitionCardDocument(adapter, saved.cardId, undefined, "take")) as Record<
    string,
    unknown
  >;
  assert.equal(taken.state, "consumed");
  assert.equal(taken.receivedBy, undefined);
  assert.equal(parseFrontmatter(await adapter.readFile(saved.path)).data.receivedBy, undefined);
  assert.equal(
    (
      (await transitionCardDocument(adapter, saved.cardId, undefined, "take")) as Record<
        string,
        unknown
      >
    ).replayed,
    true,
  );
  await assert.rejects(
    () => transitionCardDocument(adapter, saved.cardId, "role-a", "take"),
    code("RECEPTION_CONFLICT"),
  );
  await assert.rejects(
    () => transitionCardDocument(adapter, saved.cardId, undefined, "interrupt"),
    code("STATE_CHANGED"),
  );
  const interrupted = (await transitionCardDocument(
    adapter,
    saved.cardId,
    undefined,
    "interrupt",
    taken.version as DocumentVersion,
  )) as Record<string, unknown>;
  await assert.rejects(
    () =>
      transitionCardDocument(
        adapter,
        saved.cardId,
        undefined,
        "continue",
        taken.version as DocumentVersion,
      ),
    code("STATE_CHANGED"),
  );
  const continued = (await transitionCardDocument(
    adapter,
    saved.cardId,
    undefined,
    "continue",
    interrupted.version as DocumentVersion,
  )) as Record<string, unknown>;
  assert.equal(continued.state, "consumed");
  assert.equal(continued.receivedBy, undefined);
  assert.equal((await listCardDocuments(adapter, { state: "consumed" })).items.length, 1);
  assert.equal(
    (await listCardDocuments(adapter, { roleId: "role-a", state: "consumed", includeOpen: true }))
      .items.length,
    0,
  );
  const targeted = await createCardDocument(adapter, {
    prompt: "targeted input",
    target: "role-a",
  });
  await assert.rejects(
    () => transitionCardDocument(adapter, targeted.cardId, undefined, "take"),
    /supply --role role-a/,
  );
  await transitionCardDocument(adapter, targeted.cardId, "role-a", "take");
  await assert.rejects(
    () => transitionCardDocument(adapter, targeted.cardId, undefined, "take"),
    code("RECEPTION_CONFLICT"),
  );
});

test("Card publication retains only selected Node/Role sources; moving live Nodes does not rewrite input", async (t) => {
  const { adapter, node } = await fixture(t);
  const reads: string[] = [],
    binary = adapter.readBinary.bind(adapter);
  adapter.readBinary = async (p) => {
    reads.push(p);
    return binary(p);
  };
  const saved = await createCardDocument(adapter, {
    cardId: "card-selected",
    prompt: "Implement this.",
    sources: [
      { resource: "/Main/Main.md", extra: { ordered: [2, 1] } },
      { resource: "/roles/role-a.md" },
      { resource: "https://example.invalid/unread" },
      { resource: "客户访谈结论" },
      { resource: "../external.txt" },
    ],
  });
  assert.deepEqual(reads, ["Main/Main.md", "roles/role-a.md"]);
  const raw = await adapter.readFile(saved.path),
    parsed = parseFrontmatter(raw);
  const sources = parsed.data.sources as Array<{
    resource: string;
    version?: DocumentVersion;
    extra?: unknown;
  }>;
  assert.equal(await adapter.history.read(sources[0]!.version!), node);
  assert.deepEqual(sources[0]!.extra, { ordered: [2, 1] });
  assert.equal(sources[2]!.version, undefined);
  assert.equal((await adapter.history.pathVersions("Other/Other.md")).first, undefined);
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
  assert.equal(await adapter.history.read(sources[0]!.version!), node);
  const page = await readCardDocument(adapter, saved.cardId);
  assert.equal(page.text, "Implement this.");
  assert.deepEqual((page as Record<string, unknown>).sources, sources);
});

test("one Card has one receiving Role; retries replay reception and open input stays open", async (t) => {
  const { adapter } = await fixture(t);
  const saved = await createCardDocument(adapter, {
    cardId: "card-target",
    prompt: "work",
    target: "role-a",
  });
  await assert.rejects(
    () => transitionCardDocument(adapter, saved.cardId, "role-b", "take"),
    code("RECEPTION_CONFLICT"),
  );
  const first = (await transitionCardDocument(adapter, saved.cardId, "role-a", "take")) as Record<
    string,
    unknown
  >;
  assert.equal(first.state, "consumed");
  assert.equal(first.replayed, false);
  assert.equal(first.automaticInterrupt, "unavailable");
  const replay = (await transitionCardDocument(adapter, saved.cardId, "role-a", "take")) as Record<
    string,
    unknown
  >;
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.version, first.version);
  const open = await createCardDocument(adapter, { cardId: "card-open", prompt: "open" });
  await transitionCardDocument(adapter, open.cardId, "role-b", "take");
  const fields = parseFrontmatter(await adapter.readFile(open.path)).data;
  assert.equal(fields.target, undefined);
  assert.equal(fields.receivedBy, "role-b");
  await assert.rejects(
    () => transitionCardDocument(adapter, open.cardId, "role-a", "take"),
    code("RECEPTION_CONFLICT"),
  );
  assert.equal(
    (await listCardDocuments(adapter, { roleId: "role-b", state: "consumed" })).items[0]!.cardId,
    open.cardId,
  );
});

test("manual input or management edits stay raw-readable without being retained as reception proof", async (t) => {
  const { adapter } = await fixture(t);
  const path = "cards/card-handwritten.md";
  const raw = serializeFrontmatter(
    {
      type: "card",
      id: "card-handwritten",
      schemaVersion: 3,
      state: "pending",
      custom: { keep: true },
      sources: [{ resource: "/Main/Main.md" }],
    },
    "original",
  );
  await adapter.writeFile(path, raw);
  assert.equal(
    ((await readCardDocument(adapter, "card-handwritten")) as Record<string, any>).diagnostic.code,
    "UNPUBLISHED",
  );
  const published = await publishCardDocument(adapter, "card-handwritten", contentEtag(raw));
  const initial = await adapter.readFile(path);
  assert.equal(
    await adapter.history.read((await adapter.history.pathVersions(path)).first!),
    initial,
    "first publication includes the resolved source versions",
  );
  for (const [changed, expected] of [
    [initial.replace("original", "changed prompt"), "INPUT_CHANGED"],
    [initial.replace("keep: true", "keep: false"), "INPUT_CHANGED"],
    [initial.replace("state: pending", "state: consumed\nreceivedBy: role-a"), "STATE_CHANGED"],
  ]) {
    await adapter.writeFile(path, changed!);
    const result = (await readCardDocument(adapter, published.cardId, { view: "raw" })) as Record<
      string,
      any
    >;
    assert.equal(result.text, changed);
    assert.equal(result.diagnostic.code, expected);
    assert.equal(
      (await adapter.history.pathVersions(path)).latest!.commit,
      published.version.commit,
    );
    await assert.rejects(
      () => transitionCardDocument(adapter, published.cardId, "role-a", "take"),
      code(expected!),
    );
  }
  const malformed = initial.replace("sources:", "sources: [broken");
  await adapter.writeFile(path, malformed);
  assert.equal(
    (await readCardDocument(adapter, published.cardId, { view: "raw" })).text,
    malformed,
  );
  await adapter.remove(path);
  await assert.rejects(
    () => createCardDocument(adapter, { cardId: published.cardId, prompt: "reuse" }),
    /already exists/,
  );
});

test("explicit interrupted/continue transitions detect ABA and allow unrelated Git commits", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { cardId: "card-aba", prompt: "work" });
  const taken = (await transitionCardDocument(adapter, card.cardId, "role-a", "take")) as Record<
    string,
    any
  >;
  const interrupted = (await transitionCardDocument(
    adapter,
    card.cardId,
    "role-a",
    "interrupt",
    taken.version,
  )) as Record<string, any>;
  await assert.rejects(
    () => transitionCardDocument(adapter, card.cardId, "role-a", "take"),
    /explicit continue/,
  );
  await transitionCardDocument(adapter, card.cardId, "role-a", "continue", interrupted.version);
  await assert.rejects(
    () => transitionCardDocument(adapter, card.cardId, "role-a", "interrupt", taken.version),
    code("STATE_CHANGED"),
  );
  const role = await adapter.readFile("roles/role-a.md");
  await editRoleContext(adapter, "role-a", { baseEtag: contentEtag(role), body: "new direction" });
  const observed = (await readCardDocument(adapter, card.cardId)) as Record<string, any>;
  assert.equal(
    observed.version.commit,
    (await adapter.history.pathVersions(card.path)).latest!.commit,
  );
  const result = (await transitionCardDocument(
    adapter,
    card.cardId,
    "role-a",
    "interrupt",
    observed.version,
  )) as Record<string, any>;
  assert.equal(result.state, "interrupted");
});

test("large Card inputs and source metadata are complete in Core", async (t) => {
  const { adapter } = await fixture(t);
  const prompt = "内容😀\r\n".repeat(4000);
  const card = await createCardDocument(adapter, {
    cardId: "card-large",
    prompt,
    sources: Array.from({ length: 100 }, (_, i) => ({
      resource: `https://example.invalid/${i}`,
      description: "detail".repeat(100),
    })),
  });
  const page = (await readCardDocument(adapter, card.cardId)) as Record<string, any>;
  assert.equal(page.text, prompt);
  assert.equal(page.sources.length, 100);
  assert.equal(page.page, undefined);
  const taken = await transitionCardDocument(adapter, card.cardId, "role-a", "take");
  assert.equal(taken.text, prompt);
});

test("Card title remains fixed after publication and list includes first publication time", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    cardId: "card-title",
    title: "Review findings",
    prompt: "Review this",
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
    () => transitionCardDocument(adapter, card.cardId, undefined, "take"),
    code("INPUT_CHANGED"),
  );
});

test("Card publication canonicalizes known Node ids in sources and Markdown links", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "[read](node-main)",
    sources: [{ resource: "node-main" }],
  });
  const published = parseFrontmatter(await adapter.readFile(card.path));
  assert.equal(
    (published.data.sources as Array<{ resource: string }>)[0]!.resource,
    "../Main/Main.md",
  );
  assert.equal(published.body, "[read](../Main/Main.md)");
});

test("pending Cards move with CAS and retain destinations, then freeze at reception", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, {
    prompt: "Review",
    title: "Fixed title",
    sources: [{ resource: "/Main/Main.md" }],
    target: "role-a",
  });
  const original = parseFrontmatter(await adapter.readFile(card.path));
  const moved = await moveCardDocument(adapter, card.cardId, {
    target: "role-b",
    expectedEtag: card.etag,
  });
  assert.notEqual(moved.etag, card.etag);
  assert.equal(parseFrontmatter(await adapter.history.read(moved.version)).data.target, "role-b");
  assert.equal(parseFrontmatter(await adapter.history.read(card.version)).data.target, "role-a");
  const same = await moveCardDocument(adapter, card.cardId, {
    target: "role-b",
    expectedEtag: moved.etag,
  });
  assert.deepEqual(same.version, moved.version);
  await assert.rejects(
    () => moveCardDocument(adapter, card.cardId, { target: null, expectedEtag: card.etag }),
    code("STATE_CHANGED"),
  );
  await assert.rejects(
    () =>
      moveCardDocument(adapter, card.cardId, { target: "role-missing", expectedEtag: moved.etag }),
    code("ROLE_UNAVAILABLE"),
  );
  await assert.rejects(
    () => transitionCardDocument(adapter, card.cardId, "role-a", "take"),
    code("RECEPTION_CONFLICT"),
  );
  const open = await moveCardDocument(adapter, card.cardId, {
    target: null,
    expectedEtag: moved.etag,
  });
  const after = parseFrontmatter(await adapter.readFile(card.path));
  assert.equal(after.data.target, undefined);
  assert.deepEqual(after.data.sources, original.data.sources);
  assert.equal(after.body, original.body);
  assert.equal(after.data.title, original.data.title);
  const taken = (await transitionCardDocument(adapter, card.cardId, "role-a", "take")) as Record<
    string,
    any
  >;
  await assert.rejects(
    () => moveCardDocument(adapter, card.cardId, { target: "role-b", expectedEtag: open.etag }),
    (error: any) =>
      error.code === "RECEPTION_CONFLICT" && error.details.current.receivedBy === "role-a",
  );
  const paused = await transitionCardDocument(
    adapter,
    card.cardId,
    "role-a",
    "interrupt",
    taken.version,
  );
  await assert.rejects(
    () => moveCardDocument(adapter, card.cardId, { target: null, expectedEtag: paused.etag }),
    code("RECEPTION_CONFLICT"),
  );
});

test("manual target edits are management conflicts and moves never adopt changed input", async (t) => {
  const { adapter } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "original", target: "role-a" });
  const raw = await adapter.readFile(card.path);
  for (const [changed, expected] of [
    [raw.replace("role-a", "role-b"), "STATE_CHANGED"],
    [raw.replace("original", "changed"), "INPUT_CHANGED"],
  ]) {
    await adapter.writeFile(card.path, changed!);
    await assert.rejects(
      () =>
        moveCardDocument(adapter, card.cardId, {
          target: null,
          expectedEtag: contentEtag(changed!),
        }),
      code(expected!),
    );
    await assert.rejects(
      () => transitionCardDocument(adapter, card.cardId, "role-b", "take"),
      code(expected!),
    );
    assert.equal(
      (await adapter.history.pathVersions(card.path)).latest!.commit,
      card.version.commit,
    );
  }
});

test("move and take share a lock, and take checks the destination that won", async (t) => {
  const { adapter, root } = await fixture(t);
  const card = await createCardDocument(adapter, { prompt: "Review", target: "role-a" });
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = adapter.readFrontmatter.bind(adapter);
  t.mock.method(adapter, "readFrontmatter", async (file: string) => {
    if (file === "roles/role-b.md") {
      entered();
      await gate;
    }
    return read(file);
  });
  const moving = moveCardDocument(adapter, card.cardId, {
    target: "role-b",
    expectedEtag: card.etag,
  });
  await inside;
  try {
    await assert.rejects(
      () => transitionCardDocument(new NodeFs(root), card.cardId, "role-a", "take"),
      /already running another write operation/,
    );
  } finally {
    release();
  }
  await moving;
  await assert.rejects(
    () => transitionCardDocument(adapter, card.cardId, "role-a", "take"),
    code("RECEPTION_CONFLICT"),
  );
  assert.equal(
    (
      (await transitionCardDocument(adapter, card.cardId, "role-b", "take")) as Record<
        string,
        unknown
      >
    ).receivedBy,
    "role-b",
  );
});

test("drafts preserve editable input without capturing until explicit publication", async (t) => {
  const { adapter } = await fixture(t);
  const head = await adapter.history.currentCommit();
  const draft = await createCardDraft(adapter, { cardId: "card-draft", prompt: "" });
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual(await adapter.history.pathVersions(draft.path), {});
  const preview = (await readCardDocument(adapter, draft.cardId, { capture: true })) as Record<
    string,
    any
  >;
  assert.equal(preview.draft, true);
  assert.equal(preview.text, "");
  assert.deepEqual(preview.sources, []);
  await assert.rejects(
    () => transitionCardDocument(adapter, draft.cardId, undefined, "take"),
    code("UNPUBLISHED"),
  );
  await assert.rejects(
    () => publishCardDocument(adapter, draft.cardId, draft.etag),
    /needs prompt text or sources/,
  );
  const sources = [
    { resource: "/Other/Other.md", custom: 1 },
    { resource: "/Main/Main.md" },
    { resource: "/Other/Other.md" },
  ];
  const saved = await writeCardDraft(adapter, draft.cardId, {
    prompt: "draft",
    sources,
    target: "role-a",
    expectedEtag: draft.etag,
  });
  assert.deepEqual(parseFrontmatter(await adapter.readFile(draft.path)).data.sources, sources);
  assert.equal(await adapter.history.currentCommit(), head);
  assert.deepEqual((await listCardDocuments(adapter)).items, []);
  assert.equal((await listCardDocuments(adapter, { includeDrafts: true })).items[0]!.draft, true);
  await assert.rejects(
    () => writeCardDraft(adapter, draft.cardId, { prompt: "stale", expectedEtag: draft.etag }),
    code("STATE_CHANGED"),
  );
  await assert.rejects(
    () => deleteCardDraft(adapter, draft.cardId, draft.etag),
    code("STATE_CHANGED"),
  );
  await assert.rejects(
    () => publishCardDocument(adapter, draft.cardId, draft.etag),
    code("STATE_CHANGED"),
  );
  const published = await publishCardDocument(adapter, draft.cardId, saved.etag);
  const raw = await adapter.readFile(draft.path);
  assert.equal(
    await adapter.history.read((await adapter.history.pathVersions(draft.path)).first!),
    raw,
  );
  assert.equal((parseFrontmatter(raw).data.sources as any[]).length, 3);
  assert.ok((parseFrontmatter(raw).data.sources as any[]).every((s) => s.version?.commit));
  assert.equal((await listCardDocuments(adapter, { state: "pending" })).items[0]!.draft, false);
  await assert.rejects(
    () =>
      writeCardDraft(adapter, draft.cardId, { prompt: "rewrite", expectedEtag: published.etag }),
    code("ALREADY_PUBLISHED"),
  );
  await assert.rejects(
    () => deleteCardDraft(adapter, draft.cardId, published.etag),
    code("ALREADY_PUBLISHED"),
  );
});

test("deleted draft identities stay reserved across adapters without becoming publications", async (t) => {
  const { adapter, root } = await fixture(t);
  const draft = await createCardDraft(adapter, { cardId: "card-deleted", prompt: "discard" });
  const raw = await adapter.readFile(draft.path);
  await deleteCardDraft(adapter, draft.cardId, draft.etag);
  assert.equal(await adapter.exists(draft.path), false);
  assert.deepEqual(await adapter.history.pathVersions(draft.path), {});
  const next = new NodeFs(root);
  for (const create of [createCardDraft, createCardDocument])
    await assert.rejects(
      () => create(next, { cardId: draft.cardId, prompt: "reuse" }),
      /already exists/,
    );
  await next.writeFile(draft.path, raw);
  await assert.rejects(
    () => publishCardDocument(next, draft.cardId, draft.etag),
    /cannot be reused/,
  );
  await deleteCardDraft(next, draft.cardId, draft.etag);
});

test("draft edits preserve unknown metadata and refuse unavailable targets and external edits", async (t) => {
  const { adapter } = await fixture(t);
  const draft = await createCardDraft(adapter, {
    prompt: "first",
    title: "Title",
    target: "role-a",
  });
  const manual = (await adapter.readFile(draft.path)).replace(
    "schemaVersion: 3",
    "schemaVersion: 3\ncustom: retained",
  );
  await adapter.writeFile(draft.path, manual);
  const saved = await writeCardDraft(adapter, draft.cardId, {
    prompt: "next",
    expectedEtag: contentEtag(manual),
  });
  const fields = parseFrontmatter(await adapter.readFile(draft.path)).data;
  assert.equal(fields.custom, "retained");
  assert.equal(fields.title, "Title");
  assert.equal(fields.target, undefined);
  await assert.rejects(
    () =>
      writeCardDraft(adapter, draft.cardId, {
        prompt: "bad",
        target: "role-missing",
        expectedEtag: saved.etag,
      }),
    code("ROLE_UNAVAILABLE"),
  );
  const read = adapter.readFrontmatter.bind(adapter);
  t.mock.method(adapter, "readFrontmatter", async (file: string) => {
    if (file === "roles/role-b.md") await adapter.writeFile(draft.path, manual);
    return read(file);
  });
  await assert.rejects(
    () =>
      writeCardDraft(adapter, draft.cardId, {
        prompt: "bad",
        target: "role-b",
        expectedEtag: saved.etag,
      }),
    code("STATE_CHANGED"),
  );
  assert.equal(await adapter.readFile(draft.path), manual);
});

test("draft saves canonicalize Node references without pinning their versions", async (t) => {
  const { adapter } = await fixture(t);
  const head = await adapter.history.currentCommit();
  const draft = await createCardDraft(adapter, {
    prompt: "[Read](node-main)",
    sources: [{ resource: "node-main" }],
  });
  const first = parseFrontmatter(await adapter.readFile(draft.path));
  assert.equal(first.body, "[Read](../Main/Main.md)");
  assert.deepEqual(first.data.sources, [{ resource: "../Main/Main.md" }]);
  const saved = await writeCardDraft(adapter, draft.cardId, {
    prompt: "[Other](node-other)",
    sources: [{ resource: "node-other" }],
    expectedEtag: draft.etag,
  });
  const next = parseFrontmatter(await adapter.readFile(saved.path));
  assert.equal(next.body, "[Other](../Other/Other.md)");
  assert.deepEqual(next.data.sources, [{ resource: "../Other/Other.md" }]);
  assert.equal(await adapter.history.currentCommit(), head);
});
