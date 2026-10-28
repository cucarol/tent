import type { AgentsFile } from "./api.js";

/** Unsaved Node edits stay available while navigating within this page. */
export const nodeDrafts = new Map<
  string,
  { text: string; editing: boolean; base: { etag: string; body: string } | null; dirty: boolean }
>();

/** Unsaved AGENTS.md edits, kept the same way. */
export const agentsDraft: {
  current: { text: string; editing: boolean; base: AgentsFile | null; dirty: boolean } | null;
} = { current: null };

export const hasUnsavedNodeDrafts = () =>
  [...nodeDrafts.values()].some((draft) => draft.dirty) || !!agentsDraft.current?.dirty;
