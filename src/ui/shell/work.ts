// 分工: which lane each Card sits in, the draft being written, and what dragging and the buttons do with them.
import type { Mood } from "../components/Pet.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cardTitle, type Graph } from "../data/store.js";
import type { SnapshotCard } from "../data/types.js";
import { cardStage, resultParts } from "../data/card-state.js";
import {
  createDraft,
  discardDraft,
  editDraft,
  isDraft,
  moveCard,
  publishDraft,
  setDraftReturn,
  useDraft,
  type Draft,
} from "../data/drafts.js";
import { ApiError, describe } from "../data/api.js";
import { setDropHandler, type Dragged } from "./drag.js";
import { readStored, writeStored } from "../util.js";
import { t } from "../i18n.js";

/** The lanes: "" is the public area, then one per Role. */
export const PUBLIC = "";

export type Work = ReturnType<typeof useWork>;

/** What a robot has in hand: Cards it is doing, Cards waiting for it, results returned to it, drafts. */
export type Desk = { doing: number; waiting: number; returned: number; drafts: number };

/**
 * A robot is doing while it holds a Card to return, waiting when only Cards to take or results to collect
 * are left.
 */
export function moodOf(desk: Desk, gone: boolean): Mood | undefined {
  if (gone) return "gone";
  if (desk.doing > 0) return "doing";
  if (desk.waiting > 0 || desk.returned > 0) return "waiting";
  return undefined;
}

/**
 * The lane whose desk holds a Card: pending Cards wait in their lane, Cards being done sit with their
 * receiver, and returned ones wait for the Role they return to. Null once it is off every desk: received
 * without a return, collected, or withdrawn.
 */
export function deskOf(card: SnapshotCard, laneOf: (card: SnapshotCard) => string) {
  if (card.status === "deprecated") return null;
  const stage = cardStage(card);
  if (stage === "pending") return laneOf(card);
  if (stage === "doing") return card.receivedBy;
  if (stage === "returned") return card.returnTo ?? null;
  return null;
}

/** A draft's sources as the Nodes and Roles they name, in order; addresses outside Tent are null. */
export function sourceIds(graph: Graph, card: SnapshotCard | undefined, draft: Draft | null) {
  if (draft) return draft.input.sources.map((s) => graph.refOf(s.resource)?.id ?? null);
  return card?.sources.map((s) => s.id ?? null) ?? [];
}

/** The Nodes and Roles the Cards on a lane's desk carry, drafts included. */
export function carried(graph: Graph, laneOf: (card: SnapshotCard) => string, lane: string) {
  const ids = new Set<string>();
  for (const c of graph.snapshot.cards)
    if (deskOf(c, laneOf) === lane) for (const s of c.sources) if (s.id) ids.add(s.id);
  return ids;
}

/** A draft's title is its first line until it is published. */
export function draftTitle(card: SnapshotCard | undefined, draft: Draft | null) {
  const text = draft ? draft.input.prompt : (card?.body ?? "");
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return line ?? t.work.untitled;
}

export function useWork(graph: Graph | null, toast: (text: string) => void) {
  const [openDraft, setOpenDraftState] = useState<string | null>(null);
  const workspaceId = graph?.snapshot.workspace.id;
  const openKey = `tent-open-draft:${workspaceId}`;
  useEffect(() => {
    if (workspaceId) setOpenDraftState(readStored<string | null>(openKey, null));
  }, [workspaceId]);
  // Moves shown before the workspace catches up with them.
  const [moved, setMoved] = useState<ReadonlyMap<string, string>>(new Map());
  // The lane a Card was last put in, so the sidebar can open it.
  const [publishing, setPublishing] = useState<string | null>(null);
  const [landed, setLanded] = useState<{ lane: string; at: number } | null>(null);
  const draft = useDraft(openDraft);
  const setOpenDraft = useCallback(
    (id: string | null) => {
      setOpenDraftState(id);
      writeStored(openKey, id);
    },
    [openKey],
  );

  useEffect(() => {
    if (!graph) return;
    setMoved((m) =>
      m.size
        ? new Map([...m].filter(([id, at]) => (graph.cards.get(id)?.target ?? PUBLIC) !== at))
        : m,
    );
    if (openDraft && !graph.cards.has(openDraft)) setOpenDraft(null);
  }, [graph]);

  const laneOf = useCallback(
    (card: SnapshotCard) => card.receivedBy ?? moved.get(card.id) ?? card.target ?? PUBLIC,
    [moved],
  );
  /** Cards still moving between lanes (withdrawn ones are done with): drafts first, then the newest published ones. */
  const laneCards = useCallback(
    (lane: string) => {
      if (!graph) return [];
      const cards = graph.snapshot.cards;
      const here = cards.filter(
        (c) =>
          c.state === "pending" && !c.receivedBy && c.status !== "deprecated" && laneOf(c) === lane,
      );
      // The draft being written leads, so it stays put when the workspace catches up.
      return [
        ...here.filter((c) => c.id === openDraft),
        ...here.filter((c) => isDraft(c) && c.id !== openDraft),
        ...here
          .filter((c) => !isDraft(c))
          .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")),
      ];
    },
    [graph, laneOf, openDraft],
  );
  /** Results returned to a lane's Role and not collected yet, newest first. */
  const laneReturned = useCallback(
    (lane: string) =>
      (graph?.snapshot.cards ?? [])
        .filter((c) => c.status !== "deprecated" && c.state === "returned" && c.returnTo === lane)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    [graph],
  );
  const desk = useCallback(
    (lane: string): Desk => {
      const here = laneCards(lane);
      const drafts = here.filter(isDraft).length;
      const doing = (graph?.snapshot.cards ?? []).filter(
        (c) => c.status !== "deprecated" && c.receivedBy === lane && cardStage(c) === "doing",
      ).length;
      return { doing, waiting: here.length - drafts, returned: laneReturned(lane).length, drafts };
    },
    [graph, laneCards, laneReturned],
  );
  // A Role deleted since keeps its id on the Cards it received, marked as gone.
  const laneName = (lane: string) =>
    lane === PUBLIC
      ? t.work.public
      : (graph?.roles.get(lane)?.title ?? (graph ? t.work.goneRole(lane) : lane));
  const resourceOf = (nodeId: string) => `/${graph!.nodes.get(nodeId)!.notePath}`;
  /** Roles a draft's result can come back to: available ones other than the lane it is going to. */
  const returnChoices = (card: SnapshotCard) =>
    (graph?.snapshot.roles ?? []).filter((r) => r.status !== "deprecated" && r.id !== laneOf(card));

  const newCard = async (target: string | null, nodeIds: string[] = []) => {
    try {
      const id = await createDraft(
        target,
        nodeIds.map((n) => ({ resource: resourceOf(n) })),
      );
      setOpenDraft(id);
      toast(target ? t.work.createdFor(laneName(target)) : t.work.created);
      return id;
    } catch (error) {
      toast(describe(error));
      return null;
    }
  };

  /** Add a Node as the draft's next source, or take it out if it is already there. */
  const toggleSource = (draftId: string, nodeId: string, keep = false) => {
    if (publishing === draftId) return;
    const resource = resourceOf(nodeId);
    let note = "";
    editDraft(draftId, (input) => {
      const at = input.sources.findIndex((s) => graph!.refOf(s.resource)?.id === nodeId);
      if (at >= 0 && keep) {
        note = t.work.alreadyIn(at + 1);
        return input;
      }
      if (at >= 0) {
        note = t.work.takenOut(graph!.nodes.get(nodeId)!.name);
        return { ...input, sources: input.sources.filter((_, i) => i !== at) };
      }
      note = t.work.added(graph!.nodes.get(nodeId)!.name, input.sources.length + 1);
      return { ...input, sources: [...input.sources, { resource }] };
    });
    if (note) toast(note);
  };

  /** "放进 Card": into the draft being written, or a new draft in the public area. */
  const attach = (nodeId: string) => {
    if (openDraft && draft) toggleSource(openDraft, nodeId);
    else void newCard(null, [nodeId]);
  };

  const move = async (cardId: string, lane: string) => {
    if (publishing === cardId) return;
    const card = graph?.cards.get(cardId);
    if (!card || laneOf(card) === lane) return;
    if (card.state !== "pending" || card.receivedBy) {
      toast(t.work.fixed);
      return;
    }
    // A published Card cannot go to the Role it returns to; a draft drops the return instead.
    if (card.returnTo === lane && !isDraft(card)) {
      toast(t.work.notToReturner(laneName(lane)));
      return;
    }
    const dropsReturn = card.returnTo === lane;
    setMoved((m) => new Map([...m, [cardId, lane]]));
    setLanded({ lane, at: Date.now() });
    try {
      await moveCard(card, lane === PUBLIC ? null : lane);
      toast(
        lane === PUBLIC
          ? t.work.movedPublic(title(card))
          : dropsReturn
            ? t.work.returnDropped(laneName(lane))
            : t.work.movedTo(title(card), laneName(lane)),
      );
    } catch (error) {
      setMoved((m) => new Map([...m].filter(([id]) => id !== cardId)));
      // A Role received it while the page still showed it waiting.
      toast(
        error instanceof ApiError && error.code === "RECEPTION_CONFLICT"
          ? t.work.receivedMeanwhile
          : describe(error),
      );
    }
  };
  const title = (card: SnapshotCard) =>
    isDraft(card) ? draftTitle(card, card.id === openDraft ? draft : null) : cardTitle(card);

  const publish = async (id: string) => {
    const card = graph?.cards.get(id);
    if (publishing) return;
    setPublishing(id);
    try {
      await publishDraft(id);
      if (openDraft === id) setOpenDraft(null);
      toast(t.work.published(laneName(card ? laneOf(card) : PUBLIC)));
    } catch (error) {
      toast(describe(error));
    } finally {
      setPublishing(null);
    }
  };
  const discard = async (id: string) => {
    if (publishing === id) return;
    try {
      await discardDraft(id);
      if (openDraft === id) setOpenDraft(null);
      toast(t.work.discarded);
    } catch (error) {
      toast(describe(error));
    }
  };

  // An archived Role takes no new Cards; its lane stays only while a Card or a result still waits there.
  const lanes = useMemo(
    () =>
      graph
        ? [
            PUBLIC,
            ...graph.snapshot.roles
              .filter(
                (r) =>
                  r.status !== "deprecated" ||
                  graph.snapshot.cards.some(
                    (c) =>
                      c.status !== "deprecated" &&
                      ((c.target === r.id && c.state === "pending") ||
                        (c.returnTo === r.id && c.state === "returned")),
                  ),
              )
              .map((r) => r.id),
          ]
        : [PUBLIC],
    [graph],
  );

  // Dropping: what each target takes, and what happens.
  setDropHandler({
    accepts: (item: Dragged, target: string) => {
      if (!graph || (item.kind === "card" && publishing === item.id)) return false;
      const [kind, id = ""] = target.split(/:(.*)/s);
      if (kind === "lane") {
        if (!lanes.includes(id)) return false;
        if (item.kind === "node") return true;
        const card = graph.cards.get(item.id);
        return (
          !!card &&
          card.state === "pending" &&
          !card.receivedBy &&
          laneOf(card) !== id &&
          (isDraft(card) || card.returnTo !== id)
        );
      }
      if (kind === "card" && item.kind === "node") {
        if (publishing === id) return false;
        const card = graph.cards.get(id);
        return id === openDraft || (!!card && isDraft(card));
      }
      return false;
    },
    drop: (item: Dragged, target: string) => {
      const [kind, id = ""] = target.split(/:(.*)/s);
      if (kind === "lane" && item.kind === "node")
        void newCard(id === PUBLIC ? null : id, item.ids ?? [item.id]);
      else if (kind === "lane") void move(item.id, id);
      else if (kind === "card") {
        if (id !== openDraft) setOpenDraft(id);
        for (const nodeId of item.ids ?? [item.id]) toggleSource(id, nodeId, true);
      }
    },
  });
  return {
    card: (id: string) => graph?.cards.get(id),
    landed,
    publishing,
    openDraft,
    draft,
    setOpenDraft,
    lanes,
    laneOf,
    laneCards,
    laneReturned,
    desk,
    laneName,
    returnChoices,
    setReturn: setDraftReturn,
    /** A returned result with its Node ids read as the Nodes' names. */
    resultText: (result: string) =>
      resultParts(result)
        .map((p) => ("nodeId" in p ? (graph?.nodes.get(p.nodeId)?.name ?? p.nodeId) : p.text))
        .join(""),
    gone: (lane: string) => lane !== PUBLIC && !!graph && !graph.roles.has(lane),
    newCard,
    attach,
    toggleSource,
    move,
    publish,
    discard,
    title,
  };
}
