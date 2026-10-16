import type { SnapshotCard } from "./types.js";
import { t } from "../i18n.js";

/**
 * Where a Card stands, from its delivery state alone: waiting to be received; received, which finishes it when
 * nobody waits for a result; being done, when it is to be returned; returned with a result; and that result
 * collected. Goals and outputs say nothing about a Card being done.
 */
export type CardStage = "pending" | "received" | "doing" | "returned" | "closed";

export function cardStage(card: Pick<SnapshotCard, "state" | "returnTo">): CardStage {
  if (card.state === "consumed") return card.returnTo ? "doing" : "received";
  return card.state;
}

export const cardStateLabel = (card: Pick<SnapshotCard, "state" | "returnTo">) =>
  t.cardState[cardStage(card)];

type ResultPart = { text: string } | { nodeId: string };

/** A returned result as its text and the Node ids in it, which the page shows as links. */
export function resultParts(result: string): ResultPart[] {
  const out: ResultPart[] = [];
  let at = 0;
  for (const m of result.matchAll(/\bnode-[a-z0-9]+\b/gi)) {
    if (m.index! > at) out.push({ text: result.slice(at, m.index) });
    out.push({ nodeId: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < result.length) out.push({ text: result.slice(at) });
  return out;
}

export const resultNodeIds = (result: string | undefined) =>
  result ? [...new Set(resultParts(result).flatMap((p) => ("nodeId" in p ? [p.nodeId] : [])))] : [];
