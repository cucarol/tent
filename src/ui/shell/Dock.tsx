// The robots, at the right of the bar over the map: the busiest faces stacked with what all of them have
// in hand, opening down into a list with one row per Role and the public area. Nodes, a picked set or a
// whole region dropped on a row start a Card for it; Cards drag between rows until received. A drag that
// rests on the stack opens the list. Rules: Tent Node "UI-图谱画模块依赖与状态", "分工搬进图谱" (cuca
// 2026-10-16) and "Role 列表放顶栏：头像叠加竖排列表" (cuca 2026-10-17).
import { useWantDetails } from "../data/details.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Graph } from "../data/store.js";
import type { SnapshotCard, SnapshotRef } from "../data/types.js";
import { isDraft, editDraft, useDraft, type Draft } from "../data/drafts.js";
import { cardStateLabel } from "../data/card-state.js";
import { Icon, TypeGlyph } from "../components/Glyph.js";
import { Tray, Pet } from "../components/Pet.js";
import { t } from "../i18n.js";
import { ago, readStored, writeStored } from "../util.js";
import { beginDrag, useDragState } from "./drag.js";
import { moodOf, PUBLIC, sourceIds, type Desk, type Work } from "./work.js";

type Props = {
  graph: Graph;
  selected: SnapshotRef | null;
  work: Work;
  /** The open draft is on the page, so its row shows it folded. */
  draftOnPage: boolean;
  /** The robot the pointer rests on, or else the one clicked to keep it lit. */
  hotLane: string | null;
  pinned: string | null;
  onHot: (lane: string | null) => void;
  onPin: (lane: string | null) => void;
  onOpen: (ref: SnapshotRef) => void;
  onPage: (ref: SnapshotRef) => void;
};

/** Whether a robot has anything in hand. */
const busy = (d: Desk) => d.doing + d.waiting + d.returned + d.drafts > 0;
/** Past this many rows the list offers a filter. */
const FILTER_FROM = 8;

/**
 * What a robot has in hand, as counts on its row: only those it has, so they fit beside the face; with
 * nothing in hand, a quiet "0 waiting". The folded chip's tooltip keeps every count.
 */
function Tally({ desk, role }: { desk: Desk; role: boolean }) {
  const parts = [
    role && desk.doing > 0 && (
      <span key="doing" className="is-doing">
        {t.work.doingN(desk.doing)}
      </span>
    ),
    desk.waiting > 0 && (
      <span key="waiting" className="is-waiting">
        {t.work.waitingN(desk.waiting)}
      </span>
    ),
    role && desk.returned > 0 && (
      <span key="returned" className="is-returned">
        {t.work.returnedN(desk.returned)}
      </span>
    ),
    desk.drafts > 0 && (
      <span key="drafts" className="is-draft">
        {t.work.draftsN(desk.drafts)}
      </span>
    ),
  ].filter(Boolean);
  return (
    <span className="tally">
      {parts.length ? parts : <span className="is-zero">{t.work.waitingN(0)}</span>}
    </span>
  );
}

export function Dock(props: Props) {
  const { graph, work } = props;
  const [lanesOpen, setLanesOpen] = useState<string[]>(() => readStored("tent-lanes-open", []));
  const [open, setOpen] = useState(() => readStored("tent-roles-open", false));
  const show = (next: boolean) => {
    setOpen(next);
    writeStored("tent-roles-open", next);
  };
  const [filter, setFilter] = useState("");
  // Roles and Cards come with the snapshot: an open list reads it, and so does opening one.
  const want = useWantDetails(open && !graph.detailed);
  const toggleLane = (lane: string) =>
    setLanesOpen((l) => {
      const next = l.includes(lane) ? l.filter((x) => x !== lane) : [...l, lane];
      writeStored("tent-lanes-open", next);
      return next;
    });
  // A draft being written, or a row something was just dropped on, is shown open.
  const openDraftCard = work.openDraft ? graph.cards.get(work.openDraft) : undefined;
  const draftLane = openDraftCard ? work.laneOf(openDraftCard) : null;
  const laneShown = (lane: string) => lanesOpen.includes(lane) || draftLane === lane;
  const landed = work.landed;
  const [seenLanding, setSeenLanding] = useState<number | null>(null);
  if (landed && landed.at !== seenLanding) {
    setSeenLanding(landed.at);
    if (!lanesOpen.includes(landed.lane)) toggleLane(landed.lane);
  }

  // A drag resting on the stack opens the list, so it can be let go on a row.
  const drag = useDragState();
  const stack = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drag || open) return;
    const r = stack.current?.getBoundingClientRect();
    if (!r || drag.x < r.left || drag.x > r.right || drag.y < r.top || drag.y > r.bottom) return;
    const wait = setTimeout(() => {
      setOpen(true);
      want();
    }, 350);
    return () => clearTimeout(wait);
  }, [drag, open]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      const at = e.target as HTMLElement;
      if (e.key !== "Escape" || at.closest("input, textarea") || !at.closest(".roles")) return;
      show(false);
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open]);

  const writing = work.lanes
    .flatMap((lane) => work.laneCards(lane))
    .find((c) => c.id === work.openDraft);
  const writingSources = writing ? (work.draft?.input.sources.length ?? writing.sources.length) : 0;
  // Robots with something in hand first, each group in its own order.
  const lanes = [...work.lanes].sort((a, b) => +busy(work.desk(b)) - +busy(work.desk(a)));
  const roles = work.lanes.filter((l) => l !== PUBLIC).length;
  const sum = (k: keyof Desk) => work.lanes.reduce((n, l) => n + work.desk(l)[k], 0);
  const doing = sum("doing"),
    waiting = sum("waiting") + sum("returned");
  const q = filter.trim().toLowerCase();
  const listed = q ? lanes.filter((l) => work.laneName(l).toLowerCase().includes(q)) : lanes;

  if (!graph.detailed)
    return (
      <div className="roles">
        <button
          ref={stack}
          type="button"
          className={`role-stack${open ? " is-reading" : ""}`}
          aria-label={t.work.title}
          data-tip={open ? undefined : t.work.loadTip}
          data-tip-end=""
          onClick={() => show(true)}
        >
          {open ? t.work.reading : t.work.load}
        </button>
      </div>
    );

  return (
    <div className="roles">
      {writing && !open && (
        <DraftChip card={writing} work={work} sources={writingSources} onOpen={() => show(true)} />
      )}
      <button
        ref={stack}
        type="button"
        className={`role-stack${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-label={t.work.title}
        data-tip={open ? undefined : t.work.stackTip}
        data-tip-end=""
        onClick={() => show(!open)}
      >
        <span className="role-faces">
          {lanes.slice(0, 3).map((lane) => (
            <span key={lane || "public"} className="role-face">
              {lane === PUBLIC ? (
                <Tray size={17} />
              ) : (
                <Pet id={lane} size={17} mood={moodOf(work.desk(lane), work.gone(lane))} />
              )}
            </span>
          ))}
        </span>
        <span className="role-sum">
          {t.work.roles(roles)}
          {doing > 0 && <span className="is-doing"> · {t.work.doingN(doing)}</span>}
          {waiting > 0 && <span> · {t.work.waitingN(waiting)}</span>}
        </span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <section className="dock panel" aria-label={t.work.title}>
          <div className="dock-head">
            <span className="dock-title">{t.work.title}</span>
            <button
              type="button"
              className="add"
              onClick={() => void work.newCard(null)}
              aria-label={t.side.newCard}
              data-tip={t.work.newTip}
              data-key="C"
            >
              <Icon name="addToCard" size={14} />
              {t.side.newCard}
            </button>
            <button
              type="button"
              className="icon-btn dock-fold"
              onClick={() => show(false)}
              aria-label={t.work.foldAll}
              data-tip={t.work.foldAll}
              data-key="Esc"
              data-tip-end=""
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          {lanes.length > FILTER_FROM && (
            <input
              className="dock-filter"
              type="search"
              value={filter}
              placeholder={t.work.filter}
              aria-label={t.work.filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <div className="dock-rows">
            {listed.map((lane) => (
              <Lane
                key={lane || "public"}
                {...props}
                lane={lane}
                idle={!busy(work.desk(lane)) && draftLane !== lane}
                shown={laneShown(lane)}
                onToggle={() => {
                  // Folding the row of the draft being written puts the draft away.
                  if (laneShown(lane) && draftLane === lane) work.setOpenDraft(null);
                  if (lanesOpen.includes(lane) || draftLane !== lane) toggleLane(lane);
                }}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** A robot's row: its face, name and counts; opened, the Cards on their way to it and the draft. */
function Lane({
  graph,
  selected,
  work,
  lane,
  idle,
  shown,
  draftOnPage,
  hotLane,
  pinned,
  onToggle,
  onHot,
  onPin,
  onPage,
}: Props & {
  lane: string;
  /** Nothing in hand: the row stays quieter. */
  idle: boolean;
  shown: boolean;
  onToggle: () => void;
}) {
  const drag = useDragState();
  const cards = work.laneCards(lane);
  const returned = work.laneReturned(lane);
  const over = drag?.over === `lane:${lane}`;
  const name = work.laneName(lane);
  const viewing = selected?.kind === "card" ? graph.cards.get(selected.id) : undefined;
  const hint = drag ? laneHint(work, drag.item, lane) : "";
  const cls = [
    "lane",
    idle ? "is-idle" : "",
    over ? "is-over" : "",
    hotLane === lane ? "is-hot" : "",
    selected?.kind === "role" && selected.id === lane ? "is-active" : "",
    viewing && lane !== PUBLIC && work.laneOf(viewing) === lane ? "is-linked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} data-drop={`lane:${lane}`} data-lane={lane}>
      <div
        className="lane-head"
        onPointerEnter={() => !drag && onHot(lane)}
        onPointerLeave={() => onHot(null)}
      >
        <button
          type="button"
          className="who"
          onClick={() => onPin(pinned === lane ? null : lane)}
          aria-pressed={pinned === lane}
          title={pinned === lane ? t.work.unpin : t.work.pin(name)}
        >
          {lane === PUBLIC ? (
            <span className="face">
              <Tray size={30} />
            </span>
          ) : (
            <span className="face">
              <Pet id={lane} size={30} mood={moodOf(work.desk(lane), work.gone(lane))} />
            </span>
          )}
          <Who name={name} hint={over ? hint : null}>
            <Tally desk={work.desk(lane)} role={lane !== PUBLIC} />
          </Who>
        </button>
        <span className="lane-acts">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void work.newCard(lane === PUBLIC ? null : lane)}
            aria-label={t.work.writeFor(lane === PUBLIC ? null : name)}
            title={t.work.writeFor(lane === PUBLIC ? null : name)}
          >
            <Icon name="addToCard" size={14} />
          </button>
          {lane !== PUBLIC && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => onPage({ kind: "role", id: lane })}
              aria-label={t.work.openRole(name)}
              title={t.work.openRole(name)}
            >
              <Icon name="expand" size={14} />
            </button>
          )}
        </span>
        <button
          type="button"
          className={`icon-btn chev${shown ? " is-open" : ""}`}
          onClick={onToggle}
          aria-label={shown ? t.work.fold : t.work.unfold}
          aria-expanded={shown}
        >
          <Icon name="chevron" size={14} />
        </button>
      </div>
      {shown && (
        <div className="lane-body">
          {cards.map((c) =>
            c.id === work.openDraft && !draftOnPage ? (
              <DraftBox key={c.id} graph={graph} card={c} work={work} onPage={onPage} />
            ) : (
              <Letter
                key={c.id}
                card={c}
                work={work}
                active={selected?.kind === "card" && selected.id === c.id}
                onClick={() =>
                  isDraft(c) ? work.setOpenDraft(c.id) : onPage({ kind: "card", id: c.id })
                }
              />
            ),
          )}
          {returned.map((c) => (
            <Letter
              key={c.id}
              card={c}
              work={work}
              active={selected?.kind === "card" && selected.id === c.id}
              onClick={() => onPage({ kind: "card", id: c.id })}
            />
          ))}
          {!cards.length && !returned.length && (
            <div className="lane-empty">
              {lane === PUBLIC ? (
                <Tray size={26} empty />
              ) : (
                <Pet id={lane} size={26} className="faint" />
              )}
              {lane === PUBLIC ? t.work.emptyPublic : t.work.emptyRole(name)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A row's name, and under it the counts, or what letting go here does. */
function Who({ name, hint, children }: { name: string; hint: string | null; children: ReactNode }) {
  return (
    <span className="who-text">
      <span className="n">{name}</span>
      {hint ? (
        <span className="hint">
          <Icon name="drop" size={12} />
          {hint}
        </span>
      ) : (
        children
      )}
    </span>
  );
}

/** What letting go of Nodes or a Card over a robot does. */
function laneHint(work: Work, item: { kind: "node" | "card"; ids?: string[] }, lane: string) {
  const name = work.laneName(lane);
  const n = item.ids?.length ?? 1;
  return item.kind === "node"
    ? lane === PUBLIC
      ? t.work.dropNew(n)
      : t.work.dropFor(name, n)
    : lane === PUBLIC
      ? t.work.dropPublic
      : t.work.dropTo(name);
}

/** The draft being written, while the list is closed: a pencil and its number of sources. Takes Nodes. */
function DraftChip({
  card,
  work,
  sources,
  onOpen,
}: {
  card: SnapshotCard;
  work: Work;
  sources: number;
  onOpen: () => void;
}) {
  const drag = useDragState();
  const over = drag?.item.kind === "node" && drag.over === `card:${card.id}`;
  return (
    <button
      type="button"
      className={`draft-chip${over ? " is-over" : ""}`}
      data-drop={`card:${card.id}`}
      data-hint={over ? t.work.dropSource(sources + 1) : undefined}
      data-tip={t.work.chipTip(t.work.draft, work.title(card))}
      aria-label={t.work.chipTip(t.work.draft, work.title(card))}
      onClick={onOpen}
    >
      <Icon name={over ? "drop" : "draft"} size={13} />
      {over ? sources + 1 : sources}
    </button>
  );
}

/**
 * A Card in a lane: a dashed draft or a published Card waiting for its Role, which both drag to other lanes,
 * or a result returned to this Role, with its line under the title.
 */
export function Letter({
  card,
  work,
  active,
  onClick,
}: {
  card: SnapshotCard;
  work: Work;
  active?: boolean;
  onClick: () => void;
}) {
  const drag = useDragState();
  const draft = isDraft(card);
  const back = card.state === "returned";
  const over = draft && drag?.over === `card:${card.id}`;
  const lifted = drag?.item.kind === "card" && drag.item.id === card.id;
  // A published Card still waiting has a place in its queue; another one let go on it goes before or after.
  const queued = !draft && !back && card.state === "pending" && !card.receivedBy;
  const at = queued && drag?.over?.startsWith(`at:${card.id}:`) ? drag.over.slice(-6) : "";
  // The draft being written counts what is on screen; others count what is saved.
  const sources =
    card.id === work.openDraft && work.draft
      ? work.draft.input.sources.length
      : card.sources.length;
  const meta = draft
    ? `${t.work.draft}${sources ? ` · ${sources}` : ""}`
    : back
      ? `${t.work.toCollect} · ${ago(card.updatedAt)}`
      : `${cardStateLabel(card)} · ${ago(card.publishedAt)}`;
  return (
    <div
      className={`letter ${draft ? "is-draft" : back ? "is-back" : "is-pub"}${over ? " is-over" : ""}${lifted ? " is-lifted" : ""}${active ? " is-active" : ""}${at === "before" ? " is-before" : at ? " is-after" : ""}`}
      data-drop={draft ? `card:${card.id}` : queued ? `at:${card.id}` : undefined}
      data-drop-split={queued ? "" : undefined}
      role="button"
      tabIndex={0}
      title={draft ? t.work.letterDraft : back ? t.work.letterBack : t.work.letterPub}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick();
      }}
      onPointerDown={back ? undefined : (e) => beginDrag(e, { kind: "card", id: card.id })}
    >
      <Icon name={over ? "drop" : draft ? "draft" : back ? "returned" : "mail"} size={14} />
      <span className="t">{over ? t.work.dropIntoDraft : work.title(card)}</span>
      <span className="m">{over ? t.work.nth(sources + 1) : meta}</span>
      {back && card.result && <span className="r">{work.resultText(card.result)}</span>}
    </div>
  );
}

/** The draft being written, open in its lane: sources in order, what to do, and publish. */
function DraftBox({
  graph,
  card,
  work,
  onPage,
}: {
  graph: Graph;
  card: SnapshotCard;
  work: Work;
  onPage: (ref: SnapshotRef) => void;
}) {
  const drag = useDragState();
  const draft = useDraft(card.id);
  const over = drag?.over === `card:${card.id}` && drag.item.kind === "node";
  const ids = sourceIds(graph, card, draft);
  const sources = draft?.input.sources ?? card.sources.map((s) => ({ resource: s.resource }));
  const lifted = drag?.item.kind === "card" && drag.item.id === card.id;
  return (
    <div
      className={`draft${over ? " is-over" : ""}${lifted ? " is-lifted" : ""}`}
      data-drop={`card:${card.id}`}
    >
      <div
        className="draft-head"
        title={t.work.grab}
        onPointerDown={(e) => beginDrag(e, { kind: "card", id: card.id })}
      >
        <Icon name="draft" size={15} />
        <b>{t.work.draft}</b>
        <span className="muted">{t.work.sources(sources.length)}</span>
        <span className="grab">
          <Icon name="grip" size={14} />
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onPage({ kind: "card", id: card.id })}
          aria-label={t.work.expand}
          title={t.work.expand}
        >
          <Icon name="expand" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => work.setOpenDraft(null)}
          aria-label={t.work.fold}
          title={t.work.fold}
        >
          <Icon name="down" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void work.discard(card.id)}
          disabled={work.publishing === card.id}
          aria-label={t.work.discard}
          title={t.work.discard}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <ol className="srcs">
        {sources.map((s, i) => {
          const id = ids[i];
          const node = id ? graph.nodes.get(id) : undefined;
          const role = id ? graph.roles.get(id) : undefined;
          return (
            <li key={`${s.resource}:${i}`} className="src">
              <span className="num">{i + 1}</span>
              {node ? (
                <TypeGlyph type={node.type} size={13} />
              ) : role ? (
                <Pet id={role.id} size={14} />
              ) : (
                <Icon name="text" size={13} />
              )}
              <span className="t" title={s.resource}>
                {node?.name ?? role?.title ?? s.resource}
              </span>
              {draft && (
                <button
                  type="button"
                  className="x"
                  disabled={work.publishing === card.id}
                  onClick={() =>
                    editDraft(card.id, (input) => ({
                      ...input,
                      sources: input.sources.filter((_, k) => k !== i),
                    }))
                  }
                  aria-label={t.work.takeOut}
                  title={t.work.takeOut}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </li>
          );
        })}
        <li className={`slot${over ? " is-on" : ""}`}>
          {over ? (
            <>
              <Icon name="drop" size={13} />
              {t.work.dropSource(sources.length + 1)}
            </>
          ) : (
            <>
              {sources.length ? t.work.slotMore : t.work.slotFirst}
              <Icon name="addToCard" size={13} />
            </>
          )}
        </li>
      </ol>
      <textarea
        className="what"
        rows={3}
        value={draft?.input.prompt ?? card.body}
        disabled={!draft || work.publishing === card.id}
        placeholder={t.work.placeholder}
        aria-label={t.work.what}
        onChange={(e) => {
          const prompt = e.target.value;
          editDraft(card.id, (input) => ({ ...input, prompt }));
        }}
      />
      <ReturnSelect work={work} card={card} draft={draft} />
      <div className="draft-foot">
        <span className="saved">{saveState(draft)}</span>
        <button
          type="button"
          className="publish"
          onClick={() => void work.publish(card.id)}
          disabled={!draft || work.publishing === card.id}
          title={t.work.publishTip}
        >
          <Icon name="send" size={14} />
          {work.publishing === card.id ? t.work.publishing : t.work.publish}
        </button>
      </div>
    </div>
  );
}

/** Who the draft's result comes back to, or nobody; the lane it is going to is not offered. */
function ReturnSelect({
  work,
  card,
  draft,
}: {
  work: Work;
  card: SnapshotCard;
  draft: Draft | null;
}) {
  return (
    <label className="return-pick" title={t.work.returnTip}>
      <Icon name="returned" size={13} />
      <span>{t.work.returnTo}</span>
      <select
        value={draft?.input.returnTo ?? ""}
        disabled={!draft || work.publishing === card.id}
        onChange={(e) => work.setReturn(card.id, e.target.value || null)}
      >
        <option value="">{t.work.noReturn}</option>
        {work.returnChoices(card).map((r) => (
          <option key={r.id} value={r.id}>
            {r.title}
          </option>
        ))}
      </select>
    </label>
  );
}

export function saveState(draft: ReturnType<typeof useDraft>) {
  if (!draft) return t.work.loading;
  if (draft.failed) return t.work.localOnly;
  return t.work.saved;
}
