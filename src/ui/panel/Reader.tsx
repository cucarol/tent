import {
  Fragment,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { api, ApiError, describe, type NodeDocument } from "../data/api.js";
import { cardTitle, primaryOf, suffixOf, type Graph } from "../data/store.js";
import type {
  SnapshotCard,
  SnapshotCommit,
  SnapshotNode,
  SnapshotRef,
  SnapshotRole,
} from "../data/types.js";
import { editDraft, isDraft, useDraft } from "../data/drafts.js";
import { cardProgressLabel } from "../data/card-progress.js";
import { nodeDrafts as drafts } from "../data/node-drafts.js";
import { Icon, TypeGlyph, TypeTile } from "../components/Glyph.js";
import { Pet, turnPet } from "../components/Pet.js";
import { Markdown } from "../components/Markdown.js";
import {
  FileDiff,
  History,
  MaterialName,
  NodeProps,
  Patch,
  PropRow,
  RefLink,
  ReviewRow,
} from "./Details.js";
import { useFlags } from "../data/flags.js";
import { Letter, saveState } from "../shell/Sidebar.js";
import { beginDrag, useDragState } from "../shell/drag.js";
import { draftTitle, PUBLIC, sourceIds, type Work } from "../shell/work.js";
import { ago, lineDiff, readStored, shortHash, when, writeStored } from "../util.js";
import { t } from "../i18n.js";

// The editor loads only when someone starts editing.
const MarkdownEditor = lazy(() => import("../components/MarkdownEditor.js"));

type Props = {
  graph: Graph;
  target: SnapshotRef;
  work: Work;
  startEditing: boolean;
  /** A page over the map, or a panel docked beside it. */
  mode?: "page" | "panel";
  onOpen: (ref: SnapshotRef | null) => void;
  onClose: () => void;
  /** From a page back to the map. */
  onCollapse?: () => void;
  /** From the panel to a page, editing when asked. */
  onExpand?: (edit?: boolean) => void;
  onLocate: (ref: SnapshotRef) => void;
  onToast: (text: string) => void;
};
/**
 * What a page is laid out for; narrow puts the rail into the one column. Past is set once the title block
 * has scrolled away, and the bar then names the object; toTop scrolls back to it.
 */
type PageProps = Props & { narrow: boolean; past?: boolean; toTop?: () => void };

/** Below this width the rail joins the text column: in the panel beside the map and in small windows. */
const NARROW = 760;

function useWidth(box: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(Infinity);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return width;
}

/**
 * An object as a page over the map, or as a panel beside it: a thin bar with where it sits and what to do,
 * then a title block, the text in a readable measure, and a rail of properties beside it (or, when narrow,
 * in the same column). Node, Role and Card share it.
 */
export function Reader(props: Props) {
  const { graph, target } = props;
  const box = useRef<HTMLElement>(null);
  const narrow = useWidth(box) < NARROW;
  const node = target.kind === "node" ? graph.nodes.get(target.id) : undefined;
  const role = target.kind === "role" ? graph.roles.get(target.id) : undefined;
  const card = target.kind === "card" ? props.work.card(target.id) : undefined;
  const [past, setPast] = useState(false);
  useEffect(() => setPast(false), [target.kind, target.id]);
  const onScroll = (e: UIEvent<HTMLElement>) => {
    const scroller = e.target as HTMLElement;
    if (!scroller.classList.contains("pg-scroll")) return;
    const hero = scroller.querySelector(".hero");
    setPast(
      !!hero && hero.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top + 8,
    );
  };
  const toTop = () =>
    box.current?.querySelector(".pg-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  const page = { ...props, narrow, past, toTop };
  return (
    <section
      ref={box}
      className={`reader${props.mode === "panel" ? " is-panel" : ""}`}
      aria-label={props.mode === "panel" ? t.sheet.label : t.reader.label}
      onScrollCapture={onScroll}
    >
      {node && <NodePage {...page} node={node} key={node.id} />}
      {role && <RolePage {...page} role={role} key={role.id} />}
      {card && isDraft(card) && <DraftPage {...page} card={card} key={card.id} />}
      {card && !isDraft(card) && <CardPage {...page} card={card} key={card.id} />}
      {!node && !role && !card && (
        <>
          <PageTop {...props} crumbs={[]} />
          <p className="empty pg-missing">{t.sheet.notFound}</p>
        </>
      )}
    </section>
  );
}

/**
 * Below the bar: the head (title block and what leads into the text), then the text. On a wide page the
 * rail sits beside them; when narrow, `lead` goes between the head and the text, and `rail` after it but
 * before the `tail`.
 */
function PageBody({
  narrow,
  className,
  head,
  lead,
  main,
  rail,
  tail,
}: {
  narrow: boolean;
  className?: string;
  head: ReactNode;
  lead?: ReactNode;
  main: ReactNode;
  rail?: ReactNode;
  tail?: ReactNode;
}) {
  return (
    <div className="pg-scroll">
      <div className={`pg-grid${narrow ? " is-narrow" : ""}`}>
        <article className={`pg-main${className ? ` ${className}` : ""}`}>
          {head}
          {narrow && lead && <div className="rail is-inline">{lead}</div>}
          {main}
          {narrow && rail && <div className="rail is-inline">{rail}</div>}
          {tail}
        </article>
        {!narrow && (
          <aside className="rail" aria-label={t.reader.rail}>
            {lead}
            {rail}
          </aside>
        )}
      </div>
    </div>
  );
}

/** The bar over a page: where it sits on the left, its actions, then back to the map (or out to a page) and close. */
function PageTop({
  title,
  glyph,
  crumbs,
  actions,
  mode,
  past,
  toTop,
  onCollapse,
  onExpand,
  onClose,
}: Pick<PageProps, "mode" | "past" | "toTop" | "onCollapse" | "onExpand" | "onClose"> & {
  /**
   * Beside the map, whose bar already shows where it sits, the panel's bar stays quiet until the title
   * block scrolls away, then names the object; clicking the name goes back up.
   */
  title?: string;
  glyph?: ReactNode;
  crumbs: ReactNode[];
  actions?: ReactNode;
}) {
  return (
    <div className="pg-top">
      {mode === "panel" ? (
        <div className="pg-crumbs">
          {title && (
            <button
              type="button"
              className={`pg-peek${past ? " is-shown" : ""}`}
              onClick={toTop}
              tabIndex={past ? 0 : -1}
              aria-hidden={!past}
              title={t.page.toTop}
            >
              {glyph}
              <span>{title}</span>
            </button>
          )}
        </div>
      ) : (
        <nav className="pg-crumbs" aria-label={t.bar.where}>
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="sep">/</span>}
              {c}
            </Fragment>
          ))}
        </nav>
      )}
      <div className="pg-actions">
        {actions}
        {actions && <span className="vsep" />}
        {mode === "panel" ? (
          <button
            type="button"
            className="icon-btn"
            onClick={() => onExpand?.()}
            aria-label={t.sheet.expand}
            data-tip={t.sheet.expand}
            data-key="Enter"
            data-tip-end=""
          >
            <Icon name="expand" size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            onClick={onCollapse}
            aria-label={t.reader.back}
            data-tip={t.reader.back}
            data-key="Esc"
            data-tip-end=""
          >
            <Icon name="shrink" size={16} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label={t.app.close}
          data-tip={t.app.close}
          data-key={mode === "panel" ? "Esc" : undefined}
          data-tip-end=""
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}

const Crumb = ({ onClick, children }: { onClick?: () => void; children: ReactNode }) =>
  onClick ? (
    <button type="button" className="pg-crumb" onClick={onClick}>
      {children}
    </button>
  ) : (
    <span className="pg-crumb is-current">{children}</span>
  );

/** Title block: the object's large icon (a Role's pet), what kind it is, and its name. */
function Hero({ icon, eyebrow, title }: { icon: ReactNode; eyebrow: ReactNode; title: string }) {
  return (
    <div className="hero">
      {icon}
      <div className="hero-text">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  note,
  children,
}: {
  title: string;
  count?: number;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="pg-sec">
      <h3>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
        {note && <span className="note">{note}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A list that shows its first few and opens to all of them. */
function More({
  count,
  shown,
  children,
}: {
  count: number;
  shown: number;
  children: (n: number) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  return (
    <>
      {children(all ? count : shown)}
      {count > shown && (
        <button
          type="button"
          className={`more-btn${all ? " is-open" : ""}`}
          onClick={() => setAll(!all)}
        >
          <Icon name="down" size={13} />
          {all ? t.page.showLess : t.page.showAll(count)}
        </button>
      )}
    </>
  );
}

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rail-sec">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

/** A Card as a short entry: its title on up to two lines, then whose it is and where it stands; opens its page. */
function CardLine({
  graph,
  work,
  card,
  onOpen,
  withRole = true,
}: {
  graph: Graph;
  work: Work;
  card: SnapshotCard;
  onOpen: (ref: SnapshotRef) => void;
  /** Off on a Role's own page, where every line is that Role's. */
  withRole?: boolean;
}) {
  const draft = isDraft(card);
  const lane = work.laneOf(card);
  const waiting = card.state === "pending" && !draft;
  return (
    <button
      type="button"
      className={`card-line${waiting ? " is-waiting" : draft ? " is-draft" : ""}`}
      onClick={() => onOpen({ kind: "card", id: card.id })}
    >
      <Icon name={draft ? "edit" : waiting ? "mail" : "check"} size={14} />
      <span className="cl-text">
        <span className="t">{work.title(card)}</span>
        <span className="w">
          {withRole && (lane === PUBLIC || graph.roles.has(lane)) && (
            <>
              {laneIcon(lane, 13)}
              <span>{work.laneName(lane)}</span>
              <span className="dot-sep">·</span>
            </>
          )}
          {draft ? t.work.draft : `${cardProgressLabel(card)} · ${ago(card.publishedAt)}`}
        </span>
      </span>
    </button>
  );
}

/** A step on a Card's way: written, published, handed to a lane, received. */
function Step({
  state,
  dot,
  title,
  sub,
}: {
  state: "done" | "ok" | "now" | "review" | "todo";
  dot: ReactNode;
  title: string;
  sub?: string;
}) {
  return (
    <div className={`step is-${state}`}>
      <span className="dot">{dot}</span>
      <span className="lb">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </span>
    </div>
  );
}
const Line = ({ todo }: { todo?: boolean }) => (
  <span className={`step-line${todo ? " is-todo" : ""}`} />
);

/** A lane's face: the Role's pet, or the public area's dashed box (a bare icon when small). */
const laneIcon = (lane: string, size: number) =>
  lane !== PUBLIC ? (
    <Pet id={lane} size={size} />
  ) : size < 20 ? (
    <Icon name="public" size={size} />
  ) : (
    <span className="pub-ic" style={{ width: size, height: size }}>
      <Icon name="public" size={Math.round(size * 0.5)} />
    </span>
  );

/** Which lane a Card sits in; each chip moves it there. */
function LanePick({ work, card }: { work: Work; card: SnapshotCard }) {
  const at = work.laneOf(card);
  return (
    <div className="lanes-pick" role="radiogroup" aria-label={t.page.whereLabel}>
      {work.lanes.map((lane) => (
        <button
          key={lane || "public"}
          type="button"
          role="radio"
          aria-checked={lane === at}
          disabled={work.publishing === card.id}
          onClick={() => void work.move(card.id, lane)}
        >
          {laneIcon(lane, 14)}
          {work.laneName(lane)}
        </button>
      ))}
    </div>
  );
}

function CopyId({ id, onToast }: { id: string; onToast: (text: string) => void }) {
  return (
    <button
      type="button"
      className="chip"
      onClick={() =>
        navigator.clipboard?.writeText(id).then(
          () => onToast(t.sheet.copied(id)),
          () => onToast(id),
        )
      }
      data-tip={t.sheet.copyId}
    >
      <Icon name="copy" size={13} />
      <span className="mono">{id}</span>
    </button>
  );
}

/** The saved text an edit started from; saving checks the file still has it. */
type Base = { etag: string; body: string };

function NodePage(props: PageProps & { node: SnapshotNode }) {
  const { graph, node, work, narrow, startEditing, onOpen, onExpand, onLocate, onToast } = props;
  const flags = useFlags();
  const panel = props.mode === "panel";
  const kept = drafts.get(node.id);
  const [editing, setEditing] = useState(() => startEditing || !!kept?.editing);
  const [draft, setDraft] = useState<string | null>(
    () => kept?.text ?? (startEditing ? node.body : null),
  );
  const [base, setBase] = useState<Base | null>(() => kept?.base ?? null);
  const [conflict, setConflict] = useState<Base | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [saving, setSaving] = useState(false);
  const version = node.history[0];
  const [read, setRead] = useState<{
    doc: NodeDocument;
    body: string;
    version: string | undefined;
  } | null>(null);
  const doc =
    read?.doc.nodeId === node.id && read.body === node.body && read.version === version
      ? read.doc
      : null;
  const acceptRead = (doc: NodeDocument) => setRead({ doc, body: node.body, version });
  useEffect(() => {
    let live = true;
    api.node(node.id).then(
      (doc) => live && acceptRead(doc),
      (error) => {
        if (!live) return;
        setRead(null);
        onToast(describe(error));
      },
    );
    return () => {
      live = false;
    };
  }, [node.id, node.body, version]);
  // What was just saved shows until the refreshed map catches up.
  const [savedBody, setSavedBody] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  // The latest text, even before React has rendered it: Ctrl+S can follow a keystroke at once.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const change = (text: string) => {
    draftRef.current = text;
    setDraft(text);
  };
  useEffect(() => {
    if (draft === null) drafts.delete(node.id);
    else
      drafts.set(node.id, {
        text: draft,
        editing,
        base,
        dirty: draft !== (base?.body ?? node.body),
      });
  }, [node.id, node.body, draft, editing, base]);

  // Editing starts from the file itself, recorded in history, so the save is a change of its own.
  useEffect(() => {
    if (!editing || base) return;
    let live = true;
    api.node(node.id, true).then(
      (doc) => {
        if (!live) return;
        setBase({ etag: doc.etag, body: doc.body });
        const typed = draftRef.current;
        if ((typed === null || typed === node.body) && typed !== doc.body) {
          setDraft(doc.body);
          setEditorKey((k) => k + 1);
        }
      },
      (error) => live && onToast(describe(error)),
    );
    return () => {
      live = false;
    };
  }, [editing, base, node.id]);

  // Say so when a change made elsewhere replaces what you are reading.
  const shownBody = useRef(node.body);
  useEffect(() => {
    if (shownBody.current !== node.body && draft === null && savedBody === null)
      onToast(t.reader.updated);
    shownBody.current = node.body;
    if (savedBody !== null && node.body === savedBody) setSavedBody(null);
  }, [node.body]);
  const staleBase = editing && !!base && !conflict && node.body !== base.body;
  const follow = (ref: SnapshotRef) => {
    if (draft !== null && draft !== node.body) onToast(t.reader.keptEdits);
    onOpen(ref);
  };
  const [live, setLive] = useState(() => readStored("tent-editor-live-v1", true));
  const chooseLive = (next: boolean) => {
    setLive(next);
    writeStored("tent-editor-live-v1", next);
  };
  const state = graph.states.get(node.id)!;
  const p = primaryOf(node.type);
  const body = draft ?? savedBody ?? doc?.body ?? node.body;
  const stopEditing = () => {
    setDraft(null);
    setBase(null);
    setConflict(null);
    setShowDiff(false);
    setEditing(false);
  };
  const save = async (over?: Base) => {
    const text = draftRef.current;
    if (text === null || saving) return;
    setSaving(true);
    try {
      const on = over ?? base ?? (await api.node(node.id, true));
      const saved = await api.saveNode(node.id, { baseEtag: on.etag, body: text });
      setSavedBody(saved.body);
      stopEditing();
      onToast(saved.changed ? t.reader.saved : t.reader.unchanged);
    } catch (error) {
      const current = error instanceof ApiError && error.details?.current;
      if (error instanceof ApiError && error.code === "ETAG_CONFLICT" && current)
        setConflict(current as Base);
      else onToast(describe(error));
    } finally {
      setSaving(false);
    }
  };
  const loadTheirs = () => {
    if (!conflict) return;
    setDraft(conflict.body);
    setBase(conflict);
    setConflict(null);
    setShowDiff(false);
    setEditorKey((k) => k + 1);
  };

  const openCard = work.openDraft ? graph.cards.get(work.openDraft) : undefined;
  const at = work.openDraft ? sourceIds(graph, openCard, work.draft).indexOf(node.id) : -1;
  const carried = graph.snapshot.cards
    .filter((c) => !isDraft(c) && c.sources.some((s) => s.id === node.id))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  const actions = editing ? (
    <>
      <span className="muted pg-hint">{t.reader.baseVersion}</span>
      <div className="seg" role="radiogroup" aria-label={t.reader.mode}>
        <button type="button" role="radio" aria-checked={live} onClick={() => chooseLive(true)}>
          {t.reader.live}
        </button>
        <button type="button" role="radio" aria-checked={!live} onClick={() => chooseLive(false)}>
          {t.reader.source}
        </button>
      </div>
      <button type="button" className="btn plain" onClick={stopEditing}>
        {t.app.cancel}
      </button>
      <button type="button" className="btn primary" onClick={() => save()} disabled={saving}>
        {saving ? t.reader.saving : t.reader.save}
        <kbd>Ctrl S</kbd>
      </button>
    </>
  ) : (
    <>
      {!panel && (
        <button
          type="button"
          className="btn plain"
          onClick={() => onLocate({ kind: "node", id: node.id })}
        >
          <Icon name="locate" size={15} />
          {t.reader.locate}
        </button>
      )}
      <button
        type="button"
        className={narrow ? "icon-btn" : "btn plain"}
        onClick={() => {
          // Beside the map the text is narrow; editing opens the page.
          if (panel) return onExpand?.(true);
          setDraft(body);
          setEditing(true);
        }}
        aria-label={t.sheet.edit}
        data-tip={narrow ? t.sheet.editTitle : undefined}
        data-key={narrow ? "E" : undefined}
        data-tip-end=""
      >
        <Icon name="edit" size={narrow ? 16 : 15} />
        {!narrow && (
          <>
            {t.sheet.edit}
            <kbd>E</kbd>
          </>
        )}
      </button>
      <button
        type="button"
        className={`btn${at >= 0 ? " is-in" : " accent"}`}
        onClick={() => work.attach(node.id)}
        disabled={!!work.openDraft && work.publishing === work.openDraft}
        data-tip={at >= 0 ? t.side.inDraft : t.page.attachTip}
        data-tip-end=""
      >
        <Icon name={at >= 0 ? "check" : "addToCard"} size={15} />
        {at < 0 ? t.side.attach : narrow ? t.page.inDraftShort(at + 1) : t.page.inDraft(at + 1)}
      </button>
    </>
  );
  const carriedSection = (
    <RailSection title={t.page.carried(carried.length)}>
      {carried.length ? (
        <More count={carried.length} shown={narrow ? 3 : 6}>
          {(n) =>
            carried
              .slice(0, n)
              .map((c) => (
                <CardLine key={c.id} graph={graph} work={work} card={c} onOpen={onOpen} />
              ))
          }
        </More>
      ) : (
        <p className="empty">{t.page.noCards}</p>
      )}
    </RailSection>
  );
  // Next to the map, which Cards carried this Node comes before its text.
  const carriedFirst = narrow && carried.length > 0;
  return (
    <>
      <PageTop
        {...props}
        title={node.name}
        glyph={<TypeGlyph type={node.type} size={14} />}
        crumbs={[...graph.ancestors(node.id), node].map((c) => (
          <Crumb
            key={c.id}
            onClick={c.id === node.id ? undefined : () => onOpen({ kind: "node", id: c.id })}
          >
            {c.name}
          </Crumb>
        ))}
        actions={actions}
      />
      <PageBody
        narrow={narrow}
        className={`t-${p}`}
        head={
          <>
            <Hero
              icon={
                <span
                  className="hero-grab"
                  onPointerDown={(e) => beginDrag(e, { kind: "node", id: node.id })}
                  data-tip={t.page.dragNode}
                >
                  <TypeTile kind={node.type} size={narrow ? 40 : 52} />
                </span>
              }
              eyebrow={
                <>
                  <b className={`p-${p}`}>{p}</b>
                  {suffixOf(node.type) && (
                    <>
                      <span className="dot-sep">·</span>
                      <span>{suffixOf(node.type)}</span>
                    </>
                  )}
                  {node.status !== "stable" && (
                    <span className="pill">{t.node.status(node.status)}</span>
                  )}
                  {state.recent && <span className="pill pill-recent">{t.node.recent}</span>}
                  {state.drift && <span className="pill pill-drift">{t.node.drift}</span>}
                  {node.tags.map((tag) => (
                    <span key={tag} className="pill">
                      #{tag}
                    </span>
                  ))}
                </>
              }
              title={node.name}
            />
            {node.description && <p className="page-lede">{node.description}</p>}
            {draft !== null && !editing && draft !== node.body && (
              <div className="banner">
                {t.reader.unsaved}
                <span className="banner-actions">
                  <button type="button" onClick={() => setEditing(true)}>
                    {t.reader.resume}
                  </button>
                  <button type="button" onClick={stopEditing}>
                    {t.reader.undo}
                  </button>
                </span>
              </div>
            )}
            {staleBase && <div className="banner">{t.reader.changedWhileEditing}</div>}
            {conflict && (
              <>
                <div className="banner">
                  {t.reader.conflict}
                  <span className="banner-actions">
                    <button type="button" onClick={() => setShowDiff((shown) => !shown)}>
                      {showDiff ? t.reader.hideDiff : t.reader.showDiff}
                    </button>
                    <button type="button" onClick={loadTheirs}>
                      {t.reader.loadTheirs}
                    </button>
                    <button type="button" onClick={() => save(conflict)} disabled={saving}>
                      {t.reader.overwrite}
                    </button>
                  </span>
                </div>
                {showDiff && (
                  <div className="conflict-diff">
                    <p className="muted">{t.reader.diffLegend}</p>
                    <Patch patch={lineDiff(conflict.body, draft ?? "")} />
                  </div>
                )}
              </>
            )}
          </>
        }
        lead={carriedFirst ? carriedSection : undefined}
        main={
          <div className="pg-doc">
            {editing ? (
              <Suspense fallback={<div className="md-editor is-loading" />}>
                <MarkdownEditor
                  key={editorKey}
                  value={draft ?? node.body}
                  fromPath={node.notePath}
                  graph={graph}
                  label={t.reader.editLabel(node.name)}
                  live={live}
                  onChange={change}
                  onSave={() => save()}
                  onOpen={follow}
                  onToast={onToast}
                />
              </Suspense>
            ) : body.trim() ? (
              <Markdown body={body} fromPath={node.notePath} graph={graph} onOpen={onOpen} />
            ) : (
              <p className="empty">{t.node.noBody}</p>
            )}
          </div>
        }
        rail={
          <>
            <RailSection title={t.page.props}>
              <NodeProps graph={graph} node={node} onOpen={onOpen}>
                <ReviewRow
                  node={node}
                  doc={doc}
                  disabled={editing || draft !== null || saving || savedBody !== null}
                  flag={flags[node.id]}
                  onRead={acceptRead}
                  onToast={onToast}
                />
                <PropRow label="id">
                  <CopyId id={node.id} onToast={onToast} />
                </PropRow>
              </NodeProps>
            </RailSection>
            {!carriedFirst && carriedSection}
          </>
        }
        tail={
          <Section title={t.page.versions} count={node.history.length} note={t.page.versionsNote}>
            <History graph={graph} id={node.id} path={node.notePath} hashes={node.history} />
          </Section>
        }
      />
    </>
  );
}

/** A Role's text often opens with a sentence of what it is for; that becomes the lede. */
function splitLede(body: string): [string, string] {
  const trimmed = body.trim();
  const end = trimmed.search(/\n\s*\n/);
  const first = end < 0 ? trimmed : trimmed.slice(0, end);
  if (!first || /^([#>|`*-]|\d+\.|!\[|<)/.test(first)) return ["", body];
  return [first.replace(/\s*\n\s*/g, " "), end < 0 ? "" : trimmed.slice(end)];
}

function RolePage(props: PageProps & { role: SnapshotRole }) {
  const { graph, role, work, narrow, onOpen, onToast } = props;
  const drag = useDragState();
  const here = work.laneCards(role.id);
  const received = graph.snapshot.cards
    .filter((c) => c.receivedBy === role.id)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const [lede, rest] = splitLede(role.body);
  const watches = role.links.flatMap((l) => (l.ref?.kind === "node" ? [l.ref] : []));
  const over = drag?.over === `lane:${role.id}`;
  return (
    <>
      <PageTop
        {...props}
        title={role.title}
        glyph={<Pet id={role.id} size={16} />}
        crumbs={[<Crumb key="role">Role</Crumb>, <Crumb key="name">{role.title}</Crumb>]}
        actions={
          <button
            type="button"
            className="btn accent"
            onClick={() => void work.newCard(role.id)}
            data-tip={narrow ? t.page.writeFor(role.title) : undefined}
            data-tip-end=""
          >
            <Icon name="addToCard" size={15} />
            {narrow ? t.side.newCard : t.page.writeFor(role.title)}
          </button>
        }
      />
      <PageBody
        narrow={narrow}
        head={
          <>
            <Hero
              icon={
                <button
                  type="button"
                  className={`hero-pet${over ? " is-over" : ""}`}
                  data-drop={`lane:${role.id}`}
                  data-tip={drag ? t.page.dropOnRole(role.title) : t.page.turnFace}
                  data-tip-start
                  aria-label={t.page.turnFace}
                  onClick={(e) => turnPet(role.id, e.shiftKey ? -1 : 1)}
                >
                  <Pet id={role.id} size={narrow ? 44 : 56} />
                </button>
              }
              eyebrow={
                <>
                  <b>Role</b>
                  <span className="dot-sep">·</span>
                  <span>{t.page.roleKind}</span>
                </>
              }
              title={role.title}
            />
            {lede && <p className="page-lede">{lede}</p>}
          </>
        }
        main={
          <>
            <div className="pg-doc">
              <Markdown body={rest} fromPath={role.path} graph={graph} onOpen={onOpen} />
            </div>
            <Section title={t.page.here} count={here.length} note={t.page.hereNote}>
              <div className="letters" data-drop={`lane:${role.id}`}>
                {here.map((c) => (
                  <Letter
                    key={c.id}
                    card={c}
                    work={work}
                    onClick={() => onOpen({ kind: "card", id: c.id })}
                  />
                ))}
                {!here.length && <div className="lane-empty">{t.page.nothingHere}</div>}
              </div>
            </Section>
            <Section title={t.page.received} count={received.length}>
              <div className="letters">
                <More count={received.length} shown={8}>
                  {(n) =>
                    received
                      .slice(0, n)
                      .map((c) => (
                        <CardLine
                          key={c.id}
                          graph={graph}
                          work={work}
                          card={c}
                          onOpen={onOpen}
                          withRole={false}
                        />
                      ))
                  }
                </More>
                {!received.length && <p className="empty">{t.page.noneReceived}</p>}
              </div>
            </Section>
          </>
        }
        rail={
          <>
            <RailSection title={t.page.props}>
              <dl className="props">
                <PropRow label="Card">
                  <span className="prop-text">
                    {t.page.roleCards(here.length, received.length)}
                  </span>
                </PropRow>
                {watches.length > 0 && (
                  <PropRow label={t.page.watches}>
                    {watches.map((r) => (
                      <RefLink key={r.id} graph={graph} target={r} onOpen={onOpen} />
                    ))}
                  </PropRow>
                )}
                <PropRow label="id">
                  <CopyId id={role.id} onToast={onToast} />
                </PropRow>
              </dl>
            </RailSection>
            <div className="rail-note">
              <b>{t.page.roleNoteLead}</b>
              {t.page.roleNote}
            </div>
          </>
        }
        tail={
          <Section title={t.page.versions} count={role.history.length}>
            <History graph={graph} id={role.id} path={role.path} hashes={role.history} />
          </Section>
        }
      />
    </>
  );
}

function CardPage(props: PageProps & { card: SnapshotCard }) {
  const { graph, card, work, narrow, onOpen, onToast } = props;
  const [since, setSince] = useState<number | null>(null);
  const lane = work.laneOf(card);
  const laneName = work.laneName(lane);
  const pending = card.state === "pending" && !card.receivedBy;
  const title = cardTitle(card);
  // The title comes from the body's first line, a heading or plain text; the page shows it once.
  const body = card.body.replace(/^\s*(?:#+\s+)?(.+)\n?/, (line, text: string) =>
    text.replace(/[*_`~]/g, "").trim() === title ? "" : line,
  );
  const later = (path: string, commit: string): SnapshotCommit[] => {
    const idx = graph.snapshot.commits.findIndex((c) => c.hash === commit);
    return graph.snapshot.commits
      .slice(0, idx < 0 ? 0 : idx)
      .filter((c) => c.files.some((f) => f.path === path))
      .reverse();
  };
  const open = since === null ? undefined : card.sources[since];
  const status = cardProgressLabel(card);
  const progress = card.progress;
  return (
    <>
      <PageTop
        {...props}
        title={title}
        glyph={<Icon name="mail" size={14} />}
        crumbs={[
          <Crumb key="card">Card</Crumb>,
          <Crumb
            key="lane"
            onClick={lane === PUBLIC ? undefined : () => onOpen({ kind: "role", id: lane })}
          >
            {laneName}
          </Crumb>,
          <Crumb key="title">{title}</Crumb>,
        ]}
      />
      <PageBody
        narrow={narrow}
        head={
          <>
            <Hero
              icon={
                pending ? (
                  <span
                    className="hero-grab"
                    onPointerDown={(e) => beginDrag(e, { kind: "card", id: card.id })}
                    data-tip={t.page.dragCard}
                  >
                    <TypeTile kind="card" size={narrow ? 40 : 52} />
                  </span>
                ) : (
                  <TypeTile kind="card" size={narrow ? 40 : 52} />
                )
              }
              eyebrow={
                <>
                  <b>Card</b>
                  <span className="dot-sep">·</span>
                  <span
                    className={`pill ${pending ? "pill-pending" : progress === "needs-review" ? "pill-review" : "pill-consumed"}`}
                  >
                    {status}
                  </span>
                </>
              }
              title={title}
            />
            <div className="journey">
              <Step
                state="done"
                dot={<Icon name="send" size={15} />}
                title={t.page.published}
                sub={when(card.publishedAt)}
              />
              <Line />
              <Step
                state={pending ? "now" : "done"}
                dot={laneIcon(lane, 28)}
                title={lane === PUBLIC ? t.page.inPublic : t.page.handedTo(laneName)}
                sub={pending ? t.page.canMove : undefined}
              />
              <Line todo={pending} />
              <Step
                state={pending ? "todo" : progress ? "done" : "ok"}
                dot={<Icon name="check" size={15} />}
                title={pending ? t.page.receive : t.page.receivedBy(laneName)}
                sub={pending ? t.page.thenFixed : when(card.updatedAt)}
              />
              {progress && (
                <>
                  <Line todo={progress !== "has-output"} />
                  <Step
                    state={
                      progress === "has-output"
                        ? "ok"
                        : progress === "needs-review"
                          ? "review"
                          : progress === "pending"
                            ? "todo"
                            : "now"
                    }
                    dot={<Icon name={progress === "needs-review" ? "review" : "out"} size={15} />}
                    title={progress === "pending" ? t.page.outputs : status}
                    sub={
                      progress === "needs-review"
                        ? t.page.toReview(card.reviewOutputNodeIds?.length ?? 0)
                        : progress === "has-output"
                          ? undefined
                          : t.page.noOutputYet
                    }
                  />
                </>
              )}
            </div>
            {pending && (
              <Section title={t.page.where} note={t.page.whereNote}>
                <LanePick work={work} card={card} />
              </Section>
            )}
          </>
        }
        main={
          <>
            <Section title={t.page.what}>
              <div className="pg-doc">
                {body.trim() ? (
                  <Markdown body={body} fromPath={card.path} graph={graph} onOpen={onOpen} />
                ) : (
                  <p className="empty">{t.card.noText}</p>
                )}
              </div>
            </Section>
            {card.outputNodeIds.length > 0 && (
              <Section title={t.page.outputs}>
                {card.outputNodeIds.map((id) => (
                  <RefLink key={id} graph={graph} target={{ kind: "node", id }} onOpen={onOpen} />
                ))}
              </Section>
            )}
            {!!card.reviewOutputNodeIds?.length && (
              <Section title={t.page.reviewOutputs} note={t.page.reviewOutputsNote}>
                {card.reviewOutputNodeIds.map((id) => (
                  <RefLink key={id} graph={graph} target={{ kind: "node", id }} onOpen={onOpen} />
                ))}
              </Section>
            )}
            {open?.version && (
              <Section
                title={t.page.sourceChanges(
                  since! + 1,
                  graph.name(open.id ? { kind: "node", id: open.id } : null) || open.resource,
                )}
              >
                {later(open.version.path, open.version.commit).map((c) => (
                  <div key={c.hash} className="source-diff">
                    <div className="muted">
                      {when(c.date)} · <span className="mono">{shortHash(c.hash)}</span>
                    </div>
                    <FileDiff file={c.files.find((f) => f.path === open.version!.path)!} />
                  </div>
                ))}
              </Section>
            )}
          </>
        }
        lead={
          <RailSection title={t.page.sourcesPinned}>
            <ol className="rail-srcs">
              {card.sources.map((s, i) => {
                const node = s.id ? graph.nodes.get(s.id) : undefined;
                const role = s.id ? graph.roles.get(s.id) : undefined;
                return (
                  <li key={i}>
                    <span className="num ref">{i + 1}</span>
                    {node || role ? (
                      <button
                        type="button"
                        className="t"
                        onClick={() => onOpen({ kind: node ? "node" : "role", id: s.id! })}
                        title={s.version ? shortHash(s.version.commit) : undefined}
                      >
                        {node ? (
                          <TypeGlyph type={node.type} size={13} />
                        ) : (
                          <Pet id={role!.id} size={14} />
                        )}
                        <span>{node?.name ?? role!.title}</span>
                      </button>
                    ) : (
                      <span className="t">
                        <MaterialName material={s} />
                      </span>
                    )}
                    {s.changedSince && s.version ? (
                      <button
                        type="button"
                        className={`chg${since === i ? " is-open" : ""}`}
                        onClick={() => setSince(since === i ? null : i)}
                        data-tip={t.page.changedTip}
                        data-tip-end=""
                      >
                        <Icon name="clock" size={11} />
                        {t.side.changed}
                      </button>
                    ) : (
                      !s.version && <span className="same">{t.page.unpinned}</span>
                    )}
                  </li>
                );
              })}
              {!card.sources.length && <p className="empty">{t.page.noSources}</p>}
            </ol>
          </RailSection>
        }
        rail={
          <RailSection title={t.page.props}>
            <dl className="props">
              <PropRow label={t.page.lane}>
                {pending ? (
                  <span className="prop-text">{laneName}</span>
                ) : (
                  <span className="prop-text fixed-note">
                    <Icon name="lock" size={13} />
                    {t.page.fixedAt(laneName)}
                  </span>
                )}
              </PropRow>
              <PropRow label={t.props.published}>
                <span className="prop-text">{when(card.publishedAt)}</span>
              </PropRow>
              <PropRow label="id">
                <CopyId id={card.id} onToast={onToast} />
              </PropRow>
            </dl>
          </RailSection>
        }
      />
    </>
  );
}

function DraftPage(props: PageProps & { card: SnapshotCard }) {
  const { graph, card, work, narrow, onOpen, onToast } = props;
  const drag = useDragState();
  const draft = useDraft(card.id);
  const lane = work.laneOf(card);
  const laneName = work.laneName(lane);
  const ids = sourceIds(graph, card, draft);
  const sources = draft?.input.sources ?? card.sources.map((s) => ({ resource: s.resource }));
  const over = drag?.over === `card:${card.id}` && drag.item.kind === "node";
  const [moving, setMoving] = useState<number | null>(null);
  const reorder = (from: number, to: number) =>
    editDraft(card.id, (input) => {
      const next = [...input.sources];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return { ...input, sources: next };
    });
  // The draft on the page is the one written: the tree numbers its sources.
  useEffect(() => {
    if (work.openDraft !== card.id) work.setOpenDraft(card.id);
  }, [card.id]);
  return (
    <>
      <PageTop
        {...props}
        title={draftTitle(card, draft)}
        glyph={<Icon name="edit" size={14} />}
        crumbs={[
          <Crumb key="card">Card</Crumb>,
          <Crumb key="lane">{laneName}</Crumb>,
          <Crumb key="draft">{t.work.draft}</Crumb>,
        ]}
        actions={
          <>
            <span className="muted pg-hint">{saveState(draft)}</span>
            <button
              type="button"
              className="btn plain"
              onClick={() => void work.discard(card.id)}
              disabled={work.publishing === card.id}
            >
              <Icon name="close" size={15} />
              {t.page.discard}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void work.publish(card.id)}
              disabled={!draft || work.publishing === card.id}
              data-tip={t.work.publishTip}
              data-tip-end=""
            >
              <Icon name="send" size={15} />
              {work.publishing === card.id ? t.work.publishing : t.work.publish}
            </button>
          </>
        }
      />
      <PageBody
        narrow={narrow}
        head={
          <>
            <Hero
              icon={
                <span
                  className="hero-grab"
                  onPointerDown={(e) => beginDrag(e, { kind: "card", id: card.id })}
                  data-tip={t.page.dragDraft}
                >
                  <TypeTile kind="draft" size={narrow ? 40 : 52} />
                </span>
              }
              eyebrow={
                <>
                  <b>Card</b>
                  <span className="dot-sep">·</span>
                  <span className="pill pill-draft">{t.work.draft}</span>
                </>
              }
              title={draftTitle(card, draft)}
            />
          </>
        }
        main={
          <>
            <div className="journey">
              <Step
                state="now"
                dot={<Icon name="edit" size={15} />}
                title={t.page.writing}
                sub={t.page.writingSub}
              />
              <Line todo />
              <Step
                state="todo"
                dot={<Icon name="send" size={15} />}
                title={t.page.published}
                sub={t.page.publishSub}
              />
              <Line todo />
              <Step
                state="todo"
                dot={laneIcon(lane, 28)}
                title={t.page.handTo}
                sub={t.page.nowIn(laneName)}
              />
              <Line todo />
              <Step
                state="todo"
                dot={<Icon name="check" size={15} />}
                title={t.page.receive}
                sub={t.page.thenFixed}
              />
            </div>
            <Section title={t.page.where} note={t.page.whereNote}>
              <LanePick work={work} card={card} />
            </Section>
            <Section title={t.card.sources} count={sources.length} note={t.page.sourcesNote}>
              <ol className={`srcs2${over ? " is-over" : ""}`} data-drop={`card:${card.id}`}>
                {sources.map((s, i) => {
                  const id = ids[i];
                  const node = id ? graph.nodes.get(id) : undefined;
                  const role = id ? graph.roles.get(id) : undefined;
                  const latest = node?.history[0] ? graph.commits.get(node.history[0]) : undefined;
                  return (
                    <li
                      key={`${s.resource}:${i}`}
                      className={moving === i ? "is-moving" : ""}
                      draggable={!!draft && work.publishing !== card.id}
                      onDragStart={(e) => {
                        setMoving(i);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => {
                        if (moving === null || moving === i || work.publishing === card.id) return;
                        e.preventDefault();
                        reorder(moving, i);
                        setMoving(i);
                      }}
                      onDragEnd={() => setMoving(null)}
                    >
                      <span className="grip" data-tip={t.page.reorder}>
                        <Icon name="grip" size={14} />
                      </span>
                      <span className="num">{i + 1}</span>
                      {node ? (
                        <TypeGlyph type={node.type} size={15} />
                      ) : role ? (
                        <Pet id={role.id} size={14} />
                      ) : (
                        <Icon name="text" size={15} />
                      )}
                      {node || role ? (
                        <button
                          type="button"
                          className="t"
                          onClick={() => onOpen({ kind: node ? "node" : "role", id: id! })}
                        >
                          {node?.name ?? role!.title}
                        </button>
                      ) : (
                        <span className="t">{s.resource}</span>
                      )}
                      {latest && (
                        <span className="same">{t.page.changedAgo(ago(latest.date))}</span>
                      )}
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
                          <Icon name="close" size={14} />
                        </button>
                      )}
                    </li>
                  );
                })}
                <li className="slot2">
                  {over ? (
                    <>
                      <Icon name="drop" size={13} />
                      {t.work.dropSource(sources.length + 1)}
                    </>
                  ) : (
                    t.page.slot
                  )}
                </li>
              </ol>
            </Section>
            <Section title={t.page.what}>
              <textarea
                className="draft-editor"
                value={draft?.input.prompt ?? card.body}
                disabled={!draft || work.publishing === card.id}
                placeholder={t.work.placeholder}
                aria-label={t.work.what}
                onChange={(e) => {
                  const prompt = e.target.value;
                  editDraft(card.id, (input) => ({ ...input, prompt }));
                }}
              />
            </Section>
          </>
        }
        rail={
          <>
            <div className="rail-note">
              <b>{t.page.draftNoteLead}</b>
              {t.page.draftNote}
            </div>
            <RailSection title={t.page.props}>
              <dl className="props">
                <PropRow label={t.page.lane}>
                  <span className="prop-text">{laneName}</span>
                </PropRow>
                <PropRow label="id">
                  <CopyId id={card.id} onToast={onToast} />
                </PropRow>
              </dl>
            </RailSection>
          </>
        }
      />
    </>
  );
}
