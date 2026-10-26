import type { Handling } from "../data/handling.js";
import type { Graph } from "../data/store.js";
import type { SnapshotRef } from "../data/types.js";
import { t } from "../i18n.js";
import { PUBLIC } from "../shell/work.js";
import { Pet, Tray } from "./Pet.js";

// Before the page has the Role list a Role it does not know is not yet a deleted one.
const laneName = (graph: Graph, h: Handling) =>
  h.lane === PUBLIC
    ? t.work.public
    : (h.who ??
      graph.roles.get(h.lane)?.title ??
      (graph.detailed ? t.work.goneRole(h.lane) : h.lane));

/** One Card as a line: who is doing it, or whom it waits for. */
export function handlingText(graph: Graph, h: Handling) {
  const title = h.card.title || h.card.id;
  if (h.doing) return t.map.handling.doing(laneName(graph, h), title);
  return h.lane === PUBLIC
    ? t.map.handling.waitingPublic(title)
    : t.map.handling.waiting(laneName(graph, h), title);
}

/** A lane's face in a ring: filled while its Role is doing a Card, outlined while Cards wait for it. */
export function HandFace({
  lane,
  doing,
  size = 14,
}: {
  lane: string;
  doing: boolean;
  size?: number;
}) {
  return (
    <span className={`hand${doing ? " is-doing" : ""}`}>
      {lane === PUBLIC ? <Tray size={size} /> : <Pet id={lane} size={size} />}
    </span>
  );
}

/** At most two faces, Roles doing first, then how many more lanes there are. */
export function Hands({
  doing,
  waiting,
}: {
  doing: readonly string[];
  waiting: readonly string[];
}) {
  const all = [
    ...doing.map((lane) => ({ lane, doing: true })),
    ...waiting.map((lane) => ({ lane, doing: false })),
  ];
  return (
    <>
      {all.slice(0, 2).map((h) => (
        <HandFace key={h.lane} lane={h.lane} doing={h.doing} />
      ))}
      {all.length > 2 && <span className="hand-more">{t.map.handling.more(all.length - 2)}</span>}
    </>
  );
}

/** One row per Card; a row opens its Card. */
export function HandlingRows({
  graph,
  list,
  onOpen,
}: {
  graph: Graph;
  list: readonly Handling[];
  onOpen: (ref: SnapshotRef) => void;
}) {
  return (
    <>
      {list.map((h) => (
        <button
          key={h.card.id}
          type="button"
          className="handling-row"
          onClick={() => onOpen({ kind: "card", id: h.card.id })}
        >
          <HandFace lane={h.lane} doing={h.doing} />
          <span>{handlingText(graph, h)}</span>
        </button>
      ))}
    </>
  );
}
