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

/**
 * The public area's face: an inbox tray with Cards lying in it, drawn on the robot's grid with one accent
 * slot, so it sits in a column of robots. Cards here wait for a Role to take them. Below 20px one Card is drawn;
 * an empty tray holds none.
 */
export function Tray({
  size = 28,
  className,
  empty = false,
}: {
  size?: number;
  className?: string;
  empty?: boolean;
}) {
  const full = size >= 20;
  return (
    <svg
      className={`pet is-tray${full ? "" : " is-compact"}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox={full ? "0 0 64 64" : "4 10 56 48"}
      aria-hidden="true"
    >
      {!empty && full && (
        <rect
          className="p-paper"
          x="17"
          y="12"
          width="30"
          height="20"
          rx="3"
          transform="rotate(-8 32 22)"
        />
      )}
      {!empty && (
        <rect
          className="p-paper"
          x="17"
          y="17"
          width="30"
          height="20"
          rx="3"
          transform="rotate(5 32 27)"
        />
      )}
      <path className="p-tray" d="M8 34h14l4 7h12l4-7h14v12a8 8 0 0 1-8 8H16a8 8 0 0 1-8-8z" />
      <path className="p-accent" d="M28 41h8v2.6h-8z" />
    </svg>
  );
}

/**
 * The face of all sessions: the AGENTS.md sheet every one of them reads first, drawn on the robot's grid in the
 * tray's colours so it sits in the same column. It has no moods and takes no Cards.
 */
export function Sheet({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`pet is-sheet${size >= 20 ? "" : " is-compact"}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <path
        className="p-paper"
        d="M19 8h18l12 12v30a6 6 0 0 1-6 6H19a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6z"
      />
      <path className="p-fold" d="M37 8v8a4 4 0 0 0 4 4h8" />
      <rect className="p-tray" x="20" y="29" width="20" height="4" rx="2" />
      <rect className="p-tray" x="20" y="37" width="24" height="4" rx="2" />
      <rect className="p-tray" x="20" y="45" width="14" height="4" rx="2" />
    </svg>
  );
}

/**
 * What a robot is up to, drawn around its face and never on it. doing: a line of light passes down the screen
 * and the antenna glows on and off; waiting: a sealed letter is held up beside it; gone (a deleted Role): grey,
 * no antenna, a `—` on the screen; off (tent ui cannot be reached): a `—` and an unplugged cord; loading: `…`.
 * Only the full drawing carries a mood; below 20px only gone shows, as grey.
 */
export type Mood = "doing" | "waiting" | "gone" | "off" | "loading";

/** A Role's avatar. */
export function Pet({
  id,
  size = 28,
  className,
  mood,
}: {
  id: string;
  size?: number;
  className?: string;
  mood?: Mood;
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
  const shown = full ? mood : mood === "gone" ? mood : undefined;
  // The screen shows a sign instead of the face only when nobody is behind it.
  const sign = shown === "gone" || shown === "off" ? "rest" : shown === "loading" ? "dots" : null;
  return (
    <svg
      className={`pet${full ? "" : " is-compact"}${shown ? ` is-${shown}` : ""}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox={full ? "0 0 64 64" : "9 13 46 46"}
      aria-hidden="true"
      style={{ "--h": t.hue } as CSSProperties}
    >
      {full && (
        <>
          {shown !== "gone" && <Antenna kind={t.antenna} />}
          <rect className="p-dark" x="7" y="27" width="5" height="12" rx="2" />
          <rect className="p-dark" x="52" y="27" width="5" height="12" rx="2" />
        </>
      )}
      <rect className="p-head" x="10" y="14" width="44" height="40" rx="13" />
      <rect className="p-screen" x="15" y="20" width="34" height="26" rx="9" />
      {sign === "rest" ? (
        <path className="p-glow-line p-sign" d="M26 33h12" strokeWidth="2.8" />
      ) : sign === "dots" ? (
        <g className="p-glow p-dots">
          <circle cx="24" cy="33" r="3" />
          <circle cx="32" cy="33" r="3" />
          <circle cx="40" cy="33" r="3" />
        </g>
      ) : (
        <>
          <g className="p-glow">
            <Eyes kind={t.eyes} y={eyeY} />
          </g>
          {t.mouth && <path className="p-glow-line" d="M28 40q4 3 8 0" strokeWidth="2.3" />}
        </>
      )}
      {shown === "doing" && (
        <rect className="p-scan" x="19" y="21" width="26" height="3" rx="1.5" />
      )}
      {shown === "waiting" && (
        <g className="p-letter">
          <rect x="40" y="42" width="22" height="16" rx="4" />
          <path d="m41.8 45 9.2 5.6 9.2-5.6" />
          <circle className="p-accent" cx="51" cy="51.4" r="1.9" />
        </g>
      )}
      {shown === "off" && (
        <g className="p-cord">
          <path d="M57 36c5 4 5 12-1 16" />
          <rect x="52" y="50" width="7" height="6" rx="1.5" />
        </g>
      )}
    </svg>
  );
}
