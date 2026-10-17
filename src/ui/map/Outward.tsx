// Looking one layer out from a region: the cards outside it that Tent already relates to its members,
// shown faded beside it, each joining only when clicked.
// Rules: Tent Node "UI-图谱画模块依赖与状态", "画布是投影；拖在一起形成区域" (往外看一层, cuca and judge 2026-10-16).
import { useEffect } from "react";
import { ViewportPortal } from "@xyflow/react";
import type { Region } from "./canvas.js";
import type { RegionLine } from "./regions.js";
import { TypeGlyph } from "../components/Glyph.js";
import { t } from "../i18n.js";

/** At most this many faded cards; the rest are only counted. */
export const OUTWARD_MAX = 12;

/** How a card outside is related to the region, in the words its lines use. */
function how(lines: RegionLine[]): string {
  const x = t.map.region.line;
  const words = lines.map((l) =>
    l.kind === "material"
      ? x.material(l.files ?? [])
      : l.kind === "code"
        ? x.code(l.imports ?? 0)
        : l.kind === "card"
          ? x.card(l.cards ?? [])
          : x[l.kind],
  );
  return [...new Set(words)].join(" · ");
}

export function Outward({
  region,
  reach,
  nameOf,
  typeOf,
  onJoin,
  onClose,
}: {
  region: Region;
  reach: Map<string, RegionLine[]>;
  nameOf: (id: string) => string;
  typeOf: (id: string) => string;
  onJoin: (ids: string[]) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    addEventListener("keydown", esc, true);
    return () => removeEventListener("keydown", esc, true);
  }, [onClose]);
  const ids = [...reach.keys()];
  const x = t.map.region;
  return (
    <ViewportPortal>
      <div
        className="outward nopan nodrag"
        role="group"
        aria-label={x.outHead(ids.length)}
        style={{
          transform: `translate(${region.box[0] + region.box[2] + 28}px, ${region.box[1]}px)`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="outward-head">
          <span>{x.outHead(ids.length)}</span>
          {ids.length > 1 && (
            <button
              type="button"
              className="outward-act"
              onClick={() => onJoin(ids.slice(0, OUTWARD_MAX))}
            >
              {x.outAll}
            </button>
          )}
          <button type="button" className="outward-act" onClick={onClose}>
            {x.outClose}
          </button>
        </div>
        {ids.slice(0, OUTWARD_MAX).map((id) => (
          <button
            key={id}
            type="button"
            className="outward-card"
            title={x.outJoin}
            onClick={() => onJoin([id])}
          >
            <TypeGlyph type={typeOf(id)} />
            <span className="outward-text">
              <span className="outward-name">{nameOf(id)}</span>
              <span className="outward-how">{how(reach.get(id)!)}</span>
            </span>
            <span className="outward-plus" aria-hidden>
              +
            </span>
          </button>
        ))}
        {ids.length > OUTWARD_MAX && (
          <div className="outward-more">{x.outMore(ids.length - OUTWARD_MAX)}</div>
        )}
      </div>
    </ViewportPortal>
  );
}
