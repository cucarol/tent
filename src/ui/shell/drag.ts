// Dragging Nodes and Cards with the pointer. A Node dropped on a draft becomes its next source; dropped on a
// lane it starts a new Card there. A Card dropped on a lane moves there until a Role receives it.
// Drop targets carry data-drop: "lane:<roleId>" ("lane:" is the public area) or "card:<cardId>".
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

export type Dragged = { kind: "node" | "card"; id: string };
export type DragState = { item: Dragged; x: number; y: number; over: string | null };
export type DropHandler = {
  accepts: (item: Dragged, target: string) => boolean;
  drop: (item: Dragged, target: string) => void;
};

let state: DragState | null = null;
let handler: DropHandler | null = null;
const listeners = new Set<() => void>();
const set = (next: DragState | null) => {
  state = next;
  listeners.forEach((l) => l());
};

export function setDropHandler(next: DropHandler) {
  handler = next;
}

export function useDragState(): DragState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Start watching a press; it becomes a drag once the pointer has moved a few pixels. */
export function beginDrag(e: ReactPointerEvent, item: Dragged) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, textarea, input, a")) return;
  watch(item, { x: e.clientX, y: e.clientY }, false);
}

/** Carry on a drag that is already moving, such as a card leaving the map for a lane. */
export function continueDrag(item: Dragged, at: { x: number; y: number }) {
  watch(item, at, true);
  // Already over a lane when it arrives: letting go at once still drops there.
  set({ item, ...at, over: targetAt(item, at.x, at.y) });
}

/** The drop target under a point that takes this item, or null. */
function targetAt(item: Dragged, x: number, y: number) {
  const target =
    document.elementFromPoint(x, y)?.closest("[data-drop]")?.getAttribute("data-drop") ?? null;
  return target && handler?.accepts(item, target) ? target : null;
}

function watch(item: Dragged, start: { x: number; y: number }, moving: boolean) {
  let active = moving;
  if (moving) document.body.classList.add("is-dragging");
  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      active = true;
      document.body.classList.add("is-dragging");
      window.getSelection()?.removeAllRanges();
    }
    set({ item, x: ev.clientX, y: ev.clientY, over: targetAt(item, ev.clientX, ev.clientY) });
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    if (!active) return;
    document.body.classList.remove("is-dragging");
    const over = state?.over;
    set(null);
    // The press that ended a drag is not also a click on what lies under it.
    const swallow = (ev: Event) => ev.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (drop && over) handler?.drop(item, over);
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !active) return;
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
