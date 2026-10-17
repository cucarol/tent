// The product a region's cards give: one strip at the foot of the region, opened for every fact.
// Rules: Tent Node "UI-图谱画模块依赖与状态", "验证反应：底部一条，点开看细节" (cuca 2026-10-17).
import { useEffect, useRef, useState } from "react";
import { ViewportPortal } from "@xyflow/react";
import type { Region } from "./canvas.js";
import { t } from "../i18n.js";
import { ago } from "../util.js";
import { headOf, summaryOf, type Mark, type Reaction, type Verify } from "./reactions.js";

const SIGN: Record<Mark, string> = { ok: "✓", warn: "!", none: "–" };

function Sign({ mark }: { mark: Mark }) {
  return (
    <span className={`react-mark is-${mark}`} aria-hidden>
      {SIGN[mark]}
    </span>
  );
}

function headText(v: Verify) {
  const h = t.map.react.head;
  const says = headOf(v).says;
  return says === "materials" ? h.materials(v.changed.length) : h[says];
}

function Row({ mark, says, note }: { mark: Mark; says: string; note?: string }) {
  return (
    <div className="react-row">
      <Sign mark={mark} />
      <div>
        {says}
        {note && <small>{note}</small>}
      </div>
    </div>
  );
}

/** Every fact of one goal and output, in the order the goal names them. */
function VerifyFacts({ v, nameOf }: { v: Verify; nameOf: (id: string) => string }) {
  const r = t.map.react;
  if (v.under === "none") return <Row mark="none" says={r.head.none} note={r.noneNote} />;
  return (
    <>
      {v.under === "source" ? (
        <Row mark="none" says={r.source} note={r.sourceNote} />
      ) : (
        <Row
          mark="ok"
          says={r.child}
          note={(v.under === "child" ? r.childNote : r.belowNote)(nameOf(v.goal))}
        />
      )}
      {v.under === "source" ? null : v.goalState === "changed" ? (
        <Row
          mark="warn"
          says={r.goalMoved}
          note={v.writtenAt ? r.written(ago(v.writtenAt)) : undefined}
        />
      ) : v.goalState === "current" ? (
        <Row mark="ok" says={r.current} note={r.currentNote} />
      ) : v.goalState === "unknown" ? (
        <Row mark="none" says={r.unknown} note={r.unknownNote} />
      ) : v.read === "failed" ? (
        <Row mark="none" says={r.failed} note={r.failedNote} />
      ) : (
        <Row mark="none" says={r.waiting} />
      )}
      {v.changed.length ? (
        <Row mark="warn" says={r.changed(v.changed.length)} note={v.changed.join("、")} />
      ) : v.goalState === null ? null : (
        <Row mark="none" says={r.still} />
      )}
    </>
  );
}

/**
 * One strip for all a region's reactions: the single pair's verdict, or how many pairs and how many
 * moved. Clicking opens every fact above it; a click anywhere else closes it.
 */
export function RegionProduct({
  list,
  nameOf,
}: {
  list: Reaction[];
  nameOf: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("pointerdown", away, true);
      removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!list.length) return null;
  const sum = summaryOf(list);
  const many = t.map.react.many;
  // A read in flight leaves the last answer up, shown as the last one rather than as current.
  const again = list.some((v) => v.read === "refreshing");
  return (
    <div
      ref={box}
      className="react-product nopan nodrag"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {open && (
        <div className="react-pop" role="dialog" aria-label={t.map.react.verify}>
          {again && <div className="react-again">{t.map.react.refreshing}</div>}
          {list.map((v) => (
            <section key={`${v.goal}|${v.output}`} className="react-pair">
              {list.length > 1 && (
                <div className="react-pair-name">
                  {t.map.react.pair(nameOf(v.goal), nameOf(v.output))}
                </div>
              )}
              <VerifyFacts v={v} nameOf={nameOf} />
            </section>
          ))}
          <div className="react-foot">{t.map.react.judge}</div>
        </div>
      )}
      <button
        type="button"
        className={`react-pill${open ? " is-open" : ""}${again ? " is-again" : ""}`}
        aria-busy={again}
        aria-expanded={open}
        title={t.map.react.open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="react-kind">{t.map.react.verify}</span>
        <Sign mark={list.length === 1 ? headOf(list[0]).mark : sum.mark} />
        <span className="react-says">
          {list.length === 1
            ? headText(list[0])
            : `${t.map.react.pairs(list.length)} · ${
                sum.says === "moved"
                  ? many.moved(sum.moved, sum.unclear)
                  : sum.says === "unclear"
                    ? many.unclear(sum.unclear)
                    : many[sum.says]
              }`}
        </span>
        <span className="react-chev" aria-hidden>
          ⌄
        </span>
      </button>
    </div>
  );
}

/**
 * Every region's product, over the cards so its facts are never hidden under them: on the middle of the
 * region's lower edge, opening upward.
 */
export function RegionProducts({
  regions,
  reactions,
  nameOf,
}: {
  regions: Region[];
  reactions: Map<string, Reaction[]>;
  nameOf: (id: string) => string;
}) {
  return (
    <ViewportPortal>
      {regions.map((r) => {
        const list = reactions.get(r.id);
        if (!list?.length) return null;
        return (
          <div
            key={r.id}
            className="react-at"
            style={{
              transform: `translate(${r.box[0] + r.box[2] / 2}px, ${r.box[1] + r.box[3]}px)`,
            }}
          >
            <RegionProduct list={list} nameOf={nameOf} />
          </div>
        );
      })}
    </ViewportPortal>
  );
}
