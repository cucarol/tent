// One owner carries the same lifted body across the map, dock and sidebar.
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "../i18n.js";
import { floatingPosition } from "../map/pointer.js";
export type Dragged = { kind: "node" | "card"; id: string; ids?: string[]; from?: "map" };
export type DragState = { item: Dragged; over: string | null };
export type DropHandler = {
  accepts: (item: Dragged, target: string) => boolean;
  drop: (item: Dragged, target: string) => void;
};
type Box = { left: number; top: number; right: number; bottom: number };
type Target = { el: HTMLElement; rect: DOMRect; target: string };
let state: DragState | null = null;
let handler: DropHandler | null = null;
let cancelOwner: (() => void) | null = null;
let settleOwner: (() => void) | null = null;
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
/** Map topics dispatch to Roles or move through the directory tree only. */
export function mapDropAllowed(item: Dragged, target: string) {
  return item.from !== "map" || target.startsWith("tree:") || /^lane:.+/.test(target);
}
export function distanceToBox(x: number, y: number, r: Box) {
  return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
}
export function edgeScroll(y: number, r: Box) {
  const band = Math.min(36, (r.bottom - r.top) / 3);
  if (y < r.top || y > r.bottom) return 0;
  if (y < r.top + band) return -12 * (1 - (y - r.top) / band);
  if (y > r.bottom - band) return 12 * (1 - (r.bottom - y) / band);
  return 0;
}
function targetAt(item: Dragged, x: number, y: number): Target | null {
  const candidates = [...document.querySelectorAll<HTMLElement>("[data-drop]")].flatMap((el) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || distanceToBox(x, y, rect) > 24) return [];
    const scroll = el.closest<HTMLElement>(".tree-rows");
    if (scroll) {
      const r = scroll.getBoundingClientRect();
      if (rect.bottom <= r.top || rect.top >= r.bottom || distanceToBox(x, y, r) > 24) return [];
    }
    let target = el.dataset.drop!;
    const at = (y - rect.top) / rect.height;
    if (el.hasAttribute("data-drop-split")) target += at < 0.5 ? ":before" : ":after";
    if (el.hasAttribute("data-drop-zones"))
      target += at < 0.28 ? ":before" : at > 0.72 ? ":after" : ":inside";
    return mapDropAllowed(item, target) && handler?.accepts(item, target)
      ? [{ el, rect, target }]
      : [];
  });
  const rank = (p: Target) => {
    // An explicit draft/queue row inside a lane keeps its own action. Map sources were filtered above.
    if (
      (p.target.startsWith("card:") || p.target.startsWith("at:")) &&
      distanceToBox(x, y, p.rect) === 0
    )
      return -1;
    return p.target.startsWith("lane:") ? 0 : p.target.startsWith("tree:") ? 1 : 2;
  };
  return (
    candidates.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        distanceToBox(x, y, a.rect) - distanceToBox(x, y, b.rect) ||
        a.rect.height - b.rect.height,
    )[0] ?? null
  );
}
export function beginDrag(
  e: ReactPointerEvent,
  item: Dragged,
  options: {
    source?: HTMLElement;
    originals?: HTMLElement[];
    onLift?: () => void;
  } = {},
) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, textarea, input, a")) return;
  cancelOwner?.();
  settleOwner?.();
  const capture = e.currentTarget as HTMLElement,
    pointerId = e.pointerId;
  const source = options.source ?? capture,
    originals = options.originals ?? [source];
  const start = { x: e.clientX, y: e.clientY },
    origin = source.getBoundingClientRect();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = false,
    done = false,
    frame = 0,
    x = start.x,
    y = start.y;
  let hit: Target | null = null,
    previousTarget: HTMLElement | null = null;
  let ghost: HTMLElement | null = null,
    hint: HTMLElement | null = null;
  let hintSize = { w: 0, h: 0 };
  let targetsChanged: MutationObserver | null = null;
  const refresh = () => {
    hit = targetAt(item, x, y);
    const over = hit?.target ?? null;
    const changed = !state || state.over !== over || previousTarget !== (hit?.el ?? null);
    if (changed) {
      previousTarget?.classList.remove("is-drop-near");
      previousTarget = hit?.el ?? null;
      previousTarget?.classList.add("is-drop-near");
      set({ item, over });
      if (hint) {
        const name = hit?.el.dataset.dropLabel ?? "";
        hint.textContent = !hit
          ? ""
          : over!.startsWith("lane:")
            ? t.work.dropTo(name)
            : over!.endsWith(":before")
              ? t.side.dropBefore(name)
              : over!.endsWith(":after")
                ? t.side.dropAfter(name)
                : t.side.dropInside(name);
        const r = hint.getBoundingClientRect();
        hintSize = { w: r.width, h: r.height };
      }
    }
    const near = hit && distanceToBox(x, y, hit.rect) > 0;
    const sx = near ? Math.max(-4, Math.min(4, (hit!.rect.left + hit!.rect.right) / 2 - x)) : 0;
    const sy = near ? Math.max(-4, Math.min(4, (hit!.rect.top + hit!.rect.bottom) / 2 - y)) : 0;
    if (ghost) ghost.style.transform = `translate3d(${x - start.x + sx}px,${y - start.y + sy}px,0)`;
    if (ghost && hint && hint.textContent) {
      const protectedRects = [
        ...document.querySelectorAll<HTMLElement>(".mind-topic.is-selected, .mind-topic.is-picked"),
      ].flatMap((el) => {
        const b = el.getBoundingClientRect();
        return b.right > 0 && b.left < innerWidth && b.bottom > 0 && b.top < innerHeight
          ? [{ x: b.left, y: b.top, w: b.width, h: b.height }]
          : [];
      });
      protectedRects.push({ x: x - 12, y: y - 12, w: 24, h: 24 });
      const best = floatingPosition(
        { x: 8, y: 8, w: innerWidth - 16, h: innerHeight - 16 },
        { x: x + 18, y: y + 18, w: hintSize.w, h: hintSize.h },
        protectedRects,
      );
      hint.style.transform = `translate3d(${best.x - origin.left - (x - start.x + sx)}px,${best.y - origin.top - (y - start.y + sy)}px,0)`;
    }
  };
  const scrollFrame = () => {
    if (!active || done) return;
    const scroll = document.querySelector<HTMLElement>(".tree-rows");
    if (scroll) {
      const r = scroll.getBoundingClientRect();
      if (x >= r.left - 24 && x <= r.right + 24) {
        const dy = edgeScroll(y, r);
        if (dy) {
          scroll.scrollTop += dy;
          refresh();
        }
      }
    }
    frame = requestAnimationFrame(scrollFrame);
  };
  const lift = () => {
    active = true;
    // Held only once the press is a drag: a plain click keeps its own target, so the card still hears it.
    capture.setPointerCapture(pointerId);
    capture.addEventListener("lostpointercapture", lost);
    document.body.classList.add("is-dragging");
    window.getSelection()?.removeAllRanges();
    ghost = document.createElement("div");
    ghost.className = "drag-body";
    ghost.dataset.dragOverlay = "";
    Object.assign(ghost.style, {
      left: `${origin.left}px`,
      top: `${origin.top}px`,
      width: `${origin.width}px`,
      height: `${origin.height}px`,
    });
    const body = source.cloneNode(true) as HTMLElement;
    body.removeAttribute("id");
    body.removeAttribute("data-drop");
    body.querySelectorAll("[id], [data-drop]").forEach((n) => {
      n.removeAttribute("id");
      n.removeAttribute("data-drop");
    });
    body.classList.remove("react-flow__node", "nopan", "is-away", "is-tucked");
    body.classList.add("drag-body-copy");
    Object.assign(body.style, {
      position: "relative",
      transform: "none",
      translate: "none",
      left: "0",
      top: "0",
      width: `${source.offsetWidth}px`,
      height: `${source.offsetHeight}px`,
      margin: "0",
      transformOrigin: "0 0",
    });
    ghost.style.setProperty(
      "--topic-scale",
      getComputedStyle(source).getPropertyValue("--topic-scale"),
    );
    const scale = origin.width / Math.max(1, source.offsetWidth),
      lifted = reduced ? scale : scale * 1.025;
    body.style.transform = `translate(${(start.x - origin.left) * (1 - lifted / scale)}px,${(start.y - origin.top) * (1 - lifted / scale)}px) scale(${lifted})`;
    ghost.append(body);
    const count = item.ids?.length ?? 1;
    if (count > 1) {
      ghost.classList.add("is-stack");
      const badge = document.createElement("span");
      badge.className = "drag-count";
      badge.textContent = String(count);
      ghost.append(badge);
    }
    hint = document.createElement("div");
    hint.className = "drag-result";
    hint.style.left = "0";
    hint.style.top = "0";
    ghost.append(hint);
    document.body.append(ghost);
    originals.forEach((n) => n.classList.add("is-drag-placeholder"));
    set({ item, over: null });
    options.onLift?.();
    refresh();
    targetsChanged = new MutationObserver(() => {
      if (active && !done) refresh();
    });
    document
      .querySelectorAll(".roles, .tree-rows")
      .forEach((el) => targetsChanged!.observe(el, { childList: true, subtree: true }));
    frame = requestAnimationFrame(scrollFrame);
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId || done) return;
    x = ev.clientX;
    y = ev.clientY;
    if (!active && Math.hypot(x - start.x, y - start.y) <= 4) return;
    if (!active) lift();
    else refresh();
  };
  const finish = (drop: boolean) => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    targetsChanged?.disconnect();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, { capture: true });
    capture.removeEventListener("lostpointercapture", lost);
    if (capture.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId);
    cancelOwner = null;
    if (!active) return;
    const accepted =
      drop && hit && mapDropAllowed(item, hit.target) && handler?.accepts(item, hit.target)
        ? hit
        : null;
    previousTarget?.classList.remove("is-drop-near");
    document.body.classList.remove("is-dragging");
    set(null);
    hint?.remove();
    const duration = reduced ? 0 : accepted ? 150 : 180;
    const transitions = originals.map((n) => n.style.transition);
    originals.forEach((n) => {
      n.style.transition = reduced ? "none" : `opacity ${duration}ms ease-out`;
      n.classList.remove("is-drag-placeholder");
    });
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const remove = () => {
      clearTimeout(settleTimer);
      if (settleOwner === remove) settleOwner = null;
      ghost?.remove();
      originals.forEach((n, i) => (n.style.transition = transitions[i]!));
    };
    if (ghost && !reduced) {
      const end = accepted
        ? `translate3d(${(accepted.rect.left + accepted.rect.right) / 2 - origin.left - origin.width / 2}px,${(accepted.rect.top + accepted.rect.bottom) / 2 - origin.top - origin.height / 2}px,0) scale(0.1)`
        : "translate3d(0,0,0)";
      ghost.style.transition = `transform ${accepted ? 150 : 180}ms ease-out, opacity ${accepted ? 150 : 180}ms ease-out`;
      ghost.style.transform = end;
      ghost.style.opacity = "0";
      settleOwner = remove;
      settleTimer = setTimeout(remove, duration);
    } else remove();
    const swallow = (ev: Event) => ev.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (accepted) handler!.drop(item, accepted.target);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) {
      x = ev.clientX;
      y = ev.clientY;
      if (active) refresh();
      finish(true);
    }
  };
  const cancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) finish(false);
  };
  const lost = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) finish(false);
  };
  const key = (ev: KeyboardEvent) => {
    if (!done && ev.key === "Escape") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      finish(false);
    }
  };
  cancelOwner = () => finish(false);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, { capture: true });
}
