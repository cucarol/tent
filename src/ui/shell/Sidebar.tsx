import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, describe, type KnownWorkspace } from "../data/api.js";
import type { Graph } from "../data/store.js";
import type { SnapshotCard, SnapshotNode, SnapshotRef } from "../data/types.js";
import { isDraft, editDraft, flushDrafts, useDraft } from "../data/drafts.js";
import { hasUnsavedNodeDrafts } from "../data/node-drafts.js";
import { Icon, TypeGlyph, TypeTile } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { t, type Lang } from "../i18n.js";
import { ago, pathTail, readStored, when, writeStored } from "../util.js";
import { beginDrag, useDragState } from "./drag.js";
import { carried, PUBLIC, sourceIds, type Work } from "./work.js";

export type ThemePref = "light" | "dark" | "system";

type Props = {
  graph: Graph;
  selected: SnapshotRef | null;
  open: boolean;
  /** Folded Nodes, shared with the map. */
  collapsed: ReadonlySet<string>;
  work: Work;
  /** The open draft is on the page, so its lane shows it folded. */
  draftOnPage: boolean;
  themePref: ThemePref;
  lang: Lang;
  onTheme: (pref: ThemePref) => void;
  onLang: (lang: Lang) => void;
  onFold: (id: string) => void;
  onOpen: (ref: SnapshotRef) => void;
  /** Open a Role or Card as a page. */
  onPage: (ref: SnapshotRef) => void;
  onLocate: (ref: SnapshotRef) => void;
  onSearch: () => void;
  onToggle: () => void;
  /** Drag on the sidebar's edge: resize, or pull past the end to fold to the rail and back. */
  onResize: (e: React.PointerEvent) => void;
  onResetWidth: () => void;
  onMarkAllSeen: () => void;
  /** The lane the pointer rests on in 分工; the tree and the map mark what its Cards carried. */
  hotLane: string | null;
  onHotLane: (lane: string | null) => void;
};

/** How long a pointer rests on a row before its preview opens. */
const PEEK_DELAY = 650;

/**
 * Left column, on the window frame. Above, the Node tree (目录); below, 分工: the public area and one lane
 * per Role, holding the Cards on their way. Nodes go into Cards as sources and Cards go to Roles, by
 * dragging or with the row buttons.
 */
export function Sidebar(props: Props) {
  const { graph, open, work, onSearch, onToggle } = props;
  const drag = useDragState();
  const { hotLane, onHotLane: setHotLane } = props;
  const [peek, setPeek] = useState<{ id: string; top: number } | null>(null);
  const [lanesOpen, setLanesOpen] = useState<string[]>(() =>
    readStored("tent-lanes-open", [PUBLIC]),
  );
  // 分工 folds down to a row of faces, leaving the tree the room; they still take drops.
  const [folded, setFolded] = useState(() => readStored("tent-dock-folded", false));
  const fold = (next: boolean) => {
    setFolded(next);
    writeStored("tent-dock-folded", next);
  };
  const toggleLane = (lane: string) =>
    setLanesOpen((l) => {
      const next = l.includes(lane) ? l.filter((x) => x !== lane) : [...l, lane];
      writeStored("tent-lanes-open", next);
      return next;
    });
  // A draft being written, or a lane something was just dropped into, is shown open.
  const openDraftCard = work.openDraft ? graph.cards.get(work.openDraft) : undefined;
  const draftLane = openDraftCard ? work.laneOf(openDraftCard) : null;
  const laneShown = (lane: string) => lanesOpen.includes(lane) || draftLane === lane;
  useEffect(() => {
    if (drag) setPeek(null);
  }, [!!drag]);
  // A lane something was just put in opens to show it.
  useEffect(() => {
    const lane = work.landed?.lane;
    if (lane !== undefined && !lanesOpen.includes(lane)) toggleLane(lane);
  }, [work.landed]);

  const inLanes = work.lanes.flatMap((lane) => work.laneCards(lane));
  const waitingAll = inLanes.filter((c) => !isDraft(c)).length;
  const draftsAll = inLanes.length - waitingAll;
  const writing = inLanes.find((c) => c.id === work.openDraft);
  const writingSources = writing ? (work.draft?.input.sources.length ?? writing.sources.length) : 0;
  // Folded, the one row has no room to say what a drop does; a line under it says it while dragging.
  const overLane = drag?.over?.startsWith("lane:") ? drag.over.slice(5) : null;
  const foldHint =
    writing && drag?.item.kind === "node" && drag.over === `card:${writing.id}`
      ? t.work.dropSource(writingSources + 1)
      : overLane === null
        ? null
        : laneHint(work, drag!.item.kind, overLane);
  // A lane's face, in the folded row or on the rail; a Role's face on the rail opens its page.
  const chip = (lane: string, rail: boolean) => (
    <LaneChip
      key={lane || "public"}
      work={work}
      lane={lane}
      onHot={setHotLane}
      onOpen={() => {
        if (rail && lane !== PUBLIC) return props.onPage({ kind: "role", id: lane });
        if (rail) onToggle();
        fold(false);
        if (!lanesOpen.includes(lane)) toggleLane(lane);
      }}
    />
  );
  const edge = (label: string) => (
    <div
      className="side-resize"
      onPointerDown={props.onResize}
      onDoubleClick={props.onResetWidth}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
    />
  );
  const settings = (
    <Settings
      themePref={props.themePref}
      lang={props.lang}
      onTheme={props.onTheme}
      onLang={props.onLang}
    />
  );
  if (!open) {
    return (
      <nav className={`sidebar is-rail${drag ? " is-dragging" : ""}`} aria-label={t.side.nav}>
        <button
          type="button"
          className="icon-btn rail-open"
          onClick={onToggle}
          aria-label={t.side.expand}
          data-tip={t.side.expand}
          data-key={"Ctrl \\"}
        >
          <Icon name="sidebar" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onSearch}
          aria-label={t.side.search}
          data-tip={t.side.search}
          data-key="Ctrl K"
        >
          <Icon name="search" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn accent"
          onClick={() => void work.newCard(null)}
          aria-label={t.side.newCard}
          data-tip={t.side.newCard}
          data-key="C"
        >
          <Icon name="addToCard" size={16} />
        </button>
        <div className="rail-lanes" aria-label={t.work.title}>
          {writing && (
            <DraftChip
              card={writing}
              work={work}
              sources={writingSources}
              onOpen={() => props.onOpen({ kind: "card", id: writing.id })}
            />
          )}
          {work.lanes.map((lane) => chip(lane, true))}
        </div>
        <span className="rail-fill" />
        {settings}
        {edge(t.app.openSide)}
      </nav>
    );
  }

  const latest = graph.snapshot.commits[0];
  return (
    <nav className={`sidebar${drag ? " is-dragging" : ""}`} aria-label={t.side.nav}>
      <div className="side-head">
        <Workspaces name={graph.snapshot.workspace.name} />
        <button
          type="button"
          className="icon-btn"
          onClick={onSearch}
          aria-label={t.side.search}
          data-tip={t.side.search}
          data-key="Ctrl K"
        >
          <Icon name="search" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-label={t.side.collapse}
          data-tip={t.side.collapse}
          data-key={"Ctrl \\"}
        >
          <Icon name="sidebar" size={16} />
        </button>
      </div>

      <Tree {...props} hotLane={hotLane} onPeek={setPeek} peeking={peek?.id ?? null} />

      <section className={`dock${folded ? " is-folded" : ""}`} aria-label={t.work.title}>
        <div className="dock-head">
          <button
            type="button"
            className={`fold${folded ? "" : " is-open"}`}
            onClick={() => fold(!folded)}
            aria-expanded={!folded}
            data-tip={
              folded
                ? [t.work.unfoldAll, t.work.foldedSum(waitingAll, draftsAll)]
                    .filter(Boolean)
                    .join(" · ")
                : t.work.foldAll
            }
          >
            <Icon name="chevron" size={13} />
            {t.work.title}
          </button>
          {folded && (
            <div className="lane-chips">
              {writing && (
                <DraftChip
                  card={writing}
                  work={work}
                  sources={writingSources}
                  onOpen={() => fold(false)}
                />
              )}
              {work.lanes.map((lane) => chip(lane, false))}
            </div>
          )}
          <button
            type="button"
            className={`add${folded ? " is-small" : ""}`}
            onClick={() => void work.newCard(null)}
            aria-label={t.side.newCard}
            data-tip={folded ? t.side.newCard : t.work.newTip}
            data-key="C"
            data-tip-end=""
          >
            <Icon name="addToCard" size={14} />
            {!folded && t.side.newCard}
          </button>
        </div>
        {folded
          ? foldHint && (
              <div className="fold-hint">
                <Icon name="drop" size={13} />
                {foldHint}
              </div>
            )
          : work.lanes.map((lane) => (
              <Lane
                key={lane || "public"}
                {...props}
                lane={lane}
                shown={laneShown(lane)}
                onToggle={() => {
                  // Folding the lane of the draft being written puts the draft away.
                  if (laneShown(lane) && draftLane === lane) work.setOpenDraft(null);
                  if (lanesOpen.includes(lane) || draftLane !== lane) toggleLane(lane);
                }}
                onHot={setHotLane}
              />
            ))}
      </section>

      <div className="side-foot">
        {settings}
        <span className="muted" title={latest?.hash}>
          {t.side.lastCommit(when(latest?.date))}
        </span>
      </div>
      {peek && !drag && <Peek graph={graph} work={work} id={peek.id} top={peek.top} />}
      {edge(t.app.resizeSide)}
    </nav>
  );
}

/** The Node tree. Marks at the end of a row tie it to the draft being written, the open Card or a Role. */
function Tree({
  graph,
  selected,
  collapsed,
  work,
  hotLane,
  peeking,
  onPeek,
  onFold,
  onOpen,
  onLocate,
  onMarkAllSeen,
}: Props & {
  hotLane: string | null;
  peeking: string | null;
  onPeek: (p: { id: string; top: number } | null) => void;
}) {
  const drag = useDragState();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const openCard = work.openDraft ? graph.cards.get(work.openDraft) : undefined;
  const inDraft = work.openDraft ? sourceIds(graph, openCard, work.draft) : [];
  // The published Card on the page: its sources in order, and which changed after it was sent.
  const card =
    selected?.kind === "card" &&
    graph.cards.get(selected.id) &&
    !isDraft(graph.cards.get(selected.id)!)
      ? graph.cards.get(selected.id)!
      : undefined;
  const refs = new Map(
    (card?.sources ?? []).flatMap((s, i) =>
      s.id ? [[s.id, { n: i + 1, changed: s.changedSince }]] : [],
    ),
  );
  // Hovering a lane: the Nodes its Cards carried (the Role's received Cards included).
  const used = hotLane === null ? null : carried(graph, work.laneOf, hotLane);
  const path = new Set(
    selected?.kind === "node"
      ? [...graph.ancestors(selected.id).map((a) => a.id), selected.id]
      : [],
  );
  const fresh = graph.snapshot.nodes.filter((n) => graph.states.get(n.id)?.recent).length;
  const hides = (n: SnapshotNode, set: Set<string>): boolean =>
    graph.childrenOf(n.id).some((k) => set.has(k.id) || hides(k, set));

  const rows: ReactNode[] = [];
  const walk = (n: SnapshotNode, depth: number) => {
    const kids = graph.childrenOf(n.id);
    const folded = kids.length > 0 && collapsed.has(n.id);
    const state = graph.states.get(n.id)!;
    const at = inDraft.indexOf(n.id);
    const ref = refs.get(n.id);
    const marks: ReactNode[] = [];
    if (at >= 0)
      marks.push(
        <span key="draft" className="num" title={t.side.draftSource(at + 1)}>
          {at + 1}
        </span>,
      );
    if (ref) {
      if (ref.changed)
        marks.push(
          <span key="changed" className="changed" title={t.side.changedSince}>
            <Icon name="clock" size={12} />
            {t.side.changed}
          </span>,
        );
      marks.push(
        <span key="ref" className="num ref" title={t.side.cardSource(ref.n)}>
          {ref.n}
        </span>,
      );
    }
    const carries = used?.has(n.id);
    const inside = !!used && !carries && folded && hides(n, used);
    if (hotLane && (carries || inside))
      marks.push(
        hotLane === PUBLIC ? (
          <Icon key="face" name="public" size={14} />
        ) : (
          <Pet key="face" id={hotLane} size={14} className={inside ? "faint" : undefined} />
        ),
      );
    const active = selected?.kind === "node" && selected.id === n.id;
    const lifted = drag?.item.kind === "node" && drag.item.id === n.id;
    const cls = [
      "row",
      depth ? "" : "is-top",
      active ? "is-active" : path.has(n.id) ? "is-trail" : "",
      state.deprecated ? "is-deprecated" : "",
      used && !carries && !inside ? "is-dim" : "",
      lifted ? "is-lifted" : "",
      peeking === n.id ? "is-peek" : "",
    ]
      .filter(Boolean)
      .join(" ");
    rows.push(
      <div
        key={n.id}
        className={cls}
        style={{ "--d": depth } as React.CSSProperties}
        role="treeitem"
        tabIndex={0}
        aria-selected={active}
        aria-expanded={kids.length ? !folded : undefined}
        onClick={() => onOpen({ kind: "node", id: n.id })}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen({ kind: "node", id: n.id });
        }}
        onPointerDown={(e) => beginDrag(e, { kind: "node", id: n.id })}
        onPointerEnter={(e) => {
          clearTimeout(timer.current);
          const top = e.currentTarget.getBoundingClientRect().top;
          timer.current = setTimeout(() => onPeek({ id: n.id, top }), PEEK_DELAY);
        }}
        onPointerLeave={() => {
          clearTimeout(timer.current);
          onPeek(null);
        }}
      >
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="guide" style={{ left: 14.5 + i * 14 }} />
        ))}
        {kids.length > 0 && (
          <button
            type="button"
            className="chev"
            aria-label={t.side.fold(n.name)}
            onClick={(e) => {
              e.stopPropagation();
              onFold(n.id);
            }}
          >
            <Icon name="chevron" size={13} />
          </button>
        )}
        <span className="t">{n.name}</span>
        {state.recent && !marks.length && !active && (
          <i className="new-dot" title={t.node.recent} />
        )}
        {folded && !marks.length && <span className="more">{descendants(graph, n.id)}</span>}
        {marks.length > 0 && <span className="marks">{marks}</span>}
        <span className="acts">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLocate({ kind: "node", id: n.id });
            }}
            aria-label={t.side.locate}
            data-tip={t.side.locate}
            data-tip-end=""
          >
            <Icon name="locate" size={14} />
          </button>
          <button
            type="button"
            className={at >= 0 ? "is-in" : ""}
            disabled={!!work.openDraft && work.publishing === work.openDraft}
            onClick={(e) => {
              e.stopPropagation();
              work.attach(n.id);
            }}
            aria-label={at >= 0 ? t.side.inDraft : t.side.attach}
            data-tip={at >= 0 ? t.side.inDraft : t.side.attach}
            data-tip-end=""
          >
            <Icon name={at >= 0 ? "check" : "addToCard"} size={14} />
          </button>
        </span>
      </div>,
    );
    if (!folded) kids.forEach((k) => walk(k, depth + 1));
  };
  graph.childrenOf(null).forEach((n) => walk(n, 0));

  const context = card
    ? t.side.cardSources(refs.size)
    : hotLane !== null
      ? t.side.carriedBy(work.laneName(hotLane))
      : null;
  return (
    <div className="tree" role="tree" aria-label={t.side.tree}>
      <div className="tree-label">
        {t.side.tree}
        {context ? (
          <span className="ctx">
            {card && <Icon name="mail" size={12} />}
            {context}
          </span>
        ) : (
          fresh > 0 && (
            <button
              type="button"
              className="ctx fresh"
              onClick={onMarkAllSeen}
              title={t.side.freshTitle(fresh)}
            >
              <i className="new-dot" />
              {fresh} {t.side.markAllRead}
            </button>
          )
        )}
      </div>
      <div className="tree-rows">{rows}</div>
    </div>
  );
}

function descendants(graph: Graph, id: string): number {
  return graph.childrenOf(id).reduce((sum, k) => sum + 1 + descendants(graph, k.id), 0);
}

/** Nodes carried by the Cards of a lane: those waiting there and, for a Role, those it received. */
function Lane({
  graph,
  selected,
  work,
  lane,
  shown,
  draftOnPage,
  onToggle,
  onHot,
  onPage,
}: Props & {
  lane: string;
  shown: boolean;
  onToggle: () => void;
  onHot: (lane: string | null) => void;
}) {
  const drag = useDragState();
  const cards = work.laneCards(lane);
  const over = drag?.over === `lane:${lane}`;
  const name = work.laneName(lane);
  const waiting = cards.filter((c) => !isDraft(c)).length;
  const viewing = selected?.kind === "card" ? graph.cards.get(selected.id) : undefined;
  const hint = drag ? laneHint(work, drag.item.kind, lane) : "";
  const cls = [
    "lane",
    over ? "is-over" : "",
    selected?.kind === "role" && selected.id === lane ? "is-active" : "",
    viewing && lane !== PUBLIC && work.laneOf(viewing) === lane ? "is-linked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} data-drop={`lane:${lane}`}>
      <div
        className="lane-head"
        onPointerEnter={() => !drag && onHot(lane)}
        onPointerLeave={() => onHot(null)}
      >
        {lane === PUBLIC ? (
          <button type="button" className="who" onClick={onToggle} aria-expanded={shown}>
            <span className="pub-ic">
              <Icon name="public" size={13} />
            </span>
            <span className="n">{name}</span>
          </button>
        ) : (
          <button
            type="button"
            className="who"
            onClick={() => onPage({ kind: "role", id: lane })}
            data-tip={t.work.openRole(name)}
          >
            <span className="face">
              <Pet id={lane} size={28} />
            </span>
            <span className="n">{name}</span>
          </button>
        )}
        {over ? (
          <span className="hint">
            <Icon name="drop" size={13} />
            {hint}
          </span>
        ) : (
          cards.length > 0 && (
            <span
              className={`cnt${waiting ? " is-waiting" : ""}`}
              title={t.work.count(waiting, cards.length - waiting, lane !== PUBLIC)}
            >
              {cards.length}
            </span>
          )
        )}
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
          {!cards.length && (
            <div className="lane-empty">
              {lane === PUBLIC ? t.work.emptyPublic : t.work.emptyRole(name)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What letting go of a Node or a Card over a lane does. */
function laneHint(work: Work, kind: "node" | "card", lane: string) {
  const name = work.laneName(lane);
  return kind === "node"
    ? lane === PUBLIC
      ? t.work.dropNew
      : t.work.dropFor(name)
    : lane === PUBLIC
      ? t.work.dropPublic
      : t.work.dropTo(name);
}

/** The draft being written, while 分工 is folded: a pencil and its number of sources. Takes a Node. */
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
      <Icon name={over ? "drop" : "edit"} size={13} />
      {over ? sources + 1 : sources}
    </button>
  );
}

/** A lane while 分工 is folded: its face and how many Cards are there. Still takes a Node or a Card. */
function LaneChip({
  work,
  lane,
  onHot,
  onOpen,
}: {
  work: Work;
  lane: string;
  onHot: (lane: string | null) => void;
  onOpen: () => void;
}) {
  const drag = useDragState();
  const cards = work.laneCards(lane);
  const waiting = cards.filter((c) => !isDraft(c)).length;
  const name = work.laneName(lane);
  const over = drag?.over === `lane:${lane}`;
  return (
    <button
      type="button"
      className={`lane-chip${over ? " is-over" : ""}`}
      data-drop={`lane:${lane}`}
      data-hint={over ? laneHint(work, drag.item.kind, lane) : undefined}
      data-tip={t.work.chipTip(
        name,
        t.work.count(waiting, cards.length - waiting, lane !== PUBLIC),
      )}
      aria-label={name}
      onClick={onOpen}
      onPointerEnter={() => !drag && onHot(lane)}
      onPointerLeave={() => onHot(null)}
    >
      {lane === PUBLIC ? (
        <span className="pub-ic">
          <Icon name="public" size={11} />
        </span>
      ) : (
        <Pet id={lane} size={22} />
      )}
      {cards.length > 0 && (
        <span className={`cnt${waiting ? " is-waiting" : ""}`}>{cards.length}</span>
      )}
    </button>
  );
}

/** A Card in a lane: a dashed draft, or a published Card waiting for its Role. Both drag to other lanes. */
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
  const over = draft && drag?.over === `card:${card.id}`;
  const lifted = drag?.item.kind === "card" && drag.item.id === card.id;
  // The draft being written counts what is on screen; others count what is saved.
  const sources =
    card.id === work.openDraft && work.draft
      ? work.draft.input.sources.length
      : card.sources.length;
  const meta = draft
    ? `${t.work.draft}${sources ? ` · ${sources}` : ""}`
    : `${work.laneOf(card) === PUBLIC ? t.work.unclaimed : t.work.waiting} · ${ago(card.publishedAt)}`;
  return (
    <div
      className={`letter ${draft ? "is-draft" : "is-pub"}${over ? " is-over" : ""}${lifted ? " is-lifted" : ""}${active ? " is-active" : ""}`}
      data-drop={draft ? `card:${card.id}` : undefined}
      role="button"
      tabIndex={0}
      title={draft ? t.work.letterDraft : t.work.letterPub}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick();
      }}
      onPointerDown={(e) => beginDrag(e, { kind: "card", id: card.id })}
    >
      <Icon name={over ? "drop" : draft ? "edit" : "mail"} size={14} />
      <span className="t">{over ? t.work.dropIntoDraft : work.title(card)}</span>
      <span className="m">{over ? t.work.nth(sources + 1) : meta}</span>
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
        <Icon name="edit" size={15} />
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
          data-tip={t.work.expand}
        >
          <Icon name="expand" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => work.setOpenDraft(null)}
          aria-label={t.work.fold}
          data-tip={t.work.fold}
        >
          <Icon name="down" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void work.discard(card.id)}
          disabled={work.publishing === card.id}
          aria-label={t.work.discard}
          data-tip={t.work.discard}
          data-tip-end=""
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
                  data-tip={t.work.takeOut}
                  data-tip-end=""
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
          editDraft(card.id, (input) => ({ ...input, prompt }), true);
        }}
      />
      <div className="draft-foot">
        <span className="saved">{saveState(draft)}</span>
        <button
          type="button"
          className="publish"
          onClick={() => void work.publish(card.id)}
          disabled={!draft || work.publishing === card.id}
          data-tip={t.work.publishTip}
          data-tip-end=""
        >
          <Icon name="send" size={14} />
          {work.publishing === card.id ? t.work.publishing : t.work.publish}
        </button>
      </div>
    </div>
  );
}

export function saveState(draft: ReturnType<typeof useDraft>) {
  if (!draft) return t.work.loading;
  if (draft.failed) return t.work.notSaved;
  if (draft.saving || draft.dirty) return t.work.saving;
  return t.work.saved;
}

/** A Node's preview beside the sidebar after a short rest on its row. */
function Peek({ graph, work, id, top }: { graph: Graph; work: Work; id: string; top: number }) {
  const n = graph.nodes.get(id);
  const box = useRef<HTMLDivElement>(null);
  const [y, setY] = useState(top - 12);
  useEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    setY(Math.max(8, Math.min(top - 12, window.innerHeight - h - 8)));
  }, [id, top]);
  if (!n) return null;
  const latest = n.history[0] ? graph.commits.get(n.history[0]) : undefined;
  const cards = graph.snapshot.cards.filter(
    (c) => !isDraft(c) && c.sources.some((s) => s.id === n.id),
  );
  const holders = [...new Set(cards.map(work.laneOf).filter((l) => l !== PUBLIC))];
  const [primary, ...tag] = n.type.split("-");
  return (
    <div className="peek" ref={box} style={{ top: y }} role="tooltip">
      <div className="peek-head">
        <TypeTile kind={n.type} size={30} />
        <div>
          <div className="peek-name">{n.name}</div>
          <div className="peek-type">
            <b className={`p-${primary}`}>{primary}</b>
            {tag.length > 0 && ` · ${tag.join("-")}`}
          </div>
        </div>
      </div>
      {n.description && <p>{n.description}</p>}
      <div className="peek-meta">
        {latest && (
          <span>
            <Icon name="clock" size={13} />
            {t.side.versions(n.history.length, ago(latest.date))}
          </span>
        )}
        {cards.length > 0 && (
          <span>
            <Icon name="mail" size={13} />
            {t.side.carried(cards.length)}
            {holders.map((r) => (
              <Pet key={r} id={r} size={14} />
            ))}
          </span>
        )}
      </div>
      <div className="peek-hint">
        {t.side.dragHint}
        <Icon name="addToCard" size={12} />
      </div>
    </div>
  );
}

/** The workspace name at the top: it lists the workspaces opened on this computer and opens others. */
function Workspaces({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<KnownWorkspace[] | null>(null);
  const [typing, setTyping] = useState(false);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ url: string; port: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setTyping(false);
    setFolder("");
    setProblem(null);
    setTaken(null);
    let live = true;
    api.workspaces().then(
      (r) => live && setList(r.workspaces),
      (error) => live && setProblem(describe(error)),
    );
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      live = false;
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const visit = async (url: string) => {
    setBusy(url);
    setProblem(null);
    try {
      await flushDrafts();
      if (hasUnsavedNodeDrafts()) throw new Error(t.side.unsavedNodes);
      location.assign(url);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(null);
    }
  };

  // The other workspace has its own address and token; save pending Cards before leaving.
  const go = async (target: string) => {
    setBusy(target);
    setProblem(null);
    setTaken(null);
    try {
      const { url, portTaken } = await api.openWorkspace(target);
      if (portTaken === undefined) return await visit(url);
      setTaken({ url, port: portTaken });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      setProblem(
        code === "NOT_A_WORKSPACE"
          ? t.side.notWorkspace
          : code === "INVALID_INPUT"
            ? t.side.fullPath
            : describe(error),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ws-switch" ref={box}>
      <button
        type="button"
        className="side-ws"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tip={open ? undefined : t.side.workspaces}
      >
        <span>{name}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="ws-pop" role="dialog" aria-label={t.side.workspaces}>
          {list?.map((w) => (
            <button
              key={w.root}
              type="button"
              className={`ws-item${w.current ? " is-current" : ""}`}
              onClick={() => (w.current ? setOpen(false) : void go(w.root))}
              disabled={busy !== null}
              title={w.root}
            >
              <span className="ws-text">
                <b>{w.name}</b>
                <span>{busy === w.root ? t.side.opening : pathTail(w.root)}</span>
              </span>
              {w.current && <Icon name="check" size={15} />}
            </button>
          ))}
          {list && <div className="ws-sep" />}
          {typing ? (
            <form
              className="ws-path"
              onSubmit={(e) => {
                e.preventDefault();
                if (folder.trim()) void go(folder.trim());
              }}
            >
              <Icon name="folder" size={15} />
              <input
                autoFocus
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={busy ? t.side.opening : t.side.folderPath}
                aria-label={t.side.folderPath}
                spellCheck={false}
                disabled={busy !== null}
              />
            </form>
          ) : (
            <button type="button" className="ws-item ws-open" onClick={() => setTyping(true)}>
              <Icon name="folder" size={15} />
              <span>{t.side.openFolder}</span>
            </button>
          )}
          {problem && <p className="ws-problem">{problem}</p>}
          {taken && (
            <div className="ws-taken">
              <p>{t.side.portBusy(taken.port)}</p>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void visit(taken.url)}
              >
                {t.side.openAnyway}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The gear at the foot: appearance and language. */
function Settings({
  themePref,
  lang,
  onTheme,
  onLang,
}: {
  themePref: ThemePref;
  lang: Lang;
  onTheme: (pref: ThemePref) => void;
  onLang: (lang: Lang) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const choice = <T extends string>(value: T, current: T, label: string, pick: (v: T) => void) => (
    <button type="button" role="radio" aria-checked={value === current} onClick={() => pick(value)}>
      {label}
    </button>
  );
  return (
    <div className="settings" ref={box}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.side.settings}
        aria-expanded={open}
        data-tip={open ? undefined : t.side.settings}
      >
        <Icon name="settings" size={16} />
      </button>
      {open && (
        <div className="settings-pop" role="dialog" aria-label={t.side.settings}>
          <div className="settings-row">
            <span>{t.side.appearance}</span>
            <div className="seg" role="radiogroup" aria-label={t.side.appearance}>
              {choice("system", themePref, t.side.system, onTheme)}
              {choice("light", themePref, t.side.light, onTheme)}
              {choice("dark", themePref, t.side.dark, onTheme)}
            </div>
          </div>
          <div className="settings-row">
            <span>{t.side.language}</span>
            <div className="seg" role="radiogroup" aria-label={t.side.language}>
              {choice<Lang>("zh", lang, "中文", onLang)}
              {choice<Lang>("en", lang, "English", onLang)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
