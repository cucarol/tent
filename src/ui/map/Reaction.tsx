// The product a region's cards give: one strip at the foot of the region, opened for every fact.
// Rules: Tent Node "UI-图谱画模块依赖与状态", "画布是投影…三种类型起反应" (反应表) and
// "验证反应：底部一条，点开看细节" (cuca 2026-10-16/17).
import { useEffect, useRef, useState } from "react";
import { ViewportPortal } from "@xyflow/react";
import type { Region } from "./canvas.js";
import { t } from "../i18n.js";
import { ago } from "../util.js";
import {
  headOf,
  listed,
  summaryOf,
  type Constrain,
  type Loop,
  type Mark,
  type Overlap,
  type Reaction,
  type Sequence,
  type Verify,
} from "./reactions.js";

type NameOf = (id: string) => string;

const SIGN: Record<Mark, string> = { ok: "✓", warn: "!", none: "–", info: "·" };

function Sign({ mark }: { mark: Mark }) {
  return (
    <span className={`react-mark is-${mark}`} aria-hidden>
      {SIGN[mark]}
    </span>
  );
}

/** The one line a reaction leads with, in words. */
function headText(r: Reaction, nameOf: NameOf): string {
  const says = headOf(r).says;
  const x = t.map.react;
  switch (r.kind) {
    case "verify":
      return says === "materials"
        ? x.head.materials(r.changed.length)
        : x.head[says as Exclude<keyof typeof x.head, "materials">];
    case "constrain":
      return x.constrain.head[says as keyof typeof x.constrain.head];
    case "contrast":
      return x.contrast.head[says as keyof typeof x.contrast.head];
    case "overlap":
      return says === "family"
        ? x.overlap.head.family(
            nameOf(r.family === "a" ? r.a : r.b),
            nameOf(r.family === "a" ? r.b : r.a),
          )
        : says === "shares"
          ? x.overlap.head.shares(r.shared.length, r.rules.length)
          : x.overlap.head.nothing;
    case "govern":
      return says === "shares" ? x.govern.head.shares(r.shared.length) : x.govern.head.nothing;
    case "sequence":
      return x.sequence.head[says as keyof typeof x.sequence.head];
    case "loop": {
      const missing = [r.ruleOn, r.evidence, r.cites].filter((v) => !v).length;
      return missing ? x.loop.head.missing(missing) : x.loop.head.whole;
    }
  }
}

/** The cards a reaction is between. */
function cardsOf(r: Reaction): string[] {
  switch (r.kind) {
    case "verify":
      return [r.goal, r.output];
    case "constrain":
      return [r.goal, r.prompt];
    case "contrast":
      return [r.prompt, r.output];
    case "loop":
      return [r.goal, r.prompt, r.output];
    default:
      return [r.a, r.b];
  }
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
function VerifyFacts({ v, nameOf }: { v: Verify; nameOf: NameOf }) {
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

function ConstrainFacts({ r }: { r: Constrain }) {
  const x = t.map.react.constrain;
  return (
    <>
      {r.on === "none" ? <Row mark="info" says={x.off} /> : <Row mark="ok" says={x[r.on]} />}
      {r.shared.length > 0 && <Row mark="info" says={x.shared(r.shared)} />}
      {r.on !== "none" &&
        (r.rule === "behind" ? (
          <Row mark="warn" says={x.behind} note={x.behindNote} />
        ) : r.rule === "gaps" ? (
          <Row mark="none" says={x.gaps} note={x.gapsNote} />
        ) : (
          <Row mark="ok" says={x.fresh} />
        ))}
    </>
  );
}

function OverlapFacts({ r, nameOf }: { r: Overlap; nameOf: NameOf }) {
  const x = t.map.react.overlap;
  const top = r.family === "a" ? r.a : r.b,
    under = r.family === "a" ? r.b : r.a;
  return (
    <>
      {r.family && <Row mark="info" says={x.above(nameOf(top), nameOf(under))} />}
      <Row mark="info" says={r.shared.length ? x.shared(r.shared) : x.noShared} />
      {r.rules.length > 0 && <Row mark="info" says={x.rules(r.rules.map(nameOf))} />}
    </>
  );
}

function SequenceFacts({ r, nameOf }: { r: Sequence; nameOf: NameOf }) {
  const x = t.map.react.sequence;
  const [ga, gb] = r.goals;
  const goal = (g: string | null) => (g ? nameOf(g) : x.noGoal);
  return (
    <>
      <Row mark="info" says={ga && ga === gb ? x.same(nameOf(ga)) : x.apart(goal(ga), goal(gb))} />
      {r.first === null ? (
        <Row mark="none" says={x.noOrder} note={x.noOrderNote} />
      ) : (
        <Row
          mark="info"
          says={r.first === "same" ? x.together : x.first(nameOf(r.first === "a" ? r.a : r.b))}
        />
      )}
      {r.both > 0 && <Row mark="info" says={x.both(r.both)} />}
      {r.onlyA.length > 0 && <Row mark="info" says={x.only(nameOf(r.a), r.onlyA)} />}
      {r.onlyB.length > 0 && <Row mark="info" says={x.only(nameOf(r.b), r.onlyB)} />}
    </>
  );
}

function LoopFacts({ r }: { r: Loop }) {
  const x = t.map.react.loop;
  return (
    <>
      <Row mark={r.ruleOn ? "ok" : "warn"} says={r.ruleOn ? x.ruleOn : x.ruleOff} />
      <Row mark={r.evidence ? "ok" : "warn"} says={r.evidence ? x.evidence : x.noEvidence} />
      <Row mark={r.cites ? "ok" : "warn"} says={r.cites ? x.cites : x.silent} />
    </>
  );
}

/** Every fact of one reaction. */
function Facts({ r, nameOf }: { r: Reaction; nameOf: NameOf }) {
  const x = t.map.react;
  switch (r.kind) {
    case "verify":
      return <VerifyFacts v={r} nameOf={nameOf} />;
    case "constrain":
      return <ConstrainFacts r={r} />;
    case "contrast":
      return (
        <>
          <Row
            mark={r.cites ? "ok" : "info"}
            says={r.cites ? x.contrast.head.cites : x.contrast.head.silent}
          />
          {r.order === null ? (
            <Row mark="none" says={x.contrast.noOrder} note={x.contrast.noOrderNote} />
          ) : r.order === "after" ? (
            <Row mark="warn" says={x.contrast.after} note={x.contrast.afterNote} />
          ) : r.order ? (
            <Row mark="info" says={r.order === "same" ? x.contrast.same : x.contrast.before} />
          ) : null}
        </>
      );
    case "overlap":
      return <OverlapFacts r={r} nameOf={nameOf} />;
    case "govern":
      return <Row mark="info" says={x.govern.shared(r.shared)} />;
    case "sequence":
      return <SequenceFacts r={r} nameOf={nameOf} />;
    case "loop":
      return <LoopFacts r={r} />;
  }
}

/**
 * One strip for all a region's reactions: a single reaction's verdict, or how many there are and how
 * many moved. Clicking opens every fact above it; a click anywhere else closes it. Pairs that share
 * nothing are only counted.
 */
export function RegionProduct({ list: all, nameOf }: { list: Reaction[]; nameOf: NameOf }) {
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
  const list = all.filter(listed);
  if (!list.length) return null;
  const sum = summaryOf(list);
  const x = t.map.react;
  const kinds = new Set(list.map((r) => r.kind));
  const one = kinds.size === 1 ? list[0].kind : null;
  // Loops are three cards, not a pair, and what they lack is a link rather than a change.
  const pairs = one !== null && one !== "loop";
  const unit = pairs ? undefined : x.unit;
  // A read in flight leaves the last answer up, shown as the last one rather than as current.
  const again = list.some((r) => r.kind === "verify" && r.read === "refreshing");
  return (
    <div
      ref={box}
      className="react-product nopan nodrag"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {open && (
        <div className="react-pop" role="dialog" aria-label={x.name[one ?? "any"]}>
          {again && <div className="react-again">{x.refreshing}</div>}
          {list.map((r) => (
            <section key={`${r.kind}|${cardsOf(r).join("|")}`} className="react-pair">
              {(list.length > 1 || !one) && (
                <div className="react-pair-name">
                  {[x.name[r.kind], ...cardsOf(r).map(nameOf)].join(" · ")}
                </div>
              )}
              <Facts r={r} nameOf={nameOf} />
            </section>
          ))}
          <div className="react-foot">{one === "verify" ? x.judge : x.judgeAll}</div>
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
        <span className="react-kind">{x.name[one ?? "any"]}</span>
        <Sign mark={list.length === 1 ? headOf(list[0]).mark : sum.mark} />
        <span className="react-says">
          {list.length === 1
            ? headText(list[0], nameOf)
            : `${pairs ? x.pairs(list.length) : x.items(list.length)} · ${
                sum.says === "moved"
                  ? (pairs ? x.many.moved : x.many.notice)(sum.moved, sum.unclear, unit)
                  : sum.says === "unclear"
                    ? x.many.unclear(sum.unclear, unit)
                    : x.many[sum.says]
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
        if (!list?.some(listed)) return null;
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
