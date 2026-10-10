import type { StopMaterialIndex } from "./stop-material-index.js";
import type { SessionObservationEvent } from "./session-observations.js";
import { formatStopTurnReview, modulesForIndexedTurn, type StopHost } from "./stop-turn-review.js";

export type StopQuestion = {
  kind: "possible-intent";
  question: string;
  answers: string[];
};

/** Current-turn intent questions; unlinked writes belong to input-side brief. */
export function questionsForIndexedTurn(
  index: StopMaterialIndex,
  event: SessionObservationEvent,
): StopQuestion[] {
  if (event.cancelled || !event.signals.length || event.nodeOrCardChanged) return [];
  const goal = index.nodes.find((node) => node.type === "goal");
  return [
    {
      kind: "possible-intent",
      question: `Turn ${JSON.stringify(event.turnId)} reads like ${event.signals.includes("possible-decision") ? "a new decision or requirement" : "a new requirement"}.`,
      answers: [
        ...(goal ? [`Update existing ${goal.nodeId}`] : []),
        "Create a confirmed goal or prompt",
        "Discussion only; do not save",
      ],
    },
  ];
}

export function stopAdvice(
  index: StopMaterialIndex,
  event: SessionObservationEvent,
  host: StopHost = "codex",
): string | undefined {
  return formatStopTurnReview(
    host,
    modulesForIndexedTurn(index, event),
    questionsForIndexedTurn(index, event),
    event.uncertain,
  );
}
