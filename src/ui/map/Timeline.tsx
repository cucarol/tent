import { useMemo, useState, type RefObject } from "react";
import type { SnapshotCommit } from "../data/types.js";
import { t } from "../i18n.js";
import { dayLabel, when } from "../util.js";

// The thumb is a thin bar; each tick sits where the bar's middle stands at that commit.
const THUMB = 3;
const at = (i: number, last: number) =>
  `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${last ? i / last : 0})`;

/**
 * Every commit as a tick, taller the more Nodes it wrote, with each day marked below. A native
 * range input on top does the dragging and the arrow keys; pointing at a tick says what it did.
 */
export function Timeline({
  commits,
  index,
  onChange,
  rangeRef,
  summarize,
}: {
  commits: SnapshotCommit[];
  index: number;
  onChange: (index: number) => void;
  rangeRef: RefObject<HTMLInputElement | null>;
  summarize: (commit: SnapshotCommit) => string;
}) {
  const last = commits.length - 1;
  const [hover, setHover] = useState<number | null>(null);
  const ticks = useMemo(
    () =>
      commits.map((c) => {
        const nodes = new Set(c.files.flatMap((f) => (f.ref?.kind === "node" ? [f.ref.id] : [])))
          .size;
        return nodes ? 7 + Math.min(nodes, 4) * 3 : 4;
      }),
    [commits],
  );
  const days = useMemo(() => {
    const out: { i: number; label: string }[] = [];
    let prev = "";
    commits.forEach((c, i) => {
      const day = new Date(c.date).toDateString();
      if (day === prev) return;
      prev = day;
      // Days only a few commits apart keep the first label, so labels never run into each other.
      const before = out.at(-1);
      if (before && (i - before.i) / (last || 1) < 0.12) return;
      out.push({ i, label: dayLabel(c.date) });
    });
    return out;
  }, [commits, last]);
  const tip = hover === null || hover === index ? null : commits[hover];

  return (
    <div
      className="timeline"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const f = (e.clientX - r.left - THUMB / 2) / (r.width - THUMB);
        setHover(Math.max(0, Math.min(last, Math.round(f * last))));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="timeline-ticks" aria-hidden="true">
        {ticks.map((height, i) => (
          <i
            key={i}
            className={i <= index ? "is-past" : undefined}
            style={{ left: at(i, last), height }}
          />
        ))}
      </div>
      <input
        ref={rangeRef}
        type="range"
        className="timeline-range"
        min={0}
        max={last}
        value={index}
        aria-label={t.map.moment}
        aria-valuetext={when(commits[index]!.date)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="timeline-days" aria-hidden="true">
        {days.map((d) => (
          <span key={d.i} style={{ left: at(d.i, last) }}>
            {d.label}
          </span>
        ))}
      </div>
      {tip && (
        <div
          className="timeline-tip"
          style={{ left: `clamp(120px, ${at(hover!, last)}, calc(100% - 120px))` }}
        >
          <b>{when(tip.date)}</b> {summarize(tip)}
        </div>
      )}
    </div>
  );
}
