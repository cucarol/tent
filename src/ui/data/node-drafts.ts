/** Unsaved Node edits stay available while navigating within this page. */
export const nodeDrafts = new Map<
  string,
  { text: string; editing: boolean; base: { etag: string; body: string } | null; dirty: boolean }
>();

export const hasUnsavedNodeDrafts = () => [...nodeDrafts.values()].some((draft) => draft.dirty);
