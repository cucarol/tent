import { useState } from "react";
import { cardTitle, primaryOf, type Graph } from "../data/store.js";
import { isDraft } from "../data/drafts.js";
import { UNREAD } from "../data/flags.js";
import type { SnapshotCard, SnapshotNode, SnapshotRef, SyncFlags } from "../data/types.js";
import { CardGlyph, Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { ago, readStored, when, writeStored } from "../util.js";
import { t } from "../i18n.js";

const DONE_SHOWN = 8;
/** A behind reason caused by a goal's own material changing, e.g. "Goal node-ab12cd: Material changed: /A/A.md". */
const GOAL_CHANGE = /^Goal ([^:\s]+): Material changed: /;

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
 * The home page: who is doing what, what was finished since the last visit, and what is behind or ahead.
 * It only shows what the Agents' work derived; nothing here waits on the person.
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
  const [allDone, setAllDone] = useState(false);
  const [openReviews, setOpenReviews] = useState<ReadonlySet<string>>(new Set());
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
  const goalOf = (n: SnapshotNode) =>
    [...graph.ancestors(n.id)].reverse().find((a) => primaryOf(a.type) === "goal");

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
        doing: cards.filter((c) => mine(c) && c.progress === "received-no-output"),
        // Old Cards whose goals changed later; listed one line per lane so they do not bury current work.
        review: cards.filter((c) => mine(c) && c.progress === "needs-review"),
        last: cards
          .filter((c) => mine(c) && c.progress === "has-output")
          .sort((a, b) => completedAt(b).localeCompare(completedAt(a)))[0],
      };
    })
    // The public area only shows while something waits there.
    .filter((lane) => lane.id || lane.waiting.length || lane.doing.length || lane.review.length);

  const flagged = Object.entries(flags).flatMap(([id, flag]) => {
    const n = graph.nodes.get(id);
    return n ? [{ n, flag }] : [];
  });
  const behind = flagged.filter((f) => f.flag.behind);
  const ahead = flagged.filter((f) => f.flag.ahead);
  // One goal edit makes the goal ahead and every output under it behind, down the whole goal chain.
  // List it once, on each changed goal, unless an output is also behind for another reason.
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
  const listed = [
    ...behind.filter((f) => f.flag.ahead || !folded(f.n, f.flag.behind!.reasons)),
    ...ahead.filter((f) => !f.flag.behind),
  ];

  const cardLink = (c: SnapshotCard) => (
    <button type="button" className="now-link" onClick={() => onPage({ kind: "card", id: c.id })}>
      <CardGlyph size={13} />
      <span>{cardTitle(c)}</span>
    </button>
  );

  return (
    <div className="now">
      <div className="now-grid">
        <div className="now-col">
          <section className="now-block" aria-labelledby="now-lanes">
            <h2 id="now-lanes" className="now-h">
              {t.now.lanes}
            </h2>
            {lanes.length === 0 && <p className="now-empty">{t.now.lanesEmpty}</p>}
            <ul className="now-list">
              {lanes.map((lane) => (
                <li key={lane.id || "public"} className="now-lane">
                  {lane.ref ? (
                    <button
                      type="button"
                      className="now-pet"
                      onClick={() => onPage(lane.ref!)}
                      aria-label={lane.title}
                    >
                      <Pet id={lane.id} size={26} />
                    </button>
                  ) : (
                    <span className="now-pet is-public">
                      <Icon name="public" size={14} />
                    </span>
                  )}
                  <div className="now-lane-body">
                    <div className="now-who">
                      {lane.title}
                      {lane.waiting.length > 0 && (
                        <span className="now-waiting">
                          <Icon name="mail" size={11} />
                          {t.now.waiting(lane.waiting.length)}
                        </span>
                      )}
                    </div>
                    {lane.waiting.map((c) => (
                      <div key={c.id} className="now-line">
                        {cardLink(c)}
                      </div>
                    ))}
                    {lane.doing.map((c) => (
                      <div key={c.id} className="now-line">
                        <span className="now-label">{t.now.doing}</span>
                        {cardLink(c)}
                        {c.totalGoalCount > 0 && (
                          <span
                            className="now-prog"
                            aria-label={t.now.progress(c.goalCount, c.totalGoalCount)}
                          >
                            <span className="now-track">
                              <i style={{ width: `${(100 * c.goalCount) / c.totalGoalCount}%` }} />
                            </span>
                            {c.goalCount}/{c.totalGoalCount}
                          </span>
                        )}
                      </div>
                    ))}
                    {lane.review.length > 0 && (
                      <div className="now-line">
                        <span className="now-label is-review">
                          {t.cardProgress["needs-review"]}
                        </span>
                        <button
                          type="button"
                          className="now-toggle"
                          aria-expanded={openReviews.has(lane.id)}
                          onClick={() =>
                            setOpenReviews((open) => {
                              const next = new Set(open);
                              if (!next.delete(lane.id)) next.add(lane.id);
                              return next;
                            })
                          }
                        >
                          {t.now.reviewCards(lane.review.length)}
                          <Icon name={openReviews.has(lane.id) ? "down" : "chevron"} size={12} />
                        </button>
                      </div>
                    )}
                    {openReviews.has(lane.id) &&
                      lane.review.map((c) => (
                        <div key={c.id} className="now-line is-nested">
                          {cardLink(c)}
                          <span className="now-meta">
                            {t.now.reviewOutputs(c.reviewOutputNodeIds?.length ?? 0)}
                          </span>
                        </div>
                      ))}
                    {!lane.waiting.length && !lane.doing.length && !lane.review.length && (
                      <div className="now-line">
                        <span className="now-label">{t.now.idle}</span>
                        {lane.last && (
                          <>
                            <span className="now-label is-soft">{t.now.lastDone}</span>
                            {cardLink(lane.last)}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="now-block is-done" aria-labelledby="now-done">
            <h2 id="now-done" className="now-h">
              {since ? t.now.done : t.now.doneRecent}
              <span className="now-n">{done.length}</span>
              {since && <span className="now-since">{t.now.since(when(since))}</span>}
            </h2>
            {done.length === 0 ? (
              <p className="now-empty">{t.now.doneEmpty}</p>
            ) : (
              <ul className="now-list">
                {done.slice(0, allDone ? undefined : DONE_SHOWN).map((n) => {
                  const goal = goalOf(n);
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="now-row"
                        onClick={() => onOpen({ kind: "node", id: n.id })}
                      >
                        <TypeGlyph type={n.type} size={14} />
                        <span className="now-row-name">
                          {n.name}
                          {goal && <small>{goal.name}</small>}
                        </span>
                        <span className="now-meta">{ago(n.outputAt)}</span>
                      </button>
                    </li>
                  );
                })}
                {!allDone && done.length > DONE_SHOWN && (
                  <li>
                    <button type="button" className="now-more" onClick={() => setAllDone(true)}>
                      {t.now.more(done.length - DONE_SHOWN)}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>

        <div className="now-col">
          <section className="now-block" aria-labelledby="now-attention">
            <h2 id="now-attention" className="now-h">
              {t.now.attention}
              {flags !== UNREAD && (
                <span className="now-n">
                  {t.map.behindCount(behind.length)} · {t.map.aheadCount(ahead.length)}
                </span>
              )}
            </h2>
            {flags === UNREAD ? (
              <p className="now-empty">{t.now.checking}</p>
            ) : flagged.length === 0 ? (
              <p className="now-calm">
                <span className="now-dot" />
                {t.now.calm}
              </p>
            ) : (
              <ul className="now-list">
                {listed.map(({ n, flag }) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="now-row"
                      onClick={() => onOpen({ kind: "node", id: n.id })}
                    >
                      <span
                        className={`now-sw${flag.behind ? " is-behind" : ""}${flag.ahead ? " is-ahead" : ""}`}
                      />
                      <span className="now-row-name">
                        {n.name}
                        <small>
                          {flag.behind
                            ? t.map.behindWhy(flag.behind.reasons)
                            : !reviewing.has(n.id)
                              ? t.map.aheadWhy(flag.ahead?.since ? ago(flag.ahead.since) : null)
                              : null}
                          {reviewing.has(n.id) && (
                            <>
                              {flag.behind && " · "}
                              {t.now.goalChanged(
                                flag.ahead?.since ? ago(flag.ahead.since) : null,
                                reviewing.get(n.id)!,
                              )}
                            </>
                          )}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
