import { useEffect, useMemo, useRef, useState } from "react";
import { cardTitle, primaryOf, suffixOf, type Graph } from "../data/store.js";
import type { SnapshotRef } from "../data/types.js";
import { CardGlyph, Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { isDraft } from "../data/drafts.js";
import { cardProgressLabel } from "../data/card-progress.js";
import { t } from "../i18n.js";

type Item = { ref: SnapshotRef; name: string; sub: string; hay: string; kindLabel: string };

function items(graph: Graph): Item[] {
  return [
    ...graph.snapshot.nodes.map((n) => ({
      ref: { kind: "node" as const, id: n.id },
      name: n.name,
      sub: n.description || n.type,
      hay: `${n.name} ${n.id} ${n.type} ${n.description} ${n.tags.join(" ")} ${n.body}`.toLowerCase(),
      kindLabel: suffixOf(n.type) || primaryOf(n.type),
    })),
    ...graph.snapshot.roles.map((r) => ({
      ref: { kind: "role" as const, id: r.id },
      name: r.title,
      sub: r.body.trim().split("\n")[0] ?? "",
      hay: `${r.title} ${r.id} ${r.body}`.toLowerCase(),
      kindLabel: "role",
    })),
    ...graph.snapshot.cards.map((c) => ({
      ref: { kind: "card" as const, id: c.id },
      name: cardTitle(c),
      sub: `${isDraft(c) ? t.work.draft : cardProgressLabel(c)} · ${c.id}`,
      hay: `${c.title} ${c.id} ${c.body}`.toLowerCase(),
      kindLabel: "card",
    })),
  ];
}
export function search(graph: Graph, query: string, limit = 24): Item[] {
  const all = items(graph);
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  return all
    .map((i) => ({
      i,
      s: i.name.toLowerCase().includes(q)
        ? 3
        : i.ref.id.includes(q)
          ? 2
          : i.hay.includes(q)
            ? 1
            : 0,
    }))
    .filter((x) => x.s)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.i);
}

export function ItemGlyph({ graph, target }: { graph: Graph; target: SnapshotRef }) {
  if (target.kind === "node")
    return <TypeGlyph type={graph.nodes.get(target.id)?.type ?? "prompt"} size={14} />;
  return target.kind === "role" ? <Pet id={target.id} size={14} /> : <CardGlyph size={14} />;
}

export function Palette({
  graph,
  onOpen,
  onClose,
}: {
  graph: Graph;
  onOpen: (ref: SnapshotRef) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const results = useMemo(() => search(graph, query), [graph, query]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label={t.palette.label}>
        <label className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.palette.placeholder}
            aria-label={t.palette.label}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setIndex(
                  (i) =>
                    (i + (e.key === "ArrowDown" ? 1 : -1) + results.length) %
                    Math.max(1, results.length),
                );
              } else if (e.key === "Enter" && results[index]) {
                onOpen(results[index]!.ref);
                onClose();
              } else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <ul className="palette-list" role="listbox">
          {results.map((r, i) => (
            <li key={`${r.ref.kind}:${r.ref.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  onOpen(r.ref);
                  onClose();
                }}
              >
                <ItemGlyph graph={graph} target={r.ref} />
                <span className="palette-name">{r.name}</span>
                <span className="palette-kind">{r.kindLabel}</span>
                <small>{r.sub}</small>
              </button>
            </li>
          ))}
          {!results.length && <li className="empty">{t.palette.empty}</li>}
        </ul>
      </div>
    </div>
  );
}
