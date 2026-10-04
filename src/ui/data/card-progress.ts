import type { SnapshotCard } from "./types.js";
import { t } from "../i18n.js";

/** Presentation of Core's progress; Cards without goal sources show reception only. */
export function cardProgressLabel(card: SnapshotCard): string {
  if (card.progress === null) return t.cardReception[card.state];
  const label =
    card.progress === "received-no-output" && card.goalCount > 0
      ? t.cardProgress.partial
      : t.cardProgress[card.progress];
  return card.totalGoalCount > 1 ? `${label} · ${card.goalCount}/${card.totalGoalCount}` : label;
}
