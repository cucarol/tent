import type { Graph } from "../data/store.js";
import { isDraft } from "../data/drafts.js";
import type { SnapshotRef } from "../data/types.js";
import type { Fold } from "./canvas.js";
import { selectionLines, type CodeEdge } from "./relations.js";

/** A reading excursion owns its folds and scope without writing them to the saved canvas. */
export type LensSession = {
  selectedId: string;
  viewport: { x: number; y: number; zoom: number };
  open: string[];
  shut: string[];
  focus: string | null;
  outputs: ReadonlySet<string>;
  previews: ReadonlySet<string>;
  anchor?: { id: string; at: [number, number] };
};

export function beginLens(state: LensSession): LensSession {
  return {
    ...state,
    viewport: { ...state.viewport },
    open: [...state.open],
    shut: [...state.shut],
    outputs: new Set(state.outputs),
    previews: new Set(state.previews),
    anchor: state.anchor ? { id: state.anchor.id, at: [...state.anchor.at] } : undefined,
  };
}

/** Leaving Node reading restores its entry selection; opening a Card/Role keeps that navigation. */
export function selectionAfterLens(
  session: LensSession,
  selected: SnapshotRef | null,
  available: (id: string) => boolean,
): SnapshotRef | null {
  if (selected?.kind !== "node") return selected;
  if (!available(session.selectedId)) return null;
  return selected.id === session.selectedId ? selected : { kind: "node", id: session.selectedId };
}

export function foldInLens(session: LensSession, folds: Record<string, Fold | null>): LensSession {
  const open = new Set(session.open),
    shut = new Set(session.shut);
  for (const [id, fold] of Object.entries(folds)) {
    open.delete(id);
    shut.delete(id);
    if (fold === "open") open.add(id);
    if (fold === "shut") shut.add(id);
  }
  return { ...session, open: [...open], shut: [...shut] };
}

/** A switched-off type stays switched off. A missing topic cannot be revealed. */
export function revealInLens(
  session: LensSession,
  graph: Graph,
  id: string,
  visible: (id: string) => boolean,
): LensSession {
  if (!graph.nodes.has(id) || !visible(id)) return session;
  const ancestors = graph.ancestors(id);
  const next = foldInLens(session, Object.fromEntries(ancestors.map((n) => [n.id, "open"])));
  return {
    ...next,
    focus:
      session.focus === id || ancestors.some((n) => n.id === session.focus) ? session.focus : null,
    // Result outputs are normally summed into their parent, independently of the tree folds.
    outputs: new Set([...session.outputs, ...ancestors.map((n) => n.id)]),
  };
}

/** Direct facts only. Outgoing references retain their direction beside the five ruled groups. */
export function lensFacts(graph: Graph, id: string) {
  const n = graph.nodes.get(id);
  const nodes = (ids: string[]) =>
    [...new Set(ids)].filter((other) => other !== id && graph.nodes.has(other));
  const groups = {
    parent: nodes(n?.parentId ? [n.parentId] : []),
    children: nodes(graph.childrenOf(id).map((child) => child.id)),
    incoming: nodes(
      n?.incoming.flatMap((i) =>
        i.from.kind === "node" && i.via !== "card-source" ? [i.from.id] : [],
      ) ?? [],
    ),
    outgoing: nodes([
      ...(n?.links.flatMap((l) => (l.ref?.kind === "node" ? [l.ref.id] : [])) ?? []),
      ...(n?.materials.flatMap((m) => (m.kind === "node" && m.id ? [m.id] : [])) ?? []),
    ]),
  };
  const cards = graph.detailed
    ? graph.snapshot.cards.filter(
        (c) => !isDraft(c) && c.sources.some((s) => s.kind === "node" && s.id === id),
      )
    : null;
  return {
    groups,
    ids: new Set([...(n ? [id] : []), ...Object.values(groups).flat()]),
    files: graph.detailed
      ? (n?.materials.filter((m) => m.kind !== "node" && m.kind !== "role" && m.kind !== "card") ??
        [])
      : null,
    // `target` is where a Card was sent, not evidence that anyone received it.
    cards:
      cards?.map((card) => ({
        card,
        role: card.receivedBy ? (graph.roles.get(card.receivedBy) ?? null) : null,
      })) ?? null,
  };
}

/** Facts among the related topics actually drawn, including facts between two neighbours. */
export function lensLines(
  graph: Graph,
  facts: ReturnType<typeof lensFacts>,
  placed: ReadonlyMap<string, unknown>,
  code: readonly CodeEdge[] = [],
) {
  const members = [...facts.ids].filter((id) => placed.has(id));
  const lines = selectionLines(graph, members, (id) => graph.nodes.get(id)?.parentId ?? null, code);
  const keys = new Set(lines.map((l) => `${l.kind}:${l.from}>${l.to}`));
  for (const id of members) {
    const n = graph.nodes.get(id)!;
    for (const to of new Set([
      ...n.links.flatMap((l) => (l.ref?.kind === "node" ? [l.ref.id] : [])),
      ...n.materials.flatMap((m) => (m.kind === "node" && m.id ? [m.id] : [])),
    ])) {
      if (
        to === id ||
        !facts.ids.has(to) ||
        !placed.has(to) ||
        n.parentId === to ||
        graph.nodes.get(to)?.parentId === id
      )
        continue;
      if (!keys.has(`link:${id}>${to}`)) {
        lines.push({ from: id, to, kind: "link" });
        keys.add(`link:${id}>${to}`);
      }
    }
  }
  return lines;
}
