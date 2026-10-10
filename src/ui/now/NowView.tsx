import { aheadKind, onlyGaps } from "../data/reasons.js";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { cardTitle, primaryOf, type Graph } from "../data/store.js";
import { isDraft } from "../data/drafts.js";
import { UNREAD } from "../data/flags.js";
import type {
  SnapshotCard,
  SnapshotNode,
  SnapshotRef,
  SyncFlag,
  SyncFlags,
} from "../data/types.js";
import { Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { ago, readStored, when, writeStored } from "../util.js";
import { t } from "../i18n.js";

/** A behind reason caused by a goal's own material changing, e.g. "Goal node-ab12cd: Material changed: /A/A.md". */
const GOAL_CHANGE = /^Goal ([^:\s]+): Material changed: /;
// A side is one list of groups, each a heading over one-line rows, with a hairline between groups.
// Fixed heights, so how many rows fit is known before drawing; the heading counts the rest.
const ROW = 32,
  HEAD = 38,
  PAD = 6;
// The height a side lays out for until it is measured, and on the server.
const UNMEASURED = 460;

/**
 * When this viewer last opened the workspace before this tab. The mark is pinned for the tab, so a
 * refresh keeps showing the same "since"; the next tab starts from this visit.
 */
function useSince(workspaceId: string): string | null {
  const [since] = useState(() => {
    const key = `tent-last-visit:${workspaceId}`;
    let mark: string | null = null;
    try {
      mark = sessionStorage.getItem(key);
    } catch {
      /* no session storage */
    }
    if (mark === null) {
      mark = readStored<string>(key, "");
      try {
        sessionStorage.setItem(key, mark);
      } catch {
        /* no session storage */
      }
    }
    writeStored(key, new Date().toISOString());
    return mark || null;
  });
  return since;
}

const live = (c: SnapshotCard) => !isDraft(c) && c.status !== "deprecated";

/**
 * How many rows each group shows in this height, groups in order of importance. Every group first gets
 * its heading, then rows go round one at a time from the top until the next one does not fit, so a
 * group with seventy Cards above one with three still leaves the small one readable, and a group that
 * gets no row still shows its heading and counts. Groups that do not fit even a heading are left off
 * the end behind one line naming them; `reserve` is room kept for a line under the groups.
 */
export function allot(needs: number[], height: number, reserve = 0): number[] {
  const size = (n: number) => HEAD + (n > 0 ? n * ROW + PAD : 0);
  const fits = (rows: number[]) =>
    rows.reduce((s, n) => s + size(n), 0) +
      Math.max(0, rows.length - 1) +
      (rows.length < needs.length ? ROW + 1 : 0) +
      reserve <=
    height;
  const rows = needs.map(() => 0);
  while (rows.length && !fits(rows)) rows.pop();
  for (let grew = true; grew;) {
    grew = false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]! >= needs[i]!) continue;
      rows[i] = rows[i]! + 1;
      if (!fits(rows)) {
        rows[i] = rows[i]! - 1;
        return rows;
      }
      grew = true;
    }
  }
  return rows;
}

type Mark = "waiting" | "doing" | "review" | "behind" | "ahead";

/** The state at the start of a row, so the words after it can stay quiet. */
function StateMark({ kind, part = 0 }: { kind: Mark; part?: number }) {
  if (kind === "behind" || kind === "ahead")
    return (
      <span className="ns-ico">
        <i className={`ns-pill is-${kind}`} />
      </span>
    );
  const r = 5.5;
  return (
    <span className="ns-ico">
      <svg width="14" height="14" viewBox="0 0 14 14" className={`ns-state is-${kind}`} aria-hidden>
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          strokeWidth="1.5"
          strokeDasharray={kind === "waiting" ? "2.4 1.9" : undefined}
        />
        {kind === "review" && <circle cx="7" cy="7" r="2.2" className="ns-fill" />}
        {kind === "doing" && part > 0 && (
          // The share of the Card's goals that have output, as a slice from twelve o'clock.
          <path
            className="ns-fill"
            d={
              part >= 1
                ? "M7 3.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7z"
                : `M7 7V3.5A3.5 3.5 0 ${part > 0.5 ? 1 : 0} 1 ${7 + 3.5 * Math.sin(2 * Math.PI * part)} ${7 - 3.5 * Math.cos(2 * Math.PI * part)}z`
            }
          />
        )}
      </svg>
    </span>
  );
}

type Group = {
  id: string;
  /** What the line under a full side calls this group when it is left off. */
  label: string;
  head: ReactNode;
  rows: ReactNode[];
  /** Opening the group: its heading is one button. */
  open: () => void;
  openLabel?: string;
  /** Something on the right of the heading instead of the opening chevron. */
  end?: ReactNode;
};

/** One side of the page: groups down one list, as many rows as the measured height holds. */
function List({ groups, tail, empty }: { groups: Group[]; tail?: ReactNode; empty?: ReactNode }) {
  // A callback ref: the list may start empty and get rows later, and either way its box is the one to watch.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(UNMEASURED);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const inner =
        el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (inner > 0) setHeight(inner);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  if (groups.length === 0 && !tail)
    return (
      <div ref={setEl} className="ns-list is-empty">
        {empty}
      </div>
    );
  const rows = allot(
    groups.map((g) => g.rows.length),
    height,
    tail ? ROW + 1 : 0,
  );
  return (
    <div ref={setEl} className="ns-list">
      {groups.length === 0 && empty}
      {rows.map((n, i) => {
        const g = groups[i]!;
        return (
          <section key={g.id} className="ns-group">
            <div className="ns-head">
              <button
                type="button"
                className="ns-title"
                onClick={g.open}
                aria-label={g.openLabel}
                data-tip={g.openLabel}
              >
                {g.head}
                {!g.end && (
                  <span className="ns-go">
                    <Icon name="chevron" size={13} />
                  </span>
                )}
              </button>
              {g.end}
            </div>
            {n > 0 && <div className="ns-rows">{g.rows.slice(0, n)}</div>}
          </section>
        );
      })}
      {rows.length < groups.length && (
        <p className="ns-foot">
          <span>{t.now.more(groups.length - rows.length)}</span>
          {groups.slice(rows.length).map((g) => (
            <button key={g.id} type="button" className="ns-chip" onClick={g.open}>
              {g.label}
            </button>
          ))}
        </p>
      )}
      {tail}
    </div>
  );
}

type Flagged = { n: SnapshotNode; flag: SyncFlag };

/**
 * The home page on one screen. On the left, who is doing what: a group per Role with the Cards in its
 * hands, waiting first. On the right, what needs a look: a group per direction with its behind and
 * ahead Nodes. Underneath, what was finished. Rows share out the height so nothing scrolls, and each
 * heading counts what is there; opening a group gives it the whole side, and on the right that goes
 * down level by level. Nothing here waits on the person: it only shows what the Agents' work derived.
 */
export function NowView({
  graph,
  flags,
  onOpen,
  onPage,
}: {
  graph: Graph;
  flags: SyncFlags;
  onOpen: (ref: SnapshotRef) => void;
  onPage: (ref: SnapshotRef) => void;
}) {
  const since = useSince(graph.snapshot.workspace.id);
  // The lane opened on the left ("" is the public area), or the finished outputs; the path opened on
  // the right, outermost first.
  const [left, setLeft] = useState<{ lane: string } | "done" | null>(null);
  const [path, setPath] = useState<string[]>([]);

  const nodes = graph.snapshot.nodes.filter((n) => !n.archived);
  const cards = graph.snapshot.cards.filter(live);
  const outputs = nodes
    .filter(
      (n) =>
        primaryOf(n.type) === "output" &&
        (n.status === "draft" || n.status === "stable") &&
        n.outputAt,
    )
    .sort((a, b) => Date.parse(b.outputAt!) - Date.parse(a.outputAt!));
  const done = since ? outputs.filter((n) => Date.parse(n.outputAt!) > Date.parse(since)) : outputs;
  const completedAt = (c: SnapshotCard) =>
    c.outputNodeIds.reduce((latest, id) => {
      const at = graph.nodes.get(id)?.outputAt ?? "";
      return at > latest ? at : latest;
    }, "");
  const kids = (id: string | null) => graph.childrenOf(id).filter((n) => !n.archived);

  // ---------- who is doing what ----------
  const lanes = [
    ...graph.snapshot.roles
      .filter((r) => r.status !== "deprecated")
      .map((r) => ({ id: r.id, title: r.title, ref: { kind: "role", id: r.id } as SnapshotRef })),
    { id: "", title: t.work.public, ref: null },
  ]
    .map((lane) => {
      const mine = (c: SnapshotCard) => (c.receivedBy ?? c.target ?? "") === lane.id;
      return {
        ...lane,
        waiting: cards.filter((c) => mine(c) && c.state === "pending"),
        doing: cards
          .filter((c) => mine(c) && c.progress === "received-no-output")
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
        review: cards.filter((c) => mine(c) && c.progress === "needs-review"),
        last: cards
          .filter((c) => mine(c) && c.progress === "has-output")
          .sort((a, b) => completedAt(b).localeCompare(completedAt(a)))[0],
      };
    })
    // The public area only shows while something waits there.
    .filter((lane) => lane.id || lane.waiting.length || lane.doing.length || lane.review.length);
  type Lane = (typeof lanes)[number];
  const held = (lane: Lane) => lane.waiting.length + lane.doing.length + lane.review.length;
  // Lanes with Cards in hand, the ones with Cards waiting first; idle Roles share one line underneath.
  const busy = lanes
    .filter((lane) => held(lane) > 0)
    .sort((a, b) => b.waiting.length - a.waiting.length || held(b) - held(a));
  const idle = lanes.filter((lane) => held(lane) === 0);

  const cardRow = (c: SnapshotCard, kind: "waiting" | "doing" | "review") => (
    <button
      key={c.id}
      type="button"
      className="ns-row"
      onClick={() => onPage({ kind: "card", id: c.id })}
      title={cardTitle(c)}
    >
      <StateMark kind={kind} part={c.totalGoalCount > 0 ? c.goalCount / c.totalGoalCount : 0} />
      <span className="ns-text">{cardTitle(c)}</span>
      <span className="ns-meta">
        {kind === "waiting"
          ? t.now.waitingShort
          : kind === "review"
            ? `${t.cardProgress["needs-review"]} · ${t.now.reviewOutputs(c.reviewOutputNodeIds?.length ?? 0)}`
            : c.totalGoalCount > 0
              ? `${c.goalCount}/${c.totalGoalCount}`
              : t.now.doing}
      </span>
    </button>
  );
  const laneGroup = (lane: Lane, opened: boolean): Group => ({
    id: lane.id || "public",
    label: lane.title,
    open: () => (opened ? setLeft(null) : setLeft({ lane: lane.id })),
    head: (
      <>
        <span className="ns-ico">
          {lane.ref ? (
            <Pet id={lane.id} size={18} />
          ) : (
            <span className="ns-pub">
              <Icon name="public" size={11} />
            </span>
          )}
        </span>
        <span className="ns-name">{lane.title}</span>
        <span className="ns-count">
          {t.now.laneCounts(lane.doing.length, lane.waiting.length, lane.review.length)}
        </span>
      </>
    ),
    end:
      opened && lane.ref ? (
        <button type="button" className="ns-link" onClick={() => onPage(lane.ref!)}>
          {t.now.openRole(lane.title)}
          <Icon name="chevron" size={12} />
        </button>
      ) : undefined,
    rows: [
      ...lane.waiting.map((c) => cardRow(c, "waiting")),
      ...lane.review.map((c) => cardRow(c, "review")),
      ...lane.doing.map((c) => cardRow(c, "doing")),
    ],
  });

  // ---------- what needs a look ----------
  const known = flags !== UNREAD;
  const flagged = Object.entries(flags).flatMap(([id, flag]) => {
    const n = graph.nodes.get(id);
    return n && !n.archived ? [{ n, flag }] : [];
  });
  const behindN = flagged.filter((f) => f.flag.behind && !onlyGaps(f.flag.behind.reasons)).length;
  const aheadN = flagged.filter((f) => f.flag.ahead).length;
  // One goal edit makes the goal ahead and every output under it behind, down the whole goal chain.
  // Show it once, on each changed goal, unless an output is also behind for another reason.
  const reviewing = new Map<string, number>();
  const folded = (n: SnapshotNode, reasons: string[]) => {
    if (primaryOf(n.type) !== "output" || !reasons.length) return false;
    const goals = new Set<string>();
    for (const r of reasons) {
      const goal = GOAL_CHANGE.exec(r)?.[1];
      if (!goal || !flags[goal]?.ahead) return false;
      goals.add(goal);
    }
    for (const goal of goals) reviewing.set(goal, (reviewing.get(goal) ?? 0) + 1);
    return true;
  };
  const shown: Flagged[] = [
    ...flagged.filter(
      (f) => f.flag.behind && (f.flag.ahead || !folded(f.n, f.flag.behind.reasons)),
    ),
    ...flagged.filter((f) => f.flag.ahead && !f.flag.behind),
  ];
  // Missing baselines say nothing changed; they wait for one confirmation, so they only get counted.
  const gaps = shown.filter((f) => !f.flag.ahead && onlyGaps(f.flag.behind!.reasons));
  const watch = new Map(shown.filter((f) => !gaps.includes(f)).map((f) => [f.n.id, f] as const));
  const under = (id: string): SnapshotNode[] => kids(id).flatMap((c) => [c, ...under(c.id)]);
  const watched = (id: string) =>
    [graph.nodes.get(id)!, ...under(id)].flatMap((n) => {
      const f = watch.get(n.id);
      return f ? [f] : [];
    });
  const why = ({ n, flag }: Flagged) =>
    flag.behind
      ? t.map.behindWhy(flag.behind.reasons) +
        (reviewing.has(n.id)
          ? ` · ${t.now.goalChanged(flag.ahead?.since ? ago(flag.ahead.since) : null, reviewing.get(n.id)!)}`
          : "")
      : reviewing.has(n.id)
        ? t.now.goalChanged(flag.ahead?.since ? ago(flag.ahead.since) : null, reviewing.get(n.id)!)
        : t.map.aheadWhy(
            flag.ahead?.since ? ago(flag.ahead.since) : null,
            aheadKind(flag.ahead?.reasons),
          );
  const nodeRow = (f: Flagged) => (
    <button
      key={f.n.id}
      type="button"
      className="ns-row"
      onClick={() => onOpen({ kind: "node", id: f.n.id })}
      title={`${f.n.name} · ${why(f)}`}
    >
      <StateMark kind={f.flag.behind ? "behind" : "ahead"} />
      <span className="ns-text">{f.n.name}</span>
      <span className="ns-meta is-long">{why(f)}</span>
    </button>
  );
  const counts = (list: Flagged[]) => {
    const b = list.filter((f) => f.flag.behind).length,
      a = list.filter((f) => f.flag.ahead).length;
    return [b && t.map.behindCount(b), a && t.map.aheadCount(a)].filter(Boolean).join(" · ");
  };
  // The level open on the right: the children of the last Node on the path (top-level Nodes at first),
  // each a group if something under it needs a look, the most behind first. A direction that is itself
  // behind or ahead carries the mark on its heading rather than repeating itself as a row.
  const at = path.at(-1) ?? null;
  const direct = at ? watch.get(at) : undefined;
  const watchGroups: Group[] = kids(at)
    .map((c) => ({ c, list: watched(c.id) }))
    .filter((z) => z.list.length)
    .sort(
      (x, y) =>
        y.list.filter((f) => f.flag.behind).length - x.list.filter((f) => f.flag.behind).length ||
        y.list.length - x.list.length,
    )
    .map(({ c, list }) => {
      const self = watch.get(c.id);
      const deeper = kids(c.id).length > 0;
      return {
        id: c.id,
        label: c.name,
        open: () => (deeper ? setPath([...path, c.id]) : onOpen({ kind: "node", id: c.id })),
        openLabel: deeper ? t.now.zoomIn(c.name) : undefined,
        head: (
          <>
            {self ? (
              <StateMark kind={self.flag.behind ? "behind" : "ahead"} />
            ) : (
              <span className="ns-ico">
                <TypeGlyph type={c.type} size={14} />
              </span>
            )}
            <span className="ns-name">{c.name}</span>
            <span className="ns-count">{counts(list)}</span>
          </>
        ),
        rows: list.filter((f) => f !== self).map(nodeRow),
      };
    });
  if (direct)
    watchGroups.unshift({
      id: `self:${at}`,
      label: direct.n.name,
      open: () => onOpen({ kind: "node", id: direct.n.id }),
      head: (
        <>
          <StateMark kind={direct.flag.behind ? "behind" : "ahead"} />
          <span className="ns-name">{direct.n.name}</span>
          <span className="ns-count is-long">{why(direct)}</span>
        </>
      ),
      rows: [],
    });

  // ---------- finished ----------
  const doneGroups: Group[] = (() => {
    const top = (n: SnapshotNode) => [n, ...graph.ancestors(n.id)].at(-1)!;
    const groups = new Map<string, SnapshotNode[]>();
    for (const n of done) {
      const key = top(n).id;
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    return [...groups].map(([id, list]) => ({
      id,
      label: graph.nodes.get(id)!.name,
      open: () => onOpen({ kind: "node", id }),
      head: (
        <>
          <span className="ns-ico">
            <TypeGlyph type={graph.nodes.get(id)!.type} size={14} />
          </span>
          <span className="ns-name">{graph.nodes.get(id)!.name}</span>
          <span className="ns-count">{list.length}</span>
        </>
      ),
      rows: list.map((n) => (
        <button
          key={n.id}
          type="button"
          className="ns-row"
          onClick={() => onOpen({ kind: "node", id: n.id })}
          title={n.name}
        >
          <span className="ns-ico">
            <TypeGlyph type={n.type} size={13} />
          </span>
          <span className="ns-text">{n.name}</span>
          <span className="ns-meta">{ago(n.outputAt)}</span>
        </button>
      )),
    }));
  })();

  const openLane = left && left !== "done" ? lanes.find((l) => l.id === left.lane) : undefined;
  const crumb = (label: string, onClick?: () => void) =>
    onClick ? (
      <button type="button" className="nl-crumb" onClick={onClick}>
        {label}
      </button>
    ) : (
      <span className="nl-crumb is-here">{label}</span>
    );

  return (
    <div className="now">
      <div className="now-top">
        <h1 className="now-title">{graph.snapshot.workspace.name}</h1>
        {known ? (
          <span className="now-sum">
            <span className="now-key is-behind">
              <i />
              {t.map.behindCount(behindN)}
            </span>
            <span className="now-key is-ahead">
              <i />
              {t.map.aheadCount(aheadN)}
            </span>
          </span>
        ) : (
          <span className="now-sum">{t.now.checking}</span>
        )}
      </div>

      <div className="now-main">
        <section className="nl-side" aria-label={t.now.lanes}>
          <h2 className="nl-path">
            {left ? crumb(t.now.lanes, () => setLeft(null)) : crumb(t.now.lanes)}
            {left === "done" && (
              <>
                <Icon name="chevron" size={12} />
                {crumb(since ? t.now.done : t.now.doneRecent)}
              </>
            )}
            {openLane && (
              <>
                <Icon name="chevron" size={12} />
                {crumb(openLane.title)}
              </>
            )}
            {!left && lanes.length > 0 && (
              <span className="nl-sum">
                {t.now.laneCounts(
                  lanes.reduce((s, l) => s + l.doing.length, 0),
                  lanes.reduce((s, l) => s + l.waiting.length, 0),
                  lanes.reduce((s, l) => s + l.review.length, 0),
                )}
              </span>
            )}
          </h2>
          {left === "done" ? (
            <List groups={doneGroups} empty={<p className="now-empty">{t.now.doneEmpty}</p>} />
          ) : openLane ? (
            <List groups={[laneGroup(openLane, true)]} />
          ) : (
            <List
              groups={busy.map((lane) => laneGroup(lane, false))}
              tail={
                idle.length > 0 && (
                  <p className="ns-foot">
                    <span>{t.now.idle}</span>
                    {idle.map((lane) => (
                      <button
                        key={lane.id}
                        type="button"
                        className="ns-chip has-pet"
                        onClick={() => onPage(lane.ref!)}
                        title={
                          lane.last ? `${t.now.lastDone} · ${cardTitle(lane.last)}` : undefined
                        }
                      >
                        <Pet id={lane.id} size={16} />
                        {lane.title}
                      </button>
                    ))}
                  </p>
                )
              }
              // "No Roles yet" only when there are none; idle Roles have their own line.
              empty={lanes.length === 0 && <p className="now-empty">{t.now.lanesEmpty}</p>}
            />
          )}
        </section>

        <section className="nl-side" aria-label={t.now.attention}>
          <h2 className="nl-path">
            {path.length ? crumb(t.now.attention, () => setPath([])) : crumb(t.now.attention)}
            {path.map((id, i) => (
              <span key={id} className="nl-step">
                <Icon name="chevron" size={12} />
                {crumb(
                  graph.nodes.get(id)?.name ?? id,
                  i < path.length - 1 ? () => setPath(path.slice(0, i + 1)) : undefined,
                )}
              </span>
            ))}
            {known && gaps.length > 0 && !path.length && (
              <span className="nl-sum">{t.now.gapsNote(gaps.length)}</span>
            )}
          </h2>
          {!known ? (
            <p className="now-empty">{t.now.checking}</p>
          ) : (
            <List
              groups={watchGroups}
              empty={
                <p className="now-calm">
                  <span className="now-dot" />
                  {t.now.calm}
                </p>
              }
            />
          )}
        </section>
      </div>

      <div className="now-done">
        <button
          type="button"
          className="nl-crumb"
          onClick={() => setLeft(left === "done" ? null : "done")}
          aria-expanded={left === "done"}
        >
          {since ? t.now.done : t.now.doneRecent}
          <b>{done.length}</b>
        </button>
        {since && <span className="now-since">{t.now.since(when(since))}</span>}
        <span className="now-done-row">
          {done.length === 0 ? (
            <span className="now-empty">{t.now.doneEmpty}</span>
          ) : (
            done.map((n) => (
              <button
                key={n.id}
                type="button"
                className="now-done-chip"
                onClick={() => onOpen({ kind: "node", id: n.id })}
              >
                <TypeGlyph type={n.type} size={12} />
                <span>{n.name}</span>
                <small>{ago(n.outputAt)}</small>
              </button>
            ))
          )}
        </span>
      </div>
    </div>
  );
}
