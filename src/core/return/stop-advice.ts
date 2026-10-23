import type { StopMaterialIndex } from "./stop-material-index.js";
import type { SessionObservationEvent } from "./session-observations.js";
import { formatStopTurnReview, modulesForIndexedTurn } from "./stop-turn-review.js";

export type StopQuestion = {
  kind: "possible-intent";
  question: string;
  answers: string[];
};

/** Intent questions use only the current turn's explicit signals. */
export function questionsForIndexedTurn(
  index: StopMaterialIndex,
  event: SessionObservationEvent,
): StopQuestion[] {
  if (event.cancelled || !event.signals.length || event.nodeOrCardChanged) return [];
  const goal = modulesForIndexedTurn(index, event).find((module) =>
    index.nodes.some((node) => node.nodeId === module.nodeId && node.type === "goal"),
  );
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
  textByteLimit: number,
): string | undefined {
  return formatStopTurnReview(
    textByteLimit,
    modulesForIndexedTurn(index, event),
    questionsForIndexedTurn(index, event),
  );
}
