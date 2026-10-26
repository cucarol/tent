import type { Layout, Placed } from "./layout.js";
export type TopicPhase = "leave" | "move" | "enter";
export const TOPIC_PHASE_MS = { leave: 40, move: 100, enter: 40 } as const;
/** Only disappearing topics fade away. Survivors move before new topics appear. */
export function stagedTopics(from: Layout, to: Layout, phase: TopicPhase) {
  const out = new Map<
    string,
    { at: Placed; appearance: "shown" | "leaving" | "waiting" | "entering" }
  >();
  if (phase === "leave") {
    for (const [id, at] of from.placed)
      out.set(id, { at, appearance: to.placed.has(id) ? "shown" : "leaving" });
  } else {
    for (const [id, at] of to.placed)
      out.set(id, {
        at,
        appearance: from.placed.has(id) ? "shown" : phase === "move" ? "waiting" : "entering",
      });
  }
  return out;
}
