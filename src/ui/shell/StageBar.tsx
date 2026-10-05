import { Fragment } from "react";
import { cardTitle, type Graph } from "../data/store.js";
import type { SnapshotRef } from "../data/types.js";
import { CardGlyph, Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { t } from "../i18n.js";

export type StageView = "now" | "map";

/** The bar over the stage: the Now and map tabs, where the selection sits on the map, and the Roles at work. */
export function StageBar({
  graph,
  selected,
  view,
  onView,
  onOpen,
}: {
  graph: Graph;
  selected: SnapshotRef | null;
  view: StageView;
  onView: (view: StageView) => void;
  onOpen: (ref: SnapshotRef | null) => void;
}) {
  const crumbs: { ref: SnapshotRef; name: string; glyph: React.ReactNode }[] = [];
  // Crumbs place the selection on the map; the Now page has none.
  const at = view === "map" ? selected : null;
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
        <span className="stage-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="stage-tab"
            aria-selected={view === "now"}
            onClick={() => onView("now")}
          >
            {t.now.tab}
          </button>
          <button
            type="button"
            role="tab"
            className="stage-tab"
            aria-selected={view === "map"}
            onClick={() => (view === "map" ? onOpen(null) : onView("map"))}
          >
            {t.app.map}
          </button>
        </span>
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
        {view === "map" && !selected && <span>{t.bar.nodes(graph.snapshot.nodes.length)}</span>}
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
