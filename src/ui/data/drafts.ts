// Unsent Card composition stays in this browser, isolated by Workspace identity.
import { useSyncExternalStore } from "react";
import { api, type CardMove, type CardSourceInput, type CardInput } from "./api.js";
import type { SnapshotCard } from "./types.js";
import { t } from "../i18n.js";

export type Draft = { id: string; input: CardInput; failed: string | null };
const drafts = new Map<string, Draft>();
const publishing = new Set<string>();
const listeners = new Set<() => void>();
let workspace = "";
let cards: SnapshotCard[] = [];
const storageKey = () => `tent-unsent-cards:${workspace}`;
export const isDraft = (card: Pick<SnapshotCard, "id">) => card.id.startsWith("local-card-");

function changed(save = true) {
  if (save) {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify([...drafts.values()].map(({ id, input }) => ({ id, input }))),
      );
      for (const [id, draft] of drafts)
        if (draft.failed) drafts.set(id, { ...draft, failed: null });
    } catch {
      for (const [id, draft] of drafts) drafts.set(id, { ...draft, failed: t.work.localOnly });
    }
  }
  cards = [...drafts.values()].map(({ id, input }) => ({
    id,
    title:
      input.title ??
      input.prompt
        .split("\n")
        .map((line) => line.replace(/^#+\s*/, "").trim())
        .find(Boolean) ??
      "",
    state: "pending",
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    target: input.target,
    receivedBy: null,
    status: "stable",
    body: input.prompt,
    sources: input.sources.map((s) => ({ ...s, kind: "text", version: null, changedSince: false })),
    path: "",
    history: [],
    publishedAt: null,
    updatedAt: null,
  }));
  listeners.forEach((listener) => listener());
}

/** Refreshes restore only this Workspace's unsent edits. */
export function loadLocalDrafts(workspaceId: string) {
  if (workspace === workspaceId) return;
  workspace = workspaceId;
  drafts.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) ?? "[]") as Draft[];
    for (const draft of saved)
      if (
        isDraft(draft) &&
        typeof draft.input?.prompt === "string" &&
        Array.isArray(draft.input.sources)
      )
        drafts.set(draft.id, { ...draft, failed: null });
  } catch {
    /* Unreadable browser data cannot be a published Card. */
  }
  changed(false);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const localDraftCards = () => cards;
export const useDraftCards = () => useSyncExternalStore(subscribe, localDraftCards);
export function useDraft(id: string | null): Draft | null {
  return useSyncExternalStore(subscribe, () => (id ? (drafts.get(id) ?? null) : null));
}

export function createDraft(target: string | null, sources: CardSourceInput[] = []) {
  const id = `local-card-${crypto.randomUUID()}`;
  drafts.set(id, { id, input: { prompt: "", target, sources }, failed: null });
  changed();
  return id;
}

export function editDraft(id: string, change: (input: CardInput) => CardInput) {
  if (publishing.has(id)) return;
  const draft = drafts.get(id);
  if (!draft) return;
  drafts.set(id, { ...draft, input: change(draft.input) });
  changed();
}

export async function publishDraft(id: string) {
  const draft = drafts.get(id);
  if (!draft) throw new Error(t.work.notLoaded);
  if (publishing.has(id)) return;
  if (!draft.input.prompt.trim() && !draft.input.sources.length) throw new Error(t.work.empty);
  const originWorkspace = workspace;
  const originKey = storageKey();
  publishing.add(id);
  try {
    const saved = await api.createCard(draft.input);
    if (workspace === originWorkspace) {
      drafts.delete(id);
      changed();
    } else {
      const originDrafts = JSON.parse(localStorage.getItem(originKey) ?? "[]") as Draft[];
      localStorage.setItem(originKey, JSON.stringify(originDrafts.filter((d) => d.id !== id)));
    }
    return saved;
  } finally {
    publishing.delete(id);
  }
}

export function discardDraft(id: string) {
  if (publishing.has(id)) return;
  drafts.delete(id);
  changed();
}

/** Who the result comes back to; null means receiving finishes the Card. */
export function setDraftReturn(id: string, returnTo: string | null) {
  editDraft(id, (input) => {
    const next = { ...input };
    if (returnTo) next.returnTo = returnTo;
    else delete next.returnTo;
    return next;
  });
}

/**
 * Local targets can change while composing; sent Cards use their observed version, and can also take a place
 * in their queue. Drafts are in no queue yet, so only their lane changes.
 */
export async function moveCard(card: SnapshotCard, to: CardMove) {
  const target = to.target === undefined ? card.target : to.target;
  if (isDraft(card)) {
    // A Card cannot return to its own receiver, so going to the Role it returns to drops the return.
    editDraft(card.id, (input) => {
      const next = { ...input, target };
      if (next.returnTo === target) delete next.returnTo;
      return next;
    });
    return;
  }
  const doc = await api.card(card.id);
  await api.moveCard(card.id, doc.etag, to);
}
