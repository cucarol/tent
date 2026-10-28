// Small pieces of the map's pointer handling, kept apart so they can be checked without a browser.

type Rect = { x: number; y: number; w: number; h: number };

/** A clear rectangle that fits the requested outline best, with the most room at the same scale. */
export function clearRect(room: Rect, covered: readonly Rect[], outline: { w: number; h: number }) {
  const right = room.x + room.w,
    bottom = room.y + room.h;
  const blocks = covered
    .map((r) => ({
      x: Math.max(room.x, r.x),
      y: Math.max(room.y, r.y),
      w: Math.min(right, r.x + r.w) - Math.max(room.x, r.x),
      h: Math.min(bottom, r.y + r.h) - Math.max(room.y, r.y),
    }))
    .filter((r) => r.w > 0 && r.h > 0);
  if (!blocks.length) return room;
  const xs = [...new Set([room.x, right, ...blocks.flatMap((r) => [r.x, r.x + r.w])])].sort(
    (a, b) => a - b,
  );
  let best = { ...room, w: 0, h: 0 };
  let scale = -1,
    area = -1;
  const offer = (x: number, y: number, w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    const fits = Math.min(1, w / Math.max(1, outline.w), h / Math.max(1, outline.h));
    if (fits > scale || (fits === scale && w * h > area)) {
      best = { x, y, w, h };
      scale = fits;
      area = w * h;
    }
  };
  for (let left = 0; left < xs.length - 1; left++) {
    for (let end = left + 1; end < xs.length; end++) {
      const x = xs[left]!,
        w = xs[end]! - x;
      const vertical = blocks.filter((r) => r.x < x + w && r.x + r.w > x).sort((a, b) => a.y - b.y);
      let y = room.y;
      for (const r of vertical) {
        offer(x, y, w, r.y - y);
        y = Math.max(y, r.y + r.h);
      }
      offer(x, y, w, bottom - y);
    }
  }
  return best;
}

/** The zoom that fits a box of `w` by `h` into `room`, held between `min` and the lower of `max` and 1. */
export function fitZoom(
  w: number,
  h: number,
  room: { w: number; h: number },
  max: number,
  min: number,
) {
  // Never past 100%, whatever a caller asks: closer in shows nothing more.
  return Math.min(max, 1, Math.max(min, Math.min(room.w / w, room.h / h)));
}

/** Centre the painted bounds, which need not be symmetric about the map's origin. */
export function fitViewport(
  bounds: { x: number; y: number; w: number; h: number },
  room: { x: number; y: number; w: number; h: number },
  max: number,
  min: number,
) {
  const zoom = fitZoom(bounds.w, bounds.h, room, max, min);
  return {
    x: room.x + room.w / 2 - (bounds.x + bounds.w / 2) * zoom,
    y: room.y + room.h / 2 - (bounds.y + bounds.h / 2) * zoom,
    zoom,
  };
}

/** The wheel moves the map; with Ctrl or Cmd, or as a pinch, it zooms about the pointer. */
export function wheelViewport(
  view: { x: number; y: number; zoom: number },
  at: { x: number; y: number },
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "shiftKey">,
  limits: { min: number; max: number },
) {
  // As in Excalidraw and Canva: the wheel and two fingers move the map, Shift turns the wheel sideways,
  // and Ctrl or Cmd with the wheel zooms, which is also what a trackpad pinch sends.
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const dx = event.deltaX * unit,
    dy = event.deltaY * unit;
  if (!event.ctrlKey && !event.metaKey) {
    if (event.shiftKey && dx === 0) return { ...view, x: view.x - dy };
    return { ...view, x: view.x - dx, y: view.y - dy };
  }
  // A wheel notch (about 100px, or lines) is one 10% step; a pinch sends small steps and follows the
  // fingers. No single event moves more than one step and a half, whatever the device reports.
  const notch =
    event.deltaMode !== 0 || (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50);
  const one = Math.log(1.1);
  const step = notch
    ? Math.sign(-dy) * one * Math.min(1.5, Math.max(1, Math.abs(dy) / 100))
    : Math.max(-1.5 * one, Math.min(1.5 * one, -dy * 0.01));
  const zoom = Math.max(limits.min, Math.min(limits.max, view.zoom * Math.exp(step)));
  const ratio = zoom / view.zoom;
  return { x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio, zoom };
}
/** Prefer an empty side of protected objects; crowded views fall back to a screen edge. */
export function floatingPosition(
  room: Rect,
  preferred: Rect,
  protectedRects: readonly Rect[],
  occupied: readonly Rect[] = [],
) {
  const area = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const clamp = (x: number, y: number) => ({
    x: Math.max(room.x, Math.min(x, room.x + room.w - preferred.w)),
    y: Math.max(room.y, Math.min(y, room.y + room.h - preferred.h)),
    w: preferred.w,
    h: preferred.h,
  });
  const right = room.x + room.w - preferred.w,
    bottom = room.y + room.h - preferred.h;
  const candidates = [
    clamp(preferred.x, preferred.y),
    clamp(room.x, preferred.y),
    clamp(right, preferred.y),
    clamp(preferred.x, room.y),
    clamp(preferred.x, bottom),
    clamp(room.x, room.y),
    clamp(right, room.y),
    clamp(room.x, bottom),
    clamp(right, bottom),
    ...protectedRects.flatMap((r) => [
      clamp(r.x - preferred.w - 8, preferred.y),
      clamp(r.x + r.w + 8, preferred.y),
      clamp(preferred.x, r.y - preferred.h - 8),
      clamp(preferred.x, r.y + r.h + 8),
    ]),
  ];
  const safe = candidates.filter((r) => protectedRects.every((p) => !area(r, p)));
  const edge = candidates.filter(
    (r) => r.x === room.x || r.x === right || r.y === room.y || r.y === bottom,
  );
  const cost = (r: Rect) => occupied.reduce((n, p) => n + area(r, p), 0);
  const protectedCost = (r: Rect) => protectedRects.reduce((n, p) => n + area(r, p), 0);
  return (
    (safe.length ? safe : edge).sort(
      (a, b) =>
        (safe.length ? 0 : protectedCost(a) - protectedCost(b)) ||
        cost(a) - cost(b) ||
        Math.hypot(a.x - preferred.x, a.y - preferred.y) -
          Math.hypot(b.x - preferred.x, b.y - preferred.y),
    )[0] ?? clamp(room.x, room.y)
  );
}

/** Expose a selected topic with the smallest safe pan; opening a popup never changes the zoom. */
export function uncoverViewport(
  view: { x: number; y: number; zoom: number },
  topic: Rect,
  room: Rect,
  covered: readonly Rect[],
) {
  const painted = {
    x: topic.x * view.zoom + view.x,
    y: topic.y * view.zoom + view.y,
    w: topic.w * view.zoom,
    h: topic.h * view.zoom,
  };
  const next = floatingPosition(room, painted, covered);
  return { ...view, x: view.x + next.x - painted.x, y: view.y + next.y - painted.y };
}
