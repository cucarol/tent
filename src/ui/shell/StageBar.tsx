import { Fragment } from "react";
import { cardTitle, type Graph } from "../data/store.js";
import type { SnapshotRef } from "../data/types.js";
import { CardGlyph, Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { t } from "../i18n.js";

/** The bar over the stage: the map, and where the selection sits on it. */
export function StageBar({
  graph,
  selected,
  onOpen,
}: {
  graph: Graph;
  selected: SnapshotRef | null;
  onOpen: (ref: SnapshotRef | null) => void;
}) {
  const crumbs: { ref: SnapshotRef; name: string; glyph: React.ReactNode }[] = [];
  const at = selected;
  if (at?.kind === "node" && graph.nodes.has(at.id)) {
    for (const n of [...graph.ancestors(at.id), graph.nodes.get(at.id)!])
      crumbs.push({
        ref: { kind: "node", id: n.id },
        name: n.name,
        glyph: <TypeGlyph type={n.type} size={15} />,
      });
  } else if (at?.kind === "role" && graph.roles.has(at.id)) {
    crumbs.push({
      ref: at,
      name: t.bar.role(graph.roles.get(at.id)!.title),
      glyph: <Pet id={at.id} size={14} />,
    });
  } else if (at?.kind === "card" && graph.cards.has(at.id)) {
    crumbs.push({
      ref: at,
      name: cardTitle(graph.cards.get(at.id)!),
      glyph: <CardGlyph size={15} />,
    });
  }
  return (
    <header className="stage-bar">
      <nav className="crumbs" aria-label={t.bar.where}>
        <button
          type="button"
          className="crumb is-root"
          onClick={() => onOpen(null)}
          aria-current={crumbs.length ? undefined : "location"}
        >
          {t.app.map}
        </button>
        {crumbs.map((c, i) => (
          <Fragment key={c.ref.id}>
            <Icon name="chevron" size={13} />
            <button
              type="button"
              className="crumb"
              onClick={() => onOpen(c.ref)}
              aria-current={i === crumbs.length - 1 ? "location" : undefined}
            >
              {c.glyph}
              <span>{c.name}</span>
            </button>
          </Fragment>
        ))}
      </nav>
      <div className="stage-meta">
        {!selected && <span>{t.bar.nodes(graph.snapshot.nodes.length)}</span>}
      </div>
    </header>
  );
}
