import { useSyncExternalStore, type CSSProperties } from "react";
import { readStored, writeStored } from "../util.js";

/**
 * Role avatars: a small robot whose dark screen face shows eyes glowing in the Role's colour. A Role id always
 * draws the same colour, eyes, antenna and mouth, so the avatar is a stable handle for that Role. Clicking the
 * avatar on the Role page turns to another draw; turns are a display preference kept in this browser, not Role
 * data. Colours come from CSS (`.pet` in styles.css) so one drawing serves light and dark. Below 20px only the
 * head is drawn: antennas and ears would blur into the tile.
 */

/** Soft hues, away from the accent orange. Drawn second, as for the earlier pets, so Roles keep their colour. */
const HUES = [150, 172, 195, 215, 235, 258, 280, 305, 330, 350, 48, 90];
const EYES = ["dots", "bars", "arcs", "pixels", "visor", "carets"] as const;
const ANTENNAS = ["ball", "double", "bent", "bolts", "dish"] as const;
type Traits = {
  hue: number;
  eyes: (typeof EYES)[number];
  antenna: (typeof ANTENNAS)[number];
  mouth: boolean;
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
  // The first draw chose the earlier pets' shape; skipping it keeps each Role's hue.
  r();
  return { hue: pick(HUES), eyes: pick(EYES), antenna: pick(ANTENNAS), mouth: r() < 0.55 };
}

/** Eyes on the screen, centred at (32, y) on the 64-unit drawing. */
function Eyes({ kind, y }: { kind: Traits["eyes"]; y: number }) {
  switch (kind) {
    case "dots":
      return (
        <>
          <circle cx="25" cy={y} r="3.8" />
          <circle cx="39" cy={y} r="3.8" />
        </>
      );
    case "bars":
      return (
        <>
          <rect x="23" y={y - 5} width="4.2" height="10" rx="2.1" />
          <rect x="36.8" y={y - 5} width="4.2" height="10" rx="2.1" />
        </>
      );
    case "pixels":
      return (
        <>
          <rect x="21.5" y={y - 3.5} width="7" height="7" rx="1.2" />
          <rect x="35.5" y={y - 3.5} width="7" height="7" rx="1.2" />
        </>
      );
    case "visor":
      return <rect x="20" y={y - 3} width="24" height="6" rx="3" />;
    case "arcs":
      return (
        <path
          className="p-glow-line"
          d={`M21 ${y + 2}q4 -6 8 0M35 ${y + 2}q4 -6 8 0`}
          strokeWidth="3"
        />
      );
    case "carets":
      return (
        <path
          className="p-glow-line"
          d={`M22 ${y - 3}l4 3l-4 3M42 ${y - 3}l-4 3l4 3`}
          strokeWidth="2.8"
        />
      );
  }
}

/** Antennas and ears sit outside the head, so only the full drawing has them. */
function Antenna({ kind }: { kind: Traits["antenna"] }) {
  switch (kind) {
    case "ball":
      return (
        <>
          <path className="p-wire" d="M32 15v-7" />
          <circle className="p-accent" cx="32" cy="6.5" r="3.8" />
        </>
      );
    case "double":
      return (
        <>
          <path className="p-wire" d="M24 15l-3 -8M40 15l3 -8" />
          <circle className="p-glow" cx="20.5" cy="6" r="2.8" />
          <circle className="p-glow" cx="43.5" cy="6" r="2.8" />
        </>
      );
    case "bent":
      return (
        <>
          <path className="p-wire" d="M34 15v-5l6 -4" />
          <circle className="p-accent" cx="41.5" cy="5" r="3.2" />
        </>
      );
    case "dish":
      return (
        <>
          <path className="p-wire" d="M32 15v-5" />
          <path className="p-dark" d="M24 9a8 5 0 0 0 16 0Z" />
        </>
      );
    case "bolts":
      return (
        <>
          <rect className="p-accent" x="3" y="30" width="5" height="6" rx="1.5" />
          <rect className="p-accent" x="56" y="30" width="5" height="6" rx="1.5" />
        </>
      );
  }
}

const traitsOf = new Map<string, Traits>();

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
  const turn = useSyncExternalStore(
    subscribe,
    () => turns[id] ?? 0,
    () => 0,
  );
  const seed = turn ? `${id}#${turn}` : id;
  let t = traitsOf.get(seed);
  if (!t) traitsOf.set(seed, (t = petTraits(seed)));
  const full = size >= 20;
  const eyeY = t.mouth ? 31 : 33;
  return (
    <svg
      className={`pet${full ? "" : " is-compact"}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox={full ? "0 0 64 64" : "9 13 46 46"}
      aria-hidden="true"
      style={{ "--h": t.hue } as CSSProperties}
    >
      {full && (
        <>
          <Antenna kind={t.antenna} />
          <rect className="p-dark" x="7" y="27" width="5" height="12" rx="2" />
          <rect className="p-dark" x="52" y="27" width="5" height="12" rx="2" />
        </>
      )}
      <rect className="p-head" x="10" y="14" width="44" height="40" rx="13" />
      <rect className="p-screen" x="15" y="20" width="34" height="26" rx="9" />
      <g className="p-glow">
        <Eyes kind={t.eyes} y={eyeY} />
      </g>
      {t.mouth && <path className="p-glow-line" d="M28 40q4 3 8 0" strokeWidth="2.3" />}
    </svg>
  );
}
