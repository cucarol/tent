import { useSyncExternalStore, type CSSProperties } from "react";
import { readStored, writeStored } from "../util.js";

/**
 * Role avatars: a soft shape peeking into a tile, with a face kept near the middle. A Role id always draws the
 * same shape, colour, eyes and mouth, so the avatar is a stable handle for that Role. Clicking the avatar on the
 * Role page turns to another draw; turns are a display preference kept in this browser, not Role data.
 * Colours come from CSS (`.pet` in styles.css) so one drawing serves light and dark.
 */

const SHAPES = ["circle", "squircle", "egg", "mochi", "blob"] as const;
/** Soft hues, away from the accent orange. Drawn second, as for the earlier pixel pets, so Roles keep their colour. */
const HUES = [150, 172, 195, 215, 235, 258, 280, 305, 330, 350, 48, 90];
const EYES = ["dot", "dot", "tall", "tall", "shine", "shine", "happy", "wink"] as const;
const MOUTHS = ["smile", "smile", "small", "cat", "open", "o", "none"] as const;
type Traits = {
  shape: (typeof SHAPES)[number];
  hue: number;
  eyes: (typeof EYES)[number];
  mouth: (typeof MOUTHS)[number];
  blush: boolean;
  /** -1…1: how far the body tilts and shifts in the tile. */
  tilt: number;
  dx: number;
  dy: number;
  wobble: number[];
};

/** FNV-1a spreads ids that share a prefix ("role-…"); mulberry32 then draws the traits in order. */
function random(seed: string) {
  let h = 0x811c9dc5;
  for (const ch of seed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function petTraits(seed: string): Traits {
  const r = random(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const signed = () => r() * 2 - 1;
  return {
    shape: pick(SHAPES),
    hue: pick(HUES),
    eyes: pick(EYES),
    mouth: pick(MOUTHS),
    blush: r() < 0.7,
    tilt: signed(),
    dx: signed(),
    dy: signed(),
    wobble: Array.from({ length: 6 }, r),
  };
}

const n = (v: number) => Math.round(v * 100) / 100;
/** A closed curve through four extreme points; k 0.55 is an ellipse, higher is squarer. kb sets the bottom half. */
function rounded(cx: number, cy: number, rx: number, ry: number, kt: number, kb = kt) {
  return (
    `M${n(cx)} ${n(cy - ry)}C${n(cx + kt * rx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - kt * ry)} ${n(cx + rx)} ${n(cy)}` +
    `C${n(cx + rx)} ${n(cy + kb * ry)} ${n(cx + kb * rx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)}` +
    `C${n(cx - kb * rx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + kb * ry)} ${n(cx - rx)} ${n(cy)}` +
    `C${n(cx - rx)} ${n(cy - kt * ry)} ${n(cx - kt * rx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)}Z`
  );
}
/** A soft blob through six points around the centre, joined as a closed Catmull-Rom curve. */
function blob(cx: number, cy: number, s: number, wobble: number[]) {
  const pts = wobble.map((w, i) => {
    const a = (i / wobble.length) * Math.PI * 2 - Math.PI / 2;
    return [
      cx + Math.cos(a) * s * (0.9 + 0.16 * w),
      cy + Math.sin(a) * s * (0.9 + 0.16 * w),
    ] as const;
  });
  const at = (i: number) => pts[(i + pts.length) % pts.length]!;
  let d = `M${n(pts[0]![0])} ${n(pts[0]![1])}`;
  for (let i = 0; i < pts.length; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`;
  }
  return `${d}Z`;
}
const ellipse = (cx: number, cy: number, rx: number, ry = rx) =>
  `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0z`;

/** Drawn on a 36-unit tile: the body is large and may run off the edge; the face stays near the middle. */
function draw(seed: string) {
  const t = petTraits(seed);
  const s = 15.5;
  const body =
    t.shape === "circle"
      ? rounded(18, 18, s, s, 0.5523)
      : t.shape === "squircle"
        ? rounded(18, 18, s * 0.95, s * 0.95, 0.84)
        : t.shape === "egg"
          ? rounded(18, 18, s * 0.9, s, 0.5, 0.74)
          : t.shape === "mochi"
            ? rounded(18, 18 + s * 0.12, s * 1.1, s * 0.84, 0.66, 0.78)
            : blob(18, 18, s, t.wobble);
  const [cx, fy] = [18, 17.5];
  const [ey, ex] = [fy - s * 0.08, s * 0.38];
  let fill = "";
  let line = "";
  let shine = "";
  const eye = (x: number, kind: (typeof EYES)[number]) => {
    if (kind === "dot") fill += ellipse(x, ey, s * 0.16);
    if (kind === "tall") fill += ellipse(x, ey, s * 0.13, s * 0.21);
    if (kind === "shine") {
      fill += ellipse(x, ey, s * 0.2);
      shine += ellipse(x + s * 0.07, ey - s * 0.07, s * 0.075);
    }
    if (kind === "happy") {
      const e = s * 0.17;
      line += `M${n(x - e)} ${n(ey + e * 0.45)}Q${n(x)} ${n(ey - e * 1.1)} ${n(x + e)} ${n(ey + e * 0.45)}`;
    }
  };
  eye(cx - ex, t.eyes === "wink" ? "dot" : t.eyes);
  eye(cx + ex, t.eyes === "wink" ? "happy" : t.eyes);
  const my = fy + s * 0.26;
  if (t.mouth === "smile" || t.mouth === "small") {
    const m = s * (t.mouth === "smile" ? 0.2 : 0.12);
    line += `M${n(cx - m)} ${n(my)}Q${n(cx)} ${n(my + m * 1.1)} ${n(cx + m)} ${n(my)}`;
  }
  if (t.mouth === "cat") {
    const m = s * 0.11;
    line += `M${n(cx - 2 * m)} ${n(my)}Q${n(cx - m)} ${n(my + m * 1.5)} ${n(cx)} ${n(my)}Q${n(cx + m)} ${n(my + m * 1.5)} ${n(cx + 2 * m)} ${n(my)}`;
  }
  if (t.mouth === "open") {
    const m = s * 0.17;
    fill += `M${n(cx - m)} ${n(my - m * 0.2)}L${n(cx + m)} ${n(my - m * 0.2)}Q${n(cx + m)} ${n(my + m * 1.2)} ${n(cx)} ${n(my + m * 1.2)}Q${n(cx - m)} ${n(my + m * 1.2)} ${n(cx - m)} ${n(my - m * 0.2)}Z`;
  }
  if (t.mouth === "o") fill += ellipse(cx, my + s * 0.04, s * 0.085, s * 0.105);
  const blush = t.blush
    ? ellipse(cx - s * 0.58, fy + s * 0.2, s * 0.17, s * 0.1) +
      ellipse(cx + s * 0.58, fy + s * 0.2, s * 0.17, s * 0.1)
    : "";
  return {
    hue: t.hue,
    body,
    bodyAt: `translate(${n(t.dx * 2.6)} ${n(1.5 + t.dy * 2.5)}) rotate(${n(t.tilt * 16)} 18 18)`,
    faceAt: `rotate(${n(t.tilt * 5)} 18 18)`,
    blush,
    fill,
    line,
    stroke: n(s * 0.12),
    shine,
  };
}

const drawn = new Map<string, ReturnType<typeof draw>>();

/** How many times each Role's avatar was turned in this browser; 0 is the Role's own draw. */
const TURNS = "tent-role-faces";
let turns = readStored<Record<string, number>>(TURNS, {});
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== TURNS) return;
    turns = readStored(TURNS, {});
    notify();
  });

/** Draws the next avatar for a Role, or with step -1 goes back to the previous one. */
export function turnPet(id: string, step = 1) {
  const next = { ...turns, [id]: (turns[id] ?? 0) + step };
  if (!next[id]) delete next[id];
  turns = next;
  writeStored(TURNS, turns);
  notify();
}

/** A Role's avatar. */
export function Pet({
  id,
  size = 28,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  const turn = useSyncExternalStore(subscribe, () => turns[id] ?? 0);
  const seed = turn ? `${id}#${turn}` : id;
  let pet = drawn.get(seed);
  if (!pet) drawn.set(seed, (pet = draw(seed)));
  return (
    <svg
      className={`pet${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 36 36"
      aria-hidden="true"
      style={{ "--h": pet.hue } as CSSProperties}
    >
      <rect className="p-bg" width="36" height="36" />
      <path className="p-b" d={pet.body} transform={pet.bodyAt} />
      <g transform={pet.faceAt}>
        {pet.blush && <path className="p-blush" d={pet.blush} />}
        {pet.fill && <path className="p-eye" d={pet.fill} />}
        {pet.line && <path className="p-line" d={pet.line} strokeWidth={pet.stroke} />}
        {pet.shine && <path className="p-shine" d={pet.shine} />}
      </g>
    </svg>
  );
}
