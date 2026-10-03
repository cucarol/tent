// The annotation layer's saved form (.tent/annotations.json through the service) and how two
// versions of it combine. Kept free of Excalidraw's runtime so it can be tested on its own.

/** The card a mark was drawn next to, and where that card was at the time. */
export type Anchor = { node: string; x: number; y: number };
type Element = { id: string; version: number; isDeleted?: boolean };

export type AnnotationDocument<E extends Element = Element> = {
  schemaVersion: 1;
  map: { elements: E[]; anchors: Record<string, Anchor> };
};

/** What the browser keeps: the scene, and what it still owes the workspace. */
export type Stored<E extends Element = Element> = {
  elements: E[];
  anchors: Record<string, Anchor>;
  /** The scene has changes the workspace does not have yet. */
  unsaved?: boolean;
  /** The saved annotations those changes were made on, by ETag and element versions. */
  baseEtag?: string | null;
  base?: Record<string, number>;
};

export const versionsOf = (elements: readonly Element[]) =>
  new Map(elements.map((e) => [e.id, e.version]));

/** Changes whenever an element is added, removed or edited. */
export const signature = (elements: readonly Element[]) =>
  elements.map((e) => `${e.id}:${e.version}`).join(",");

/**
 * Three-way merge by element against `base`, the saved versions this page started from: a change
 * made on only one side is kept, including a deletion; when both sides changed an element, the
 * higher version wins, as in Excalidraw's own collaboration.
 */
export function mergeElements<E extends Element>(
  base: ReadonlyMap<string, number>,
  mine: readonly E[],
  theirs: readonly E[],
): E[] {
  const theirById = new Map(theirs.map((e) => [e.id, e]));
  const mineById = new Map(mine.map((e) => [e.id, e]));
  const untouched = (e: E) => base.get(e.id) === e.version;
  const out: E[] = [];
  // Kept when new on its side, or edited there after the other side removed it.
  for (const m of mine) {
    const t = theirById.get(m.id);
    if (t) out.push(t.version > m.version ? t : m);
    else if (!untouched(m)) out.push(m);
  }
  for (const t of theirs) if (!mineById.has(t.id) && !untouched(t)) out.push(t);
  return out;
}
