// Card drafts written in this page, saved to their workspace files as they change, and the moves that put
// Cards in the public area or a Role's lane. Every write sends the ETag it last saw (Tent Node "Web界面服务接口").
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError, describe, type CardSourceInput, type DraftInput } from "./api.js";
import type { SnapshotCard } from "./types.js";
import { t } from "../i18n.js";

export type Draft = {
  id: string;
  etag: string | null;
  input: DraftInput;
  /** Edits not yet written, and whether a write is on its way. */
  dirty: boolean;
  saving: boolean;
  failed: string | null;
};

const drafts = new Map<string, Draft>();
const loading = new Map<string, Promise<void>>();
const publishing = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let notify: (text: string) => void = () => {};

/** Where drafts report what happened (the page's toast). */
export function onDraftNotice(fn: (text: string) => void) {
  notify = fn;
}

function put(draft: Draft) {
  drafts.set(draft.id, draft);
  listeners.forEach((l) => l());
}
function drop(id: string) {
  drafts.delete(id);
  clearTimeout(timers.get(id));
  timers.delete(id);
  listeners.forEach((l) => l());
}

/** A Card that has never been published is a draft: it has no history yet. */
export const isDraft = (card: SnapshotCard) => card.history.length === 0;

const inputOf = (doc: Awaited<ReturnType<typeof api.card>>): DraftInput => ({
  prompt: doc.text,
  ...(doc.title !== undefined ? { title: doc.title } : {}),
  target: doc.target ?? null,
  sources: doc.sources ?? [],
});

async function load(id: string) {
  let pending = loading.get(id);
  if (!pending) {
    pending = api
      .card(id)
      .then((doc) => {
        const current = drafts.get(id);
        if (!doc.draft) return drop(id);
        if (current?.dirty || current?.saving) return;
        put({ id, etag: doc.etag, input: inputOf(doc), dirty: false, saving: false, failed: null });
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 404) drop(id);
        else notify(describe(error));
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

/** Read a draft from its file unless this page already has it. */
export async function ensureDraft(id: string) {
  if (!drafts.has(id)) await load(id);
}

/** A draft as this page knows it, loaded from its file on first use. */
export function useDraft(id: string | null): Draft | null {
  useEffect(() => {
    if (id && !drafts.has(id)) void load(id);
  }, [id]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (id ? (drafts.get(id) ?? null) : null),
  );
}

const trimEnd = (s: string) => s.replace(/\s+$/, "");
/**
 * After the workspace changes, reread drafts that someone else changed; ones with edits waiting keep them.
 * Drafts that are gone or published are forgotten.
 */
export function syncDrafts(cards: SnapshotCard[]) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const draft of [...drafts.values()]) {
    if (draft.dirty || draft.saving) continue;
    const card = byId.get(draft.id);
    if (!card || !isDraft(card)) {
      drop(draft.id);
      continue;
    }
    const same =
      trimEnd(card.body) === trimEnd(draft.input.prompt) &&
      (card.target ?? null) === draft.input.target &&
      card.sources.map((s) => s.resource).join("\n") ===
        draft.input.sources.map((s) => s.resource).join("\n");
    if (!same) void load(draft.id);
  }
}

async function save(id: string): Promise<void> {
  const draft = drafts.get(id);
  if (!draft || draft.saving || !draft.dirty) return;
  if (!draft.etag) {
    await load(id);
    return save(id);
  }
  const input = draft.input;
  put({ ...draft, saving: true, dirty: false });
  try {
    const saved = await api.saveDraft(id, draft.etag, input);
    const now = drafts.get(id);
    if (now) put({ ...now, etag: saved.etag, saving: false, failed: null });
  } catch (error) {
    const now = drafts.get(id);
    if (!now) return;
    put({ ...now, saving: false, dirty: true, failed: describe(error) });
    notify(describe(error));
    return;
  }
  if (drafts.get(id)?.dirty) return save(id);
}

/** Change a draft; text waits for a pause in typing, everything else is written at once. */
export function editDraft(id: string, change: (input: DraftInput) => DraftInput, typing = false) {
  if (publishing.has(id)) return;
  const draft = drafts.get(id);
  if (!draft) return;
  put({ ...draft, input: change(draft.input), dirty: true, failed: null });
  clearTimeout(timers.get(id));
  if (typing)
    timers.set(
      id,
      setTimeout(() => void save(id), 600),
    );
  else void save(id);
}

/** Write any waiting edits now. */
export async function flushDraft(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  await save(id);
  while (drafts.get(id)?.saving || loading.has(id)) await new Promise((r) => setTimeout(r, 60));
  const draft = drafts.get(id);
  if (draft?.failed || draft?.dirty) throw new Error(draft.failed ?? t.work.notSaved);
}

/** Finish this page's pending Card edits before leaving its workspace. */
export async function flushDrafts() {
  do {
    for (const id of drafts.keys()) await flushDraft(id);
  } while ([...drafts.values()].some((draft) => draft.dirty || draft.saving));
}

/** A new draft in a lane; it is a Card file in the workspace from the start. */
export async function createDraft(target: string | null, sources: CardSourceInput[] = []) {
  const input: DraftInput = { prompt: "", target, sources };
  const saved = await api.createDraft(input);
  put({ id: saved.cardId, etag: saved.etag, input, dirty: false, saving: false, failed: null });
  return saved.cardId;
}

export async function publishDraft(id: string) {
  await flushDraft(id);
  const draft = drafts.get(id);
  if (!draft?.etag) throw new Error(t.work.notLoaded);
  if (!draft.input.prompt.trim() && !draft.input.sources.length) throw new Error(t.work.empty);
  publishing.add(id);
  try {
    await api.publishCard(id, draft.etag);
    drop(id);
  } finally {
    publishing.delete(id);
  }
}

export async function discardDraft(id: string) {
  clearTimeout(timers.get(id));
  await flushDraft(id).catch(() => {});
  const etag = drafts.get(id)?.etag ?? (await api.card(id)).etag;
  await api.deleteDraft(id, etag);
  drop(id);
}

/** Put a Card in a lane: a draft saves its new target, a published Card moves until a Role receives it. */
export async function moveCard(card: SnapshotCard, target: string | null) {
  // Read the file first: the page may not have seen a publication yet.
  const doc = await api.card(card.id);
  if (doc.draft) {
    if (!drafts.has(card.id)) await load(card.id);
    editDraft(card.id, (input) => ({ ...input, target }));
    await flushDraft(card.id);
    return;
  }
  await api.moveCard(card.id, doc.etag, target);
}
