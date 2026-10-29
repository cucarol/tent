// The map's canvas file, `.tent/canvas.json`: which topics a person opened or closed, and the drawings.
// The map lays every topic out itself, so the file holds no topic places. It is a
// projection of Tent for looking at and arranging, never Tent data: Agents do not read it. Changes wait in
// `Pending`, by id, and are laid over whatever the file holds when they are written, so a save from another
// page keeps everything this page did not touch. Rules: Tent Node "图谱交互裁定20261021" 「自动排版」.

export type Drawing = { id: string; kind: string; [key: string]: unknown };
/** A card opened past the default depth, or closed within it. */
export type Fold = "open" | "shut";

export type CanvasFile = {
  version: 3;
  open: string[];
  shut: string[];
  drawings: Drawing[];
};

/** The opening read, shared with the map's initial topology read. */
export type CanvasBase = { file: CanvasFile; etag: string | null; unreadable?: true };
export type CanvasInitial = CanvasBase | { error: string };

export const emptyCanvas = (): CanvasFile => ({
  version: 3,
  open: [],
  shut: [],
  drawings: [],
});

/** A strict document or only the unreadable file's ETag; old contents never enter the UI. */
export function canvasBase(current: { etag: string | null; canvas?: unknown }): CanvasBase {
  if ("canvas" in current) return { file: readCanvas(current.canvas), etag: current.etag };
  if (typeof current.etag !== "string") throw new Error("Unreadable canvas has no ETag");
  return { file: emptyCanvas(), etag: current.etag, unreadable: true };
}

const isIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((id) => typeof id === "string");
/** Missing files start empty; unsupported schemas fail without silently dropping their contents. */
export function readCanvas(value: unknown): CanvasFile {
  if (value === null) return emptyCanvas();
  const c = value as Partial<CanvasFile> | null;
  if (
    !c ||
    c.version !== 3 ||
    !isIds(c.open) ||
    !isIds(c.shut) ||
    !Array.isArray(c.drawings) ||
    Object.keys(c).some((key) => !["version", "open", "shut", "drawings"].includes(key)) ||
    new Set(c.open).size !== c.open.length ||
    new Set(c.shut).size !== c.shut.length ||
    c.open.some((id) => c.shut!.includes(id)) ||
    !c.drawings.every(
      (d) =>
        !!d &&
        typeof d.id === "string" &&
        ["pen", "text", "shape"].includes(d.kind) &&
        !Object.prototype.hasOwnProperty.call(d, "node"),
    )
  )
    throw new Error("Invalid canvas structure");
  return {
    version: 3,
    open: c.open,
    shut: c.shut,
    drawings: c.drawings,
  };
}

/** What this page changed and has not written yet, by id; null takes the entry out. */
export type Pending = {
  folds: Map<string, Fold | null>;
  drawings: Map<string, Drawing | null>;
};
export const noPending = (): Pending => ({
  folds: new Map(),
  drawings: new Map(),
});
export const hasPending = (p: Pending) => !!(p.folds.size || p.drawings.size);

/** A list with the pending entries laid over it: changed ones keep their place, new ones go at the end. */
function over<T extends { id: string }>(list: readonly T[], pending: Map<string, T | null>): T[] {
  if (!pending.size) return [...list];
  const out: T[] = [];
  const left = new Map(pending);
  for (const item of list) {
    if (!left.has(item.id)) out.push(item);
    else {
      const next = left.get(item.id);
      left.delete(item.id);
      if (next) out.push(next);
    }
  }
  for (const next of left.values()) if (next) out.push(next);
  return out;
}

/** How a card is folded in the file: opened, closed, or as the default depth has it. */
export const foldOf = (file: CanvasFile, id: string): Fold | null =>
  file.open.includes(id) ? "open" : file.shut.includes(id) ? "shut" : null;

/** Automatic reveals stay in memory; only a real edit may replace an unreadable saved view. */
export function foldEdit(
  file: CanvasFile,
  folds: Record<string, Fold | null>,
  unreadable: boolean,
  userAction: boolean,
): { change: Pending; persist: boolean } {
  return {
    change: {
      folds: new Map(Object.entries(folds).filter(([id, fold]) => foldOf(file, id) !== fold)),
      drawings: new Map(),
    },
    persist: unreadable && userAction,
  };
}

/** The file as it will be once this page's pending changes are written over `file`. */
export function withPending(file: CanvasFile, pending: Pending): CanvasFile {
  if (!hasPending(pending)) return file;
  const open = file.open.filter((id) => !pending.folds.has(id)),
    shut = file.shut.filter((id) => !pending.folds.has(id));
  for (const [id, fold] of pending.folds)
    if (fold === "open") open.push(id);
    else if (fold === "shut") shut.push(id);
  return {
    version: 3,
    open,
    shut,
    drawings: over(file.drawings, pending.drawings),
  };
}

/** The changes still pending once `sent` was written: entries changed again meanwhile stay. */
export function afterSave(pending: Pending, sent: Pending): Pending {
  const keep = <T>(now: Map<string, T>, then: Map<string, T>) =>
    new Map([...now].filter(([id, v]) => !then.has(id) || then.get(id) !== v));
  return {
    folds: keep(pending.folds, sent.folds),
    drawings: keep(pending.drawings, sent.drawings),
  };
}

/**
 * What turns `change` back on `file`: each entry it touches, as the file holds it now; null where the entry
 * is not there. Entries it does not touch are left out, so turning it back keeps them as they are then.
 */
export function inverseOf(file: CanvasFile, change: Pending): Pending {
  const back = noPending();
  for (const id of change.folds.keys()) back.folds.set(id, foldOf(file, id));
  for (const id of change.drawings.keys())
    back.drawings.set(id, file.drawings.find((d) => d.id === id) ?? null);
  return back;
}

/** Pending changes with `more` laid over them. */
export const laidOver = (p: Pending, more: Pending): Pending => ({
  folds: new Map([...p.folds, ...more.folds]),
  drawings: new Map([...p.drawings, ...more.drawings]),
});
