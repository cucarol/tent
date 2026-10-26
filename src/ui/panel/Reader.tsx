import {
  Fragment,
  Suspense,
  lazy,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { useWantDetails } from "../data/details.js";
import { LiveRevisionContext, useHeldSection, useNodeSection } from "../data/node-details.js";
import { handlingFromNodeCards, useHandling } from "../data/handling.js";
import { HandlingRows } from "../components/Handling.js";
import { api, ApiError, describe } from "../data/api.js";
import { cardTitle, primaryOf, type Graph } from "../data/store.js";
import type {
  CodeFacts,
  SnapshotCard,
  SnapshotMaterial,
  SnapshotCommit,
  SnapshotNode,
  SnapshotRef,
  SnapshotRole,
  NodeCardSummary,
} from "../data/types.js";
import { editDraft, isDraft, useDraft, type Draft } from "../data/drafts.js";
import { cardStage, cardStateLabel, resultParts } from "../data/card-state.js";
import { nodeDrafts as drafts } from "../data/node-drafts.js";
import { Icon, TypeGlyph, TypeTile } from "../components/Glyph.js";
import { DirectoryView, FileView } from "./FileView.js";
import { fileOf, FilesContext, infoOf, useFileInfoRead } from "../data/files.js";
import { Tray, Pet, turnPet } from "../components/Pet.js";
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
  ReadState,
  RECENT,
} from "./Details.js";
import { CardMenu, NodeMenu, RoleMenu } from "./Manage.js";
import { Letter, saveState } from "../shell/Dock.js";
import { beginDrag, useDragState } from "../shell/drag.js";
import { draftTitle, moodOf, PUBLIC, sourceIds, type Work } from "../shell/work.js";
import { ago, lineDiff, readStored, resolveHref, shortHash, when, writeStored } from "../util.js";
import { t } from "../i18n.js";
import type { HistoricalSelection } from "../data/history-tree.js";
import { historicalGraph, readHistoricalNode } from "../data/history-tree.js";

// The editor loads only when someone starts editing.
const MarkdownEditor = lazy(() => import("../components/MarkdownEditor.js"));

type Props = {
  historical?: HistoricalSelection;
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
  /** The robots, in a page's bar while the page covers the map and its bar. */
  roles?: ReactNode;
};
/**
 * What a page is laid out for; narrow puts the rail into the one column. Past is set once the title block
 * has scrolled away, and the bar then names the object; toTop scrolls back to it.
 */
type PageProps = Props & {
  narrow: boolean;
  past?: boolean;
  toTop?: () => void;
  directoryPanel: ReactNode;
  onDirectory: (path: string | null) => void;
};

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
  // A page shows links, versions and Cards: opening one is what reads them.
  useWantDetails(target.kind !== "node" && !graph.detailed);
  const box = useRef<HTMLElement>(null);
  const narrow = useWidth(box) < NARROW;
  const historical =
    target.kind === "node" && props.historical?.node.id === target.id
      ? props.historical
      : undefined;
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
  const key = `${target.kind}:${target.id}`;
  const [directory, setDirectory] = useState<{ target: string; path: string | null }>();
  const onDirectory = (path: string | null) => {
    setDirectory({ target: key, path });
    if (path !== null) toTop();
  };
  const directoryPanel =
    directory?.target === key && directory.path !== null ? (
      <DirectoryView
        path={directory.path}
        graph={graph}
        onDirectory={onDirectory}
        onOpen={props.onOpen}
        onToast={props.onToast}
      />
    ) : null;
  const page = { ...props, narrow, past, toTop, directoryPanel, onDirectory };
  return (
    <section
      ref={box}
      className={`reader${props.mode === "panel" ? " is-panel" : ""}`}
      aria-label={props.mode === "panel" ? t.sheet.label : t.reader.label}
      onScrollCapture={onScroll}
    >
      {historical ? (
        <HistoricalNodePage
          {...page}
          historical={historical}
          key={`${historical.version.commit}:${historical.version.path}`}
        />
      ) : (
        node && <NodePage {...page} node={node} key={node.id} />
      )}
      {role && <RolePage {...page} role={role} key={role.id} />}
      {card && isDraft(card) && <DraftPage {...page} card={card} key={card.id} />}
      {card && !isDraft(card) && <CardPage {...page} card={card} key={card.id} />}
      {!historical && !node && !role && !card && (
        <>
          <PageTop {...props} crumbs={[]} />
          <p className="empty pg-missing" role="status">
            {target.kind !== "node" && !graph.detailed ? t.page.reading : t.sheet.notFound}
          </p>
        </>
      )}
    </section>
  );
}

/** The same Node page shell, pinned to exact retained bytes, with no live read or write controls. */
function HistoricalNodePage(props: PageProps & { historical: HistoricalSelection }) {
  const { node, version } = props.historical;
  const [document, setDocument] = useState<{ body: string; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    readHistoricalNode(props.historical, api.historicalNode)
      .then((document) => live && setDocument(document))
      .catch((error) => live && setDocument({ body: "", error: describe(error) }));
    return () => {
      live = false;
    };
  }, [version.commit, version.path, node.id]);
  // Historical text cannot resolve links or images through today's Node/material state.
  const graph = historicalGraph(props.graph, null);
  return (
    <>
      <PageTop
        {...props}
        roles={undefined}
        title={node.name}
        crumbs={[<Crumb key={node.id}>{node.name}</Crumb>]}
      />
      <PageBody
        narrow={props.narrow}
        head={
          <Hero
            title={node.name}
            eyebrow={
              <>
                <b>{node.type || "prompt"}</b>
                <span className="pill">{shortHash(version.commit)}</span>
              </>
            }
          />
        }
        main={
          <div className="pg-doc">
            {document?.error ? (
              <p className="empty">{document.error}</p>
            ) : document ? (
              <Markdown
                body={document.body}
                fromPath={version.path}
                graph={graph}
                onOpen={() => {}}
                historical
              />
            ) : (
              <p className="empty">{t.page.reading}</p>
            )}
          </div>
        }
      />
    </>
  );
}

/**
 * Below the bar, one column at every width, so nothing moves when the page widens (cuca 2026-10-21): the
 * head (title block and what leads into the text), its properties in a strip under it, `lead`, the text,
 * then `rail` and the `tail`.
 */
function PageBody({
  narrow,
  className,
  head,
  props,
  lead,
  main,
  rail,
  tail,
}: {
  narrow: boolean;
  className?: string;
  head: ReactNode;
  props?: ReactNode;
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
          {props && (
            <div className="pg-props" role="group" aria-label={t.page.props}>
              {props}
            </div>
          )}
          {lead && <div className="rail">{lead}</div>}
          {main}
          {rail && <div className="rail">{rail}</div>}
          {tail}
        </article>
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
  roles,
}: Pick<PageProps, "mode" | "past" | "toTop" | "onCollapse" | "onExpand" | "onClose" | "roles"> & {
  /**
   * Beside the map, whose bar already shows where it sits, the panel's bar stays quiet until the title
   * block scrolls away, then names the object; clicking the name goes back up.
   */
  title?: string;
  glyph?: ReactNode;
  crumbs: ReactNode[];
  actions?: ReactNode;
}) {
  // A deep Node keeps its trail readable: the top, then its parent and itself, the rest behind "…".
  const [allCrumbs, setAllCrumbs] = useState(false);
  const trail =
    crumbs.length > 4 && !allCrumbs
      ? [
          crumbs[0],
          <button
            key="more"
            type="button"
            className="pg-crumb-more"
            onClick={() => setAllCrumbs(true)}
            aria-label={t.page.moreCrumbs(crumbs.length - 3)}
            title={t.page.moreCrumbs(crumbs.length - 3)}
          >
            …
          </button>,
          ...crumbs.slice(-2),
        ]
      : crumbs;
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
          {trail.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="sep">/</span>}
              {c}
            </Fragment>
          ))}
        </nav>
      )}
      <div className="pg-actions">
        {mode !== "panel" && roles && (
          <>
            {roles}
            <span className="vsep" />
          </>
        )}
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
function Hero({ icon, eyebrow, title }: { icon?: ReactNode; eyebrow: ReactNode; title: string }) {
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
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="pg-sec">
      <h3>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A list that shows its first few and opens to all of them. */
function More({
  count,
  shown,
  all: allLabel = t.page.showAll,
  children,
}: {
  count: number;
  shown: number;
  /** How the button names everything, "全部 N 张" for Cards. */
  all?: (n: number) => string;
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
          {all ? t.page.showLess : allLabel(count)}
        </button>
      )}
    </>
  );
}

// Worked out by the service from the current files and history; kept briefly so moving between pages
// does not read the whole history again each time.
const FACTS_FOR = 30_000;
let factsRead: { revision: string; at: number; facts: Promise<CodeFacts | null> } | null = null;
function useCodeFacts(revision: string, nodeId: string) {
  const [facts, setFacts] = useState<CodeFacts | null>(null);
  useEffect(() => {
    if (!factsRead || factsRead.revision !== revision || Date.now() - factsRead.at > FACTS_FOR)
      factsRead = { revision, at: Date.now(), facts: api.codeFacts().catch(() => null) };
    let current = true;
    void factsRead.facts.then((f) => current && setFacts(f));
    return () => {
      current = false;
    };
  }, [revision, nodeId]);
  return facts;
}

/**
 * For a Node that covers code: the tests that import it, and the others it often changes with. Tent works
 * them out on each read rather than keeping them in the text, where they would go stale.
 */
function CodeFactsSections({
  graph,
  node,
  narrow,
  onOpen,
}: {
  graph: Graph;
  node: SnapshotNode;
  narrow: boolean;
  onOpen: (ref: SnapshotRef) => void;
}) {
  const facts = useCodeFacts(graph.snapshot.workspace.revision, node.id);
  const mine = facts?.modules.find((m) => m.id === node.id);
  if (!mine) return null;
  const withNodes = mine.coChanges.filter((c) => graph.nodes.has(c.moduleId));
  return (
    <>
      {mine.testedBy.length > 0 && (
        <Section title={t.page.testedBy(mine.testedBy.length)}>
          <div className="fact-list" title={t.page.testedByTip}>
            <More count={mine.testedBy.length} shown={narrow ? 3 : 6} all={t.page.showAllOf}>
              {(n) =>
                mine.testedBy.slice(0, n).map((file) => {
                  const at = file.lastIndexOf("/");
                  return (
                    <span key={file} className="fact-file" title={file}>
                      <Icon name="file" size={13} />
                      <span className="mono">
                        {at >= 0 && <span className="dir">{file.slice(0, at + 1)}</span>}
                        {file.slice(at + 1)}
                      </span>
                    </span>
                  );
                })
              }
            </More>
          </div>
        </Section>
      )}
      {withNodes.length > 0 && (
        <Section title={t.page.changesWith(withNodes.length)}>
          <div className="fact-list" title={t.page.changesWithTip(facts!.commitLimit)}>
            <More count={withNodes.length} shown={narrow ? 3 : 6} all={t.page.showAllOf}>
              {(n) =>
                withNodes.slice(0, n).map((c) => {
                  const other = graph.nodes.get(c.moduleId)!;
                  return (
                    <button
                      key={c.moduleId}
                      type="button"
                      className="fact-node"
                      onClick={() => onOpen({ kind: "node", id: other.id })}
                    >
                      <TypeGlyph type={other.type} size={13} />
                      <span className="t">{other.name}</span>
                      <span className="share" aria-hidden="true">
                        <i style={{ width: `${Math.round(c.ratio * 100)}%` }} />
                      </span>
                      <span className="w">
                        {t.page.changedTogether(c.sharedCommits, c.moduleCommits)}
                      </span>
                    </button>
                  );
                })
              }
            </More>
          </div>
        </Section>
      )}
    </>
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
  const stage = cardStage(card);
  const waiting = stage === "pending" && !draft;
  return (
    <button
      type="button"
      className={`card-line${waiting ? " is-waiting" : draft ? " is-draft" : ""}`}
      onClick={() => onOpen({ kind: "card", id: card.id })}
    >
      <Icon
        name={
          draft
            ? "draft"
            : waiting
              ? "mail"
              : stage === "doing"
                ? "working"
                : stage === "returned"
                  ? "returned"
                  : "check"
        }
        size={14}
      />
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
          {draft ? t.work.draft : `${cardStateLabel(card)} · ${ago(card.publishedAt)}`}
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
  state: "done" | "ok" | "now" | "todo";
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

/** A lane's face: the Role's pet, or the public area's tray. */
const laneIcon = (lane: string, size: number) =>
  lane !== PUBLIC ? <Pet id={lane} size={size} /> : <Tray size={size} />;

/** Which lane a Card sits in; each chip moves it there, except to the Role a published Card returns to. */
function LanePick({ work, card }: { work: Work; card: SnapshotCard }) {
  const at = work.laneOf(card);
  const barred = (lane: string) => !isDraft(card) && card.returnTo === lane;
  return (
    <div className="lanes-pick" role="radiogroup" aria-label={t.page.whereLabel}>
      {work.lanes.map((lane) => (
        <button
          key={lane || "public"}
          type="button"
          role="radio"
          aria-checked={lane === at}
          disabled={work.publishing === card.id || barred(lane)}
          title={barred(lane) ? t.work.notToReturner(work.laneName(lane)) : undefined}
          onClick={() => void work.move(card.id, lane)}
        >
          {laneIcon(lane, 14)}
          {work.laneName(lane)}
        </button>
      ))}
    </div>
  );
}

/** Who a draft's result comes back to, or nobody; each chip sets it. The lane it goes to is left out. */
function ReturnPick({
  work,
  card,
  draft,
}: {
  work: Work;
  card: SnapshotCard;
  draft: Draft | null;
}) {
  const at = draft?.input.returnTo ?? null;
  const off = !draft || work.publishing === card.id;
  return (
    <div className="lanes-pick" role="radiogroup" aria-label={t.page.returnWho}>
      <button
        type="button"
        role="radio"
        aria-checked={at === null}
        disabled={off}
        onClick={() => work.setReturn(card.id, null)}
      >
        <Icon name="minus" size={14} />
        {t.work.noReturn}
      </button>
      {work.returnChoices(card).map((r) => (
        <button
          key={r.id}
          type="button"
          role="radio"
          aria-checked={at === r.id}
          disabled={off}
          onClick={() => work.setReturn(card.id, r.id)}
        >
          <Pet id={r.id} size={14} />
          {r.title}
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
const readNodeDocument = (id: string) => api.node(id);
const readOutgoing = (id: string) => api.nodeRelations(id, "outgoing");
const readIncoming = (id: string) => api.nodeRelations(id, "incoming");

export function NodeCardLine({
  card,
  onOpen,
}: {
  card: NodeCardSummary;
  onOpen: (ref: SnapshotRef) => void;
}) {
  const stage = cardStage(card);
  const lane = card.lane;
  return (
    <button
      type="button"
      className={`card-line${stage === "pending" ? " is-waiting" : ""}`}
      onClick={() => onOpen({ kind: "card", id: card.id })}
    >
      <Icon
        name={
          stage === "pending"
            ? "mail"
            : stage === "doing"
              ? "working"
              : stage === "returned"
                ? "returned"
                : "check"
        }
        size={14}
      />
      <span className="cl-text">
        <span className="t">{card.title || t.card.contextOnly(card.sources.length)}</span>
        <span className="w">
          {laneIcon(lane.id ?? PUBLIC, 13)}
          <span>{lane.id === null ? t.work.public : (lane.title ?? t.work.goneRole(lane.id))}</span>
          <span className="dot-sep">·</span>
          {cardStateLabel(card)} · {ago(card.publishedAt)}
        </span>
      </span>
    </button>
  );
}

function NodePage(props: PageProps & { node: SnapshotNode }) {
  const {
    graph,
    node: mapNode,
    work,
    narrow,
    startEditing,
    onOpen,
    onExpand,
    onLocate,
    onToast,
  } = props;
  const document = useNodeSection(mapNode.id, readNodeDocument);
  const doc = document.data;
  const revision = useContext(LiveRevisionContext) ?? graph.snapshot.workspace.revision;
  const pageKey = JSON.stringify([graph.snapshot.workspace.id, revision, mapNode.id]);
  const countKey = JSON.stringify([graph.snapshot.workspace.id, mapNode.id]);
  // Let the first text arrive before metadata and retained-source scans compete for the disk.
  // A failed body read still permits the other sections to load and retry independently.
  const bodySettled = !!doc || !!document.error;
  // Then the size of the file its header names, so the text and that file's line land together: the
  // service answers in order of work, and behind these scans that small read waited seconds on a large
  // Workspace. They follow it, a second later at most.
  const [fileFirst, setFileFirst] = useState<{
    key: string;
    doc: typeof doc;
    path: string | null;
  } | null>(null);
  const sectionsGo = bodySettled && fileFirst?.key === pageKey && fileFirst.doc === doc;
  const history = useNodeSection(mapNode.id, api.nodeHistory, sectionsGo);
  const cards = useNodeSection(mapNode.id, api.nodeCards, sectionsGo);
  const outgoing = useNodeSection(mapNode.id, readOutgoing, sectionsGo);
  // Comparing materials reads each one, so it waits for the body like the other sections, and the
  // facts already shown stay while a newer revision is compared.
  const materials = useHeldSection(
    mapNode.id,
    useNodeSection(mapNode.id, api.nodeMaterials, sectionsGo),
  );
  const [incomingOpen, setIncomingOpen] = useState(false);
  // Who is on it, from the Card list once the page has it, else from the Cards read for this Node, kept
  // while a newer revision reads them again.
  const handled = useHandling().get(mapNode.id);
  const ownCards = useHeldSection(mapNode.id, cards);
  const handling = graph.detailed ? handled : handlingFromNodeCards(ownCards.data?.items ?? []);
  const incoming = useNodeSection(mapNode.id, readIncoming, incomingOpen && bodySettled);
  const header = headerMaterials(mapNode.notePath, doc?.frontmatter);
  const node = {
    ...mapNode,
    body: doc?.body ?? "",
    links: outgoing.data?.links ?? [],
    materials: outgoing.data?.materials ?? header.materials,
  };
  const fileRead = useFileInfoRead({
    ...graph.snapshot,
    workspace: { ...graph.snapshot.workspace, revision },
    nodes: [node],
  });
  const files = fileRead.files;
  // Known header materials hold their row before the text. Uncertain declarations wait for relations
  // too, with the same one-second cap so a failed or slow read cannot hold the text indefinitely.
  const ownFile = fileOf(node);
  const ownPath = ownFile?.kind === "file" ? ownFile.path : null;
  const [timeout, setTimeoutRead] = useState<{ key: string; doc: typeof doc } | null>(null);
  const waited = timeout?.key === pageKey && timeout.doc === doc;
  useEffect(() => {
    if (!doc) return;
    const timer = setTimeout(() => setTimeoutRead({ key: pageKey, doc }), 1000);
    return () => clearTimeout(timer);
  }, [pageKey, doc]);
  const fileKnown =
    ownFile?.kind !== "file" ||
    (fileRead.current && infoOf(files, ownFile.path) !== undefined) ||
    waited;
  useEffect(() => {
    if (bodySettled && fileKnown) setFileFirst({ key: pageKey, doc, path: ownPath });
  }, [bodySettled, fileKnown, pageKey, doc, ownPath]);
  const fileShown = sectionsGo && fileFirst.path === ownPath;
  const aboveKnown =
    waited ||
    ((fileKnown || fileShown) && (!header.pending || !!outgoing.data || !!outgoing.error));
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
  // What was just saved shows until the next direct document read returns.
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
        document.retry();
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

  // A fresh direct read follows external edits, even when the map's metadata did not change.
  const shownBody = useRef<string | null>(null);
  useEffect(() => {
    if (!doc) return;
    if (
      (shownBody.current !== null &&
        shownBody.current !== doc.body &&
        draft === null &&
        savedBody === null) ||
      (savedBody !== null && savedBody !== doc.body)
    )
      onToast(t.reader.updated);
    shownBody.current = doc.body;
    if (savedBody !== null) setSavedBody(null);
  }, [doc, node.body]);
  const staleBase = editing && !!base && !conflict && !!doc && doc.body !== base.body;
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
      document.retry();
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
  const carried = cards.data?.items ?? [];
  // How many Cards and versions there are, once read this session or once the snapshot is in: their places
  // are held at that height. Unknown, the two sections under the text wait for both reads and come together.
  if (cards.data && history.data)
    seenCounts.set(countKey, {
      revision,
      cards: carried.length,
      versions: history.data.items.length,
    });
  const seen = seenCounts.get(countKey);
  const inSnapshot =
    graph.detailed && graph.snapshot.workspace.revision === revision
      ? graph.nodes.get(node.id)
      : undefined;
  const known =
    (seen?.revision === revision ? seen : undefined) ??
    (inSnapshot && {
      cards: graph.snapshot.cards.filter((c) => c.sources.some((x) => x.id === node.id)).length,
      versions: inSnapshot.history.length,
    });
  const knownCards = known?.cards ?? 0;
  const knownVersions = Math.min(known?.versions ?? 0, RECENT);
  const under = !!known || ((!!cards.data || !!cards.error) && (!!history.data || !!history.error));
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
      <NodeMenu graph={graph} node={mapNode} onGone={props.onClose} onToast={onToast} />
    </>
  );
  // Under the text at every width; successful empty reads leave no section.
  const carriedSection =
    !under ||
    (cards.data && !carried.length && !cards.data.diagnostics.length) ||
    (!cards.data && !cards.error && !knownCards) ? null : (
      <Section title={cards.data ? t.page.carried(carried.length) : t.page.carriedHead}>
        {!cards.data ? (
          <ReadState section={cards} rows={Math.min(knownCards, narrow ? 3 : 6)} kind="card" />
        ) : (
          <More count={carried.length} shown={narrow ? 3 : 6}>
            {(n) =>
              carried.slice(0, n).map((c) => <NodeCardLine key={c.id} card={c} onOpen={onOpen} />)
            }
          </More>
        )}
        {cards.data?.diagnostics.map((diagnostic, i) => (
          <p className="empty" role="alert" key={i}>
            {diagnostic.cardId}
            {diagnostic.resource ? " · " + diagnostic.resource : ""}: {diagnostic.error}
          </p>
        ))}
      </Section>
    );
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
        lead={props.directoryPanel}
        narrow={narrow}
        className={`t-${p}`}
        head={
          <>
            {/* An opened Node needs no type icon: the eyebrow names its type (cuca 2026-10-21). */}
            <Hero
              eyebrow={
                <>
                  <b className={`p-${p}`}>{p}</b>
                  {node.status === "draft" ? (
                    <span className="eyebrow-note">{t.node.undecided}</span>
                  ) : (
                    node.status !== "stable" && (
                      <span className="pill">{t.node.status(node.status)}</span>
                    )
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
            {!!handling?.length && (
              <section className="pg-handling">
                <h3>{t.page.handlingHead}</h3>
                <HandlingRows graph={graph} list={handling} onOpen={onOpen} />
              </section>
            )}
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
                  relations={outgoing.data}
                  live={live}
                  onChange={change}
                  onSave={() => save()}
                  onOpen={follow}
                  onDirectory={props.onDirectory}
                  onToast={onToast}
                />
              </Suspense>
            ) : (
              <>
                <FilesContext.Provider value={files}>
                  {!props.directoryPanel && <FileView node={node} onToast={onToast} />}
                </FilesContext.Provider>
                {!!document.error && body.trim() && <ReadState section={document} />}
                {doc && !aboveKnown && !document.error ? (
                  <p className="empty">{t.page.reading}</p>
                ) : body.trim() ? (
                  <Markdown
                    body={body}
                    fromPath={node.notePath}
                    graph={graph}
                    relations={outgoing.data}
                    onOpen={onOpen}
                    onToast={onToast}
                    onDirectory={props.onDirectory}
                  />
                ) : !doc ? (
                  <ReadState section={document} />
                ) : (
                  !fileOf(node) && <p className="empty">{t.node.noBody}</p>
                )}
              </>
            )}
          </div>
        }
        props={
          <NodeProps
            graph={graph}
            node={node}
            onOpen={onOpen}
            details={{
              history,
              outgoing,
              incoming,
              incomingOpen,
              onIncoming: () => setIncomingOpen(true),
              materials,
              materialsDeclared: header.materials.length,
            }}
          >
            <ReviewRow doc={doc} node={node} />
            <PropRow label="id">
              <CopyId id={node.id} onToast={onToast} />
            </PropRow>
          </NodeProps>
        }
        rail={
          <>
            {carriedSection}
            <CodeFactsSections graph={graph} node={node} narrow={narrow} onOpen={onOpen} />
          </>
        }
        tail={
          under && (
            <Section title={t.page.versions} count={history.data?.items.length}>
              <ReadState section={history} rows={knownVersions} kind="version" />
              {/* Keep this Node's expansion state while a replacement read is pending or failed. */}
              <div hidden={!history.data}>
                <History
                  key={node.id}
                  id={node.id}
                  path={node.notePath}
                  items={history.data?.items ?? []}
                />
              </div>
            </Section>
          )
        }
      />
    </>
  );
}

/**
 * A provisional display for unambiguous Workspace files and addresses. Tent documents and unsupported
 * addresses wait for Core's relations, which alone decide document identity and invalid declarations.
 */
export function headerMaterials(notePath: string, front: Record<string, unknown> | undefined) {
  let pending = false;
  const entry = (
    raw: unknown,
    field: "resource" | "sources",
    index?: number,
  ): SnapshotMaterial[] => {
    const value =
      field === "resource"
        ? raw
        : raw && typeof raw === "object" && "resource" in raw
          ? raw.resource
          : undefined;
    if (typeof value !== "string" || !value.trim()) {
      pending = true;
      return [];
    }
    const resource = value.trim();
    if (resource.includes("\0")) {
      pending = true;
      return [];
    }
    // Core treats bare sources as descriptions, even when they look like files or ids.
    if (
      field === "sources" &&
      !/^(?:\.{1,2}\/|\/)/.test(resource) &&
      !(/^[a-z][a-z\d+.-]*:\S/i.test(resource) && !/\s/.test(resource))
    )
      return [{ kind: "text", resource: value, field, index }];
    try {
      if (/^[a-z][a-z\d+.-]*:/i.test(resource) && !/^[a-z]:[\\/]/i.test(resource)) {
        const uri = new URL(resource);
        // file: addresses can select directories or prefixes; let Core validate them.
        if (uri.protocol !== "file:")
          return [{ kind: "uri", resource: value, uri: uri.href, field, index }];
      } else {
        const clean = decodeURIComponent(resource.split(/[?#]/)[0]!);
        const file = resolveHref(notePath, resource).file;
        if (
          file &&
          file !== ".tent" &&
          file !== ".." &&
          !file.startsWith("../") &&
          !resource.includes("\\") &&
          !clean.includes("\\") &&
          !clean.includes("\0") &&
          !resource.startsWith("//") &&
          !clean.startsWith("//") &&
          !clean.includes("*") &&
          (!clean.endsWith("/") || (resource.endsWith("/") && !/[?#]/.test(resource)))
        )
          return [{ kind: "file", resource: value, workspacePath: file, field, index }];
      }
    } catch {
      // Malformed declarations stay with the checked relation read, never a guessed file tab.
    }
    pending = true;
    return [];
  };
  const sources = Array.isArray(front?.sources) ? front.sources : [];
  if (front?.sources !== undefined && !Array.isArray(front.sources)) pending = true;
  const materials = [
    ...(front?.resource === undefined ? [] : entry(front.resource, "resource")),
    ...sources.flatMap((s: unknown, i: number) => entry(s, "sources", i)),
  ];
  return { materials, pending };
}

/** Counts from this Workspace revision hold each Node's sections when it opens again. */
const seenCounts = new Map<string, { revision: string; cards: number; versions: number }>();

/** A Role's text often opens with a sentence of what it is for; that becomes the lede. */
function splitLede(body: string): [string, string] {
  const trimmed = body.trim();
  const end = trimmed.search(/\n\s*\n/);
  const first = end < 0 ? trimmed : trimmed.slice(0, end);
  if (!first || /^([#>|`*-]|\d+\.|!\[|<)/.test(first)) return ["", body];
  return [first.replace(/\s*\n\s*/g, " "), end < 0 ? "" : trimmed.slice(end)];
}

/** The name a deleted Node or Role had, from the end of its pinned document path. */
function goneName(resource: string): string {
  const last = resource.split("/").pop() ?? resource;
  try {
    return decodeURIComponent(last).replace(/\.md$/, "");
  } catch {
    return last;
  }
}

function RolePage(props: PageProps & { role: SnapshotRole }) {
  const { graph, role, work, narrow, onOpen, onToast } = props;
  const drag = useDragState();
  const here = [...work.laneCards(role.id), ...work.laneReturned(role.id)];
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
          <>
            {/* An archived Role takes no new Cards. */}
            {role.status !== "deprecated" && (
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
            )}
            <RoleMenu
              graph={graph}
              work={work}
              role={role}
              onGone={props.onClose}
              onToast={onToast}
            />
          </>
        }
      />
      <PageBody
        lead={props.directoryPanel}
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
                  <Pet
                    id={role.id}
                    size={narrow ? 44 : 56}
                    mood={moodOf(work.desk(role.id), false)}
                  />
                </button>
              }
              eyebrow={
                <>
                  <b>Role</b>
                  <span className="dot-sep">·</span>
                  <span>{t.page.roleKind}</span>
                  {role.status !== "stable" && (
                    <span className="pill">{t.node.status(role.status)}</span>
                  )}
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
              <Markdown
                body={rest}
                fromPath={role.path}
                graph={graph}
                onOpen={onOpen}
                onToast={onToast}
                onDirectory={props.onDirectory}
              />
            </div>
            <Section title={t.page.here} count={here.length}>
              <div className="letters" data-drop={`lane:${role.id}`}>
                {here.map((c) => (
                  <Letter
                    key={c.id}
                    card={c}
                    work={work}
                    onClick={() => onOpen({ kind: "card", id: c.id })}
                  />
                ))}
                {!here.length && (
                  <div className="lane-empty">
                    <Pet id={role.id} size={26} className="faint" />
                  </div>
                )}
              </div>
            </Section>
            {received.length > 0 && (
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
                </div>
              </Section>
            )}
          </>
        }
        props={
          <dl className="props">
            <PropRow label="Card">
              <span className="prop-text">{t.page.roleCards(here.length, received.length)}</span>
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
  const stage = cardStage(card);
  const status = cardStateLabel(card);
  const back = card.returnTo;
  const backName = back ? work.laneName(back) : "";
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
        actions={
          card.status === "deprecated" ? undefined : <CardMenu card={card} onToast={onToast} />
        }
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
                    className={`pill ${pending || stage === "returned" ? "pill-pending" : stage === "doing" ? "pill-doing" : "pill-consumed"}`}
                  >
                    {status}
                  </span>
                  {card.status === "deprecated" && (
                    <span className="pill">{t.manage.withdrawnPill}</span>
                  )}
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
                state={pending ? "todo" : back ? "done" : "ok"}
                dot={<Icon name="check" size={15} />}
                title={pending ? t.page.receive : t.page.receivedBy(laneName)}
                sub={pending ? t.page.thenFixed : when(card.updatedAt)}
              />
              {back && (
                <>
                  <Line todo={stage === "pending" || stage === "doing"} />
                  <Step
                    state={stage === "pending" ? "todo" : stage === "doing" ? "now" : "ok"}
                    dot={laneIcon(back, 28)}
                    title={t.page.returnStep(backName)}
                    sub={
                      stage === "doing"
                        ? t.page.doingSub
                        : stage === "returned"
                          ? t.page.toCollect(backName)
                          : stage === "closed"
                            ? t.page.collected(backName)
                            : undefined
                    }
                  />
                </>
              )}
            </div>
            {pending && (
              <Section title={t.page.where}>
                <LanePick work={work} card={card} />
              </Section>
            )}
          </>
        }
        main={
          <>
            {card.result && (
              <Section title={t.page.result}>
                <p className="card-result">
                  {resultParts(card.result).map((p, i) =>
                    "nodeId" in p ? (
                      <RefLink
                        key={i}
                        graph={graph}
                        target={{ kind: "node", id: p.nodeId }}
                        onOpen={onOpen}
                      />
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
                </p>
              </Section>
            )}
            <Section title={t.page.what}>
              <div className="pg-doc">
                {body.trim() ? (
                  <Markdown
                    body={body}
                    fromPath={card.path}
                    graph={graph}
                    onOpen={onOpen}
                    onToast={onToast}
                    onDirectory={props.onDirectory}
                  />
                ) : (
                  <p className="empty">{t.card.noText}</p>
                )}
              </div>
            </Section>
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
          <>
            {props.directoryPanel}
            <Section title={t.page.sourcesPinned}>
              <ol className="rail-srcs">
                {card.sources.map((s, i) => {
                  const node = s.id ? graph.nodes.get(s.id) : undefined;
                  const role = s.id ? graph.roles.get(s.id) : undefined;
                  // A Node or Role deleted since: its pinned name, not the encoded path to where it was.
                  const gone = !!s.id && !node && !role && (s.kind === "node" || s.kind === "role");
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
                      ) : gone ? (
                        <span className="t is-gone">{s.title ?? goneName(s.resource)}</span>
                      ) : (
                        <span className="t">
                          <MaterialName material={s} />
                        </span>
                      )}
                      {gone ? (
                        <span className="same">{t.page.sourceGone}</span>
                      ) : s.changedSince && s.version ? (
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
            </Section>
          </>
        }
        props={
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
        glyph={<Icon name="draft" size={14} />}
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
        lead={props.directoryPanel}
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
              {draft?.input.returnTo && (
                <>
                  <Line todo />
                  <Step
                    state="todo"
                    dot={laneIcon(draft.input.returnTo, 28)}
                    title={t.page.returnStep(work.laneName(draft.input.returnTo))}
                  />
                </>
              )}
            </div>
            <Section title={t.page.where}>
              <LanePick work={work} card={card} />
            </Section>
            <Section title={t.page.returnWho}>
              <ReturnPick work={work} card={card} draft={draft} />
            </Section>
            <Section title={t.card.sources} count={sources.length}>
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
        props={
          <dl className="props">
            <PropRow label={t.page.lane}>
              <span className="prop-text">{laneName}</span>
            </PropRow>
            <PropRow label="id">
              <CopyId id={card.id} onToast={onToast} />
            </PropRow>
          </dl>
        }
      />
    </>
  );
}
