// Dragging Nodes and Cards with the pointer. A Node dropped on a draft becomes its next source; dropped on a
// robot (a lane) it starts a new Card there. Several Nodes travel together when a picked set or a region is
// dragged. A Card dropped on a lane moves there until a Role receives it; dropped on a waiting Card it takes
// the place before or after it, in that Card's lane.
// Drop targets carry data-drop: "lane:<roleId>" ("lane:" is the public area), "card:<cardId>", or
// "at:<cardId>", which data-drop-split turns into "at:<cardId>:before" or ":after" by the pointer's height.
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

/** `ids`, for Nodes carried together, lists all of them in order, `id` first. */
export type Dragged = { kind: "node" | "card"; id: string; ids?: string[] };
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

/** The nearest drop target under a point that takes this item, or null; one refusing passes to the next out. */
function targetAt(item: Dragged, x: number, y: number) {
  for (
    let el = document.elementFromPoint(x, y)?.closest("[data-drop]");
    el;
    el = el.parentElement?.closest("[data-drop]")
  ) {
    let target = el.getAttribute("data-drop")!;
    if (el.hasAttribute("data-drop-split")) {
      const r = el.getBoundingClientRect();
      target += y < r.top + r.height / 2 ? ":before" : ":after";
    }
    if (handler?.accepts(item, target)) return target;
  }
  return null;
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
