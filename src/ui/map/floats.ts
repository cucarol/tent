import { useLayoutEffect, useRef, type RefObject } from "react";
import { floatingPosition } from "./pointer.js";
const SELECTOR =
  ":scope > .map-peek, :scope > .map-hands, :scope > .map-hint, :scope > .map-lens, :scope > .maptools, :scope > .inktools, :scope > .ink-style, :scope > .map-selection-reaction, :scope > .map-tip";
/** Measure the rendered panels, including late file previews, before placing them. */
export function useFloatingPanels(root: RefObject<HTMLDivElement | null>, ids: readonly string[]) {
  const currentIds = useRef(ids);
  currentIds.current = ids;
  const position = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let point: { x: number; y: number; target: Element | null } | null = null;
    let raf = 0;
    let tip: HTMLDivElement | null = null;
    let tipSource: HTMLElement | null = null;
    const offsets = new WeakMap<HTMLElement, { x: number; y: number }>();
    const rect = (r: DOMRect) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
    const place = () => {
      const outer = el.getBoundingClientRect();
      const detail = el.closest(".surface")?.querySelector<HTMLElement>(".detail");
      const overlay =
        detail && getComputedStyle(detail).position === "absolute"
          ? detail.getBoundingClientRect()
          : null;
      const right =
        overlay && overlay.left < outer.right && overlay.right > outer.left
          ? Math.max(outer.left, overlay.left)
          : outer.right;
      const room = {
        x: outer.left + 8,
        y: outer.top + 8,
        w: Math.max(1, right - outer.left - 16),
        h: Math.max(1, outer.height - 16),
      };
      const topics = [...el.querySelectorAll<HTMLElement>(".react-flow__node-node")].filter((n) => {
        const r = n.getBoundingClientRect();
        return (
          r.right > outer.left &&
          r.left < outer.right &&
          r.bottom > outer.top &&
          r.top < outer.bottom &&
          getComputedStyle(n).visibility !== "hidden"
        );
      });
      const protectedRects = topics
        .filter((n) => currentIds.current.includes(n.dataset.id!))
        .map((n) => rect(n.getBoundingClientRect()));
      const occupied = topics.map((n) => rect(n.getBoundingClientRect()));
      for (const panel of el.querySelectorAll<HTMLElement>(SELECTOR)) {
        panel.style.maxWidth = `${room.w}px`;
        const measured = [panel, ...panel.querySelectorAll<HTMLElement>(".react-pop")].map((p) =>
          p.getBoundingClientRect(),
        );
        const left = Math.min(...measured.map((r) => r.left)),
          top = Math.min(...measured.map((r) => r.top));
        const right = Math.max(...measured.map((r) => r.right)),
          bottom = Math.max(...measured.map((r) => r.bottom));
        const r = { left, top, width: right - left, height: bottom - top };
        if (!r.width || !r.height) continue;
        const old = offsets.get(panel) ?? { x: 0, y: 0 };
        const preferred = { x: r.left - old.x, y: r.top - old.y, w: r.width, h: r.height };
        const protect =
          point && !panel.contains(point.target)
            ? [...protectedRects, { x: point.x - 12, y: point.y - 12, w: 24, h: 24 }]
            : protectedRects;
        const best = floatingPosition(room, preferred, protect, occupied);
        const next = { x: best.x - preferred.x, y: best.y - preferred.y };
        if (next.x !== old.x || next.y !== old.y) {
          panel.style.translate = `${next.x}px ${next.y}px`;
          offsets.set(panel, next);
        }
        occupied.push(best);
      }
    };
    position.current = place;
    const schedule = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          place();
        });
    };
    const move = (e: PointerEvent) => {
      point = { x: e.clientX, y: e.clientY, target: e.target as Element };
      const source = (e.target as Element).closest<HTMLElement>("[data-tip]");
      if (source !== tipSource) {
        tip?.remove();
        tip = null;
        tipSource = source;
        if (source?.dataset.tip && !document.body.classList.contains("is-dragging")) {
          const outer = el.getBoundingClientRect(),
            r = source.getBoundingClientRect();
          tip = document.createElement("div");
          tip.className = "map-tip";
          tip.setAttribute("role", "tooltip");
          tip.textContent =
            source.dataset.tip + (source.dataset.key ? ` · ${source.dataset.key}` : "");
          tip.style.left = `${r.left - outer.left}px`;
          tip.style.top = `${r.bottom - outer.top + 8}px`;
          el.append(tip);
          place();
        }
      }
      schedule();
    };
    const leave = () => {
      point = null;
      tip?.remove();
      tip = null;
      tipSource = null;
      schedule();
    };
    el.addEventListener("pointerover", move);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    const detail = el.closest(".surface")?.querySelector<HTMLElement>(".detail");
    if (detail) resize.observe(detail);
    const observePanels = () => {
      const detail = el.closest(".surface")?.querySelector<HTMLElement>(".detail");
      if (detail) resize.observe(detail);
      el.querySelectorAll<HTMLElement>(SELECTOR).forEach((p) => {
        resize.observe(p);
        p.querySelectorAll<HTMLElement>(".react-pop").forEach((pop) => resize.observe(pop));
      });
      schedule();
    };
    const children = new MutationObserver(observePanels);
    children.observe(el, { childList: true, subtree: true });
    const surface = el.closest(".surface");
    if (surface) children.observe(surface, { childList: true });
    const viewport = el.querySelector(".react-flow__viewport");
    const transform = new MutationObserver(schedule);
    if (viewport) transform.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    observePanels();
    place();
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerover", move);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      resize.disconnect();
      children.disconnect();
      transform.disconnect();
      tip?.remove();
    };
  }, [root]);
  useLayoutEffect(() => position.current());
}
