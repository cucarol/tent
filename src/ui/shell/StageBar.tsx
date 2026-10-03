import { Fragment } from "react";
import { cardTitle, type Graph } from "../data/store.js";
import type { SnapshotRef } from "../data/types.js";
import { CardGlyph, Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { t } from "../i18n.js";

/** The bar over the map: where the selection sits, and the Roles at work in the workspace. */
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
  if (selected?.kind === "node" && graph.nodes.has(selected.id)) {
    for (const n of [...graph.ancestors(selected.id), graph.nodes.get(selected.id)!])
      crumbs.push({
        ref: { kind: "node", id: n.id },
        name: n.name,
        glyph: <TypeGlyph type={n.type} size={15} />,
      });
  } else if (selected?.kind === "role" && graph.roles.has(selected.id)) {
    crumbs.push({
      ref: selected,
      name: t.bar.role(graph.roles.get(selected.id)!.title),
      glyph: <Pet id={selected.id} size={14} />,
    });
  } else if (selected?.kind === "card" && graph.cards.has(selected.id)) {
    crumbs.push({
      ref: selected,
      name: cardTitle(graph.cards.get(selected.id)!),
      glyph: <CardGlyph size={15} />,
    });
  }
  return (
    <header className="stage-bar">
      <nav className="crumbs" aria-label={t.bar.where}>
        <button type="button" className="crumb" onClick={() => onOpen(null)}>
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
        <span className="avatars">
          {graph.snapshot.roles.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`stage-pet${selected?.id === r.id ? " is-active" : ""}`}
              onClick={() => onOpen({ kind: "role", id: r.id })}
              aria-label={t.bar.role(r.title)}
              data-tip={t.bar.role(r.title)}
              data-tip-end=""
            >
              <Pet id={r.id} size={28} />
            </button>
          ))}
        </span>
      </div>
    </header>
  );
}
