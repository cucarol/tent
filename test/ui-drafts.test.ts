import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { api, ApiError, type CardDocument, type DraftInput } from "../src/ui/data/api.js";
import {
  discardDraft,
  editDraft,
  ensureDraft,
  flushDraft,
  flushDrafts,
  publishDraft,
} from "../src/ui/data/drafts.js";

async function draft(t: TestContext, id: string, extra: Partial<CardDocument> = {}) {
  const doc: CardDocument = {
    cardId: id,
    path: `cards/${id}.md`,
    etag: "seen-version",
    text: "Saved prompt",
    draft: true,
    state: "pending",
    sources: [],
    ...extra,
  };
  const read = t.mock.method(api, "card", async () => doc);
  t.mock.method(api, "deleteDraft", async () => doc);
  t.after(async () => {
    t.mock.method(api, "saveDraft", async () => doc);
    await discardDraft(id);
  });
  await ensureDraft(id);
  return { doc, read };
}

test("a failed draft save prevents publishing stale contents and retains edits for retry", async (t) => {
  const id = "card-failed-save";
  const { doc } = await draft(t, id);
  const saved: DraftInput[] = [];
  const save = t.mock.method(
    api,
    "saveDraft",
    async (...[_id, etag, input]: Parameters<typeof api.saveDraft>) => {
      assert.equal(etag, doc.etag);
      saved.push(input);
      throw new ApiError(500, "WRITE_FAILED", "Could not save");
    },
  );
  const publish = t.mock.method(api, "publishCard", async () => doc);
  editDraft(id, (input) => ({ ...input, prompt: "Latest prompt" }), true);

  await assert.rejects(publishDraft(id), /Could not save/);
  assert.equal(publish.mock.callCount(), 0);
  assert.equal(saved[0]?.prompt, "Latest prompt");

  save.mock.mockImplementation(async (...[_id, etag, input]: Parameters<typeof api.saveDraft>) => {
    assert.equal(etag, doc.etag);
    assert.equal(input.prompt, "Latest prompt");
    return { ...doc, etag: "saved-version" };
  });
  await publishDraft(id);
  assert.deepEqual(publish.mock.calls[0]?.arguments, [id, "saved-version"]);
});

for (const code of ["STATE_CHANGED", "ETAG_CONFLICT"]) {
  test(`draft ${code} keeps the observed version and never overwrites another writer`, async (t) => {
    const id = `card-conflict-${code}`;
    const { doc, read } = await draft(t, id);
    read.mock.mockImplementation(async () => ({ ...doc, etag: "someone-elses-version" }));
    const save = t.mock.method(
      api,
      "saveDraft",
      async (...[_id, etag]: Parameters<typeof api.saveDraft>) => {
        if (etag === "seen-version") throw new ApiError(409, code, "Changed elsewhere");
        return { ...doc, etag: "overwritten-version" };
      },
    );
    const publish = t.mock.method(api, "publishCard", async () => doc);
    editDraft(id, (input) => ({ ...input, prompt: "My local edit" }), true);

    await assert.rejects(publishDraft(id), /Changed elsewhere/);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(publish.mock.callCount(), 0);
    await assert.rejects(flushDraft(id), /Changed elsewhere/);
    assert.equal(save.mock.calls[1]?.arguments[1], "seen-version");
    assert.equal(save.mock.calls[1]?.arguments[2]?.prompt, "My local edit");
  });
}

test("editing a draft preserves source metadata and explicit versions", async (t) => {
  const id = "card-source-metadata";
  const sources = [
    {
      resource: "node-example",
      title: "",
      version: { commit: "pinned-commit", path: "Example/Example.md" },
      provenance: { author: "original", labels: ["reference"] },
    },
  ];
  const { doc } = await draft(t, id, { sources });
  const save = t.mock.method(api, "saveDraft", async () => doc);
  editDraft(id, (input) => ({ ...input, prompt: "Edited prompt" }), true);
  await flushDraft(id);
  assert.deepEqual(save.mock.calls[0]?.arguments[2]?.sources, sources);
});

test("publication drains edits made during an in-flight save and uses its final ETag", async (t) => {
  const id = "card-inflight-save";
  const { doc } = await draft(t, id);
  let release!: () => void;
  let started!: () => void;
  const saving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inputs: DraftInput[] = [];
  t.mock.method(
    api,
    "saveDraft",
    async (...[_id, etag, input]: Parameters<typeof api.saveDraft>) => {
      inputs.push(input);
      if (inputs.length === 1) {
        assert.equal(etag, "seen-version");
        started();
        await pending;
        return { ...doc, etag: "first-save" };
      }
      assert.equal(etag, "first-save");
      return { ...doc, etag: "second-save" };
    },
  );
  const publish = t.mock.method(api, "publishCard", async () => doc);
  editDraft(id, (input) => ({ ...input, prompt: "First edit" }), true);
  const published = publishDraft(id);
  await saving;
  editDraft(id, (input) => ({ ...input, prompt: "Latest edit" }), true);
  release();
  await published;
  assert.deepEqual(
    inputs.map((input) => input.prompt),
    ["First edit", "Latest edit"],
  );
  assert.deepEqual(publish.mock.calls[0]?.arguments, [id, "second-save"]);
});

test("a publishing draft stops accepting edits until a failed publication finishes", async (t) => {
  const id = "card-publishing";
  const { doc } = await draft(t, id);
  const save = t.mock.method(api, "saveDraft", async () => doc);
  let started!: () => void;
  let fail!: (error: Error) => void;
  const publishing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  t.mock.method(api, "publishCard", () => {
    started();
    return pending;
  });
  const result = publishDraft(id);
  const failed = assert.rejects(result, /Publish failed/);
  await publishing;
  const change = t.mock.fn((input: DraftInput) => ({ ...input, prompt: "Too late" }));
  editDraft(id, change, true);
  fail(new Error("Publish failed"));
  await failed;
  assert.equal(change.mock.callCount(), 0);
  editDraft(id, (input) => ({ ...input, prompt: "After failure" }), true);
  await flushDraft(id);
  assert.equal(save.mock.calls[0]?.arguments[2]?.prompt, "After failure");
});

test("leaving a workspace drains edits made to an earlier draft while a later one saves", async (t) => {
  const first = "card-leave-first";
  const second = "card-leave-second";
  const { doc } = await draft(t, first);
  await draft(t, second);
  let started!: () => void;
  let release!: () => void;
  const saving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saved: string[] = [];
  t.mock.method(
    api,
    "saveDraft",
    async (...[id, _etag, input]: Parameters<typeof api.saveDraft>) => {
      saved.push(`${id}: ${input.prompt}`);
      if (id === second) {
        started();
        await pending;
      }
      return { ...doc, etag: `saved-${saved.length}` };
    },
  );
  editDraft(first, (input) => ({ ...input, prompt: "First edit" }), true);
  editDraft(second, (input) => ({ ...input, prompt: "Other draft" }), true);
  let finished = false;
  const flushed = flushDrafts().then(() => {
    finished = true;
  });
  await saving;
  assert.equal(finished, false);
  editDraft(first, (input) => ({ ...input, prompt: "Latest edit" }), true);
  release();
  await flushed;
  assert.deepEqual(saved, [
    `${first}: First edit`,
    `${second}: Other draft`,
    `${first}: Latest edit`,
  ]);
});

test("leaving a workspace fails on an unsaved draft and keeps its contents for retry", async (t) => {
  const id = "card-leave-failed";
  const { doc } = await draft(t, id);
  const save = t.mock.method(api, "saveDraft", async () => {
    throw new ApiError(409, "STATE_CHANGED", "Changed elsewhere");
  });
  editDraft(id, (input) => ({ ...input, prompt: "Keep this edit" }), true);
  await assert.rejects(flushDrafts(), /Changed elsewhere/);
  save.mock.mockImplementation(async (...[_id, etag, input]: Parameters<typeof api.saveDraft>) => {
    assert.equal(etag, "seen-version");
    assert.equal(input.prompt, "Keep this edit");
    return doc;
  });
  await flushDrafts();
});
