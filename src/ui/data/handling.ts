import { createContext, useContext } from "react";
import { cardStage } from "./card-state.js";
import type { NodeCardSummary } from "../../core/read/node-details-types.js";
import type { SnapshotCard } from "./types.js";

/**
 * A Card someone is on for a Node: waiting in a lane to be taken, or taken and not yet returned. `lane` is
 * the Role it waits for or that holds it, or "" for the public area, as on the dock.
 */
export type Handling = {
  card: { id: string; title: string };
  lane: string;
  doing: boolean;
  /** The Role's name when it came with the Card, before the page has the Role list. */
  who?: string;
};

/**
 * Each Node and the Cards being handled for it: the dock's lanes read the other way round, from the Nodes
 * a Card carries back to the Card. Returned, received, closed and withdrawn Cards are left out.
 */
export function handlingOf(
  cards: readonly SnapshotCard[],
  laneOf: (card: SnapshotCard) => string,
  isNode: (id: string) => boolean,
): Map<string, Handling[]> {
  const out = new Map<string, Handling[]>();
  for (const card of cards) {
    if (card.status === "deprecated") continue;
    const stage = cardStage(card);
    if (stage !== "pending" && stage !== "doing") continue;
    const entry = { card, lane: laneOf(card), doing: stage === "doing" };
    for (const id of new Set(card.sources.map((s) => s.id)))
      if (id && isNode(id)) {
        const list = out.get(id);
        if (list) list.push(entry);
        else out.set(id, [entry]);
      }
  }
  // Cards being done come before Cards waiting, each kind in the order the Cards were listed.
  for (const list of out.values()) list.sort((a, b) => Number(b.doing) - Number(a.doing));
  return out;
}

/**
 * The same lines from the Cards a Node page reads for itself, before the page has the Card list: lanes as
 * the workspace has them, without moves made on this page and not yet written.
 */
export function handlingFromNodeCards(items: readonly NodeCardSummary[]): Handling[] {
  return items
    .flatMap((card) => {
      if (card.status === "deprecated") return [];
      const stage = cardStage(card);
      if (stage !== "pending" && stage !== "doing") return [];
      // "" is the public area.
      const lane = card.receivedBy ?? card.target ?? "";
      const who = lane === card.lane.id ? (card.lane.title ?? undefined) : undefined;
      return [{ card, lane, doing: stage === "doing", ...(who ? { who } : {}) }];
    })
    .sort((a, b) => Number(b.doing) - Number(a.doing));
}

/** The lanes on some Cards, once each: a lane holding any of them first, then lanes they wait in. */
export function handsOf(list: readonly Handling[]): { doing: string[]; waiting: string[] } {
  const doing = [...new Set(list.filter((h) => h.doing).map((h) => h.lane))];
  const waiting = [...new Set(list.filter((h) => !h.doing).map((h) => h.lane))].filter(
    (lane) => !doing.includes(lane),
  );
  return { doing, waiting };
}

/** Work belongs to the nearest named topic on screen; replay leaves future Nodes out altogether. */
export function handlingOnTopics(
  handling: ReadonlyMap<string, Handling[]>,
  upOf: (id: string) => string | null,
  named: (id: string) => boolean,
  exists: (id: string) => boolean,
): Map<string, Handling[]> {
  const out = new Map<string, Handling[]>();
  for (const [id, list] of handling) {
    if (!exists(id)) continue;
    let at: string | null = id;
    while (at && (!named(at) || !exists(at))) at = upOf(at);
    if (!at) continue;
    const held = out.get(at) ?? [];
    for (const h of list) if (!held.some((x) => x.card.id === h.card.id)) held.push(h);
    out.set(at, held);
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.doing) - Number(a.doing));
  return out;
}

/** The Cards being handled for each Node, as the dock sees them. */
export const HandlingContext = createContext<ReadonlyMap<string, Handling[]>>(new Map());
export const useHandling = () => useContext(HandlingContext);
