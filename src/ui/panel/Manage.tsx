import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, describe } from "../data/api.js";
import { useWantDetails } from "../data/details.js";
import type { Graph } from "../data/store.js";
import type { SnapshotCard, SnapshotNode, SnapshotRole } from "../data/types.js";
import { isDraft } from "../data/drafts.js";
import { cardStage, cardStateLabel } from "../data/card-state.js";
import { PUBLIC, type Work } from "../shell/work.js";
import { Icon, TypeGlyph } from "../components/Glyph.js";
import { t } from "../i18n.js";

export type Item = { label: string; note?: string; danger?: boolean; run: () => void };

/** The quiet ⋯ in a page's bar: the object's rarer actions, the destructive one last and set apart. */
function MoreMenu({ items, initiallyOpen = false }: { items: Item[]; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="more" ref={box}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.manage.more}
        aria-expanded={open}
        aria-haspopup="menu"
        data-tip={open ? undefined : t.manage.more}
        data-tip-end=""
      >
        <Icon name="working" size={16} />
      </button>
      {open && (
        <div className="more-pop" role="menu">
          {items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`more-item${item.danger ? " is-danger" : ""}${item.danger && i > 0 ? " is-apart" : ""}`}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              <span>{item.label}</span>
              {item.note && <small>{item.note}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A small dialog over the page; Enter confirms, Esc or the scrim cancels. */
function Ask({
  title,
  children,
  confirm,
  danger,
  busy,
  disabled,
  instead,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirm: string;
  danger?: boolean;
  busy: boolean;
  disabled?: boolean;
  /** The answer we recommend over the asked one; it takes the default focus. */
  instead?: { label: string; run: () => void };
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // A destructive answer is never the default: Enter on the opened dialog cancels it, or takes the
  // recommended alternative when there is one.
  const go = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const alt = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!document.querySelector(".ask input"))
      (instead ? alt : danger ? back : go).current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        className="ask"
        role="alertdialog"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !disabled) onConfirm();
        }}
      >
        <h2 className="ask-title">{title}</h2>
        {children}
        <div className="ask-actions">
          {/* With a recommended answer, the asked one steps aside to the left. */}
          {instead && (
            <button
              ref={go}
              type="submit"
              className={`btn ${danger ? "danger" : "primary"} ask-aside`}
              disabled={busy || disabled}
            >
              {confirm}
            </button>
          )}
          <button ref={back} type="button" className="btn plain" onClick={onCancel} disabled={busy}>
            {t.app.cancel}
          </button>
          {instead ? (
            <button
              ref={alt}
              type="button"
              className="btn primary"
              onClick={instead.run}
              disabled={busy}
            >
              {busy ? t.manage.working : instead.label}
            </button>
          ) : (
            <button
              ref={go}
              type="submit"
              className={`btn ${danger ? "danger" : "primary"}`}
              disabled={busy || disabled}
            >
              {busy ? t.manage.working : confirm}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

type Common = { onToast: (text: string) => void };

/** Runs one write, reports its outcome and says whether it went through. */
function useRun(onToast: (text: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (write: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await write();
      onToast(done);
      return true;
    } catch (error) {
      onToast(describe(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/** Every Node under this one, however deep. */
function below(graph: Graph, node: SnapshotNode): SnapshotNode[] {
  return node.childIds.flatMap((id) => {
    const child = graph.nodes.get(id);
    return child ? [child, ...below(graph, child)] : [];
  });
}

/**
 * The archive this Node can undo: the newest `node.archive` commit on its history that archived
 * exactly its own subtree (Core restores only a commit whose changes all sit under the Node).
 */
export function archiveCommitOf(graph: Graph, node: SnapshotNode): string | undefined {
  const inside = (path: string) => path.startsWith(node.path + "/");
  return node.history
    .map((hash) => graph.snapshot.commits.find((c) => c.hash === hash))
    .find(
      (c) =>
        c?.operation === "node.archive" &&
        c.files.length > 0 &&
        c.files.every((f) => inside(f.path)) &&
        c.files.some((f) => f.path === node.notePath),
    )?.hash;
}

/**
 * What deleting a Node takes with it: every Node under it, the links from outside into any of them
 * (links inside the subtree go with it; Card sources are counted apart) and the Cards that carry one.
 */
export function deleteImpact(graph: Graph, node: SnapshotNode) {
  const kids = below(graph, node);
  const inside = new Set([node.id, ...kids.map((k) => k.id)]);
  const links = [node, ...kids]
    .flatMap((n) => n.incoming)
    .filter((i) => i.from.kind !== "card" && !inside.has(i.from.id)).length;
  const cards = graph.snapshot.cards.filter(
    (c) => !isDraft(c) && c.sources.some((s) => s.id && inside.has(s.id)),
  ).length;
  return { kids, links, cards };
}

const TYPES = ["goal", "prompt", "output"] as const;

/**
 * A Node's actions as menu items, with the dialogs they open. The page's ⋯ takes the usual ones; the
 * sidebar's right click (`tree`) adds making a Node under it, moving it and copying its id or path. Delete
 * comes last, after archive, which is what we recommend.
 */
export function useNodeActions({
  graph,
  node,
  onGone,
  onToast,
  onMade,
  tree = false,
}: Common & {
  graph: Graph;
  node: SnapshotNode;
  onGone: () => void;
  /** A Node made under this one; the sidebar opens it. */
  onMade?: (id: string) => void;
  tree?: boolean;
}) {
  const [asking, setAsking] = useState<"rename" | "delete" | "child" | "move" | null>(null);
  const [name, setName] = useState(node.name);
  const [type, setType] = useState<(typeof TYPES)[number]>("prompt");
  const [find, setFind] = useState("");
  const [busy, run] = useRun(onToast);
  const archived = node.status === "deprecated";
  const restoreFrom = archived ? archiveCommitOf(graph, node) : undefined;
  const copy = (text: string) => () =>
    void navigator.clipboard
      .writeText(text)
      .then(() => onToast(t.manage.copied(text)))
      .catch(() => onToast(text));
  const items: Item[] = [
    ...(tree
      ? [
          {
            label: t.manage.newChild,
            run: () => {
              setName("");
              setAsking("child");
            },
          },
        ]
      : []),
    {
      label: t.manage.rename,
      run: () => {
        setName(node.name);
        setAsking("rename");
      },
    },
    ...(tree
      ? [
          {
            label: t.manage.moveNode,
            run: () => {
              setFind("");
              setAsking("move");
            },
          },
        ]
      : []),
    // The page shows no id row; it is copied from here (2026-10-27).
    { label: t.manage.copyId, run: copy(node.id) },
    ...(tree ? [{ label: t.manage.copyPath, run: copy(`.tent/${node.notePath}`) }] : []),
    ...(!archived
      ? [
          {
            label: t.manage.archive,
            note: t.manage.archiveNote(below(graph, node).length) || undefined,
            run: () => void run(() => api.archiveNode(node.id), t.manage.archived(node.name)),
          },
        ]
      : restoreFrom
        ? [
            {
              label: t.manage.restore,
              run: () =>
                void run(() => api.restoreNode(node.id, restoreFrom), t.manage.restored(node.name)),
            },
          ]
        : []),
    // What deleting breaks comes with the snapshot; until it is in, there is nothing to tell, so no delete.
    ...(graph.detailed
      ? [{ label: t.manage.delete, danger: true, run: () => setAsking("delete") }]
      : []),
  ];
  const trimmed = name.trim();
  // Where it can move: anywhere but into itself, or where it already is.
  const inside = new Set([node.id, ...below(graph, node).map((k) => k.id)]);
  const q = find.trim().toLowerCase();
  const places = graph.snapshot.nodes
    .filter((n) => !inside.has(n.id) && n.id !== node.parentId && n.status !== "deprecated")
    .filter((n) => !q || n.name.toLowerCase().includes(q))
    .slice(0, 40);
  const moveTo = async (parent: string | null) => {
    const into = parent ? (graph.nodes.get(parent)?.name ?? parent) : null;
    if (await run(() => api.moveNode(node.id, { parent }), t.work.movedNode(node.name, 1, into)))
      setAsking(null);
  };
  const dialogs = (
    <>
      {asking === "rename" && (
        <Ask
          title={t.manage.renameTitle}
          confirm={t.manage.rename}
          busy={busy}
          disabled={!trimmed || trimmed === node.name}
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            if (await run(() => api.renameNode(node.id, trimmed), t.manage.renamed(trimmed)))
              setAsking(null);
          }}
        >
          <label className="ask-field">
            <span>{t.manage.nameLabel}</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <p className="ask-note">{t.manage.renameNote}</p>
        </Ask>
      )}
      {asking === "child" && (
        <Ask
          title={t.manage.newChildTitle(node.name)}
          confirm={t.manage.make}
          busy={busy}
          disabled={!trimmed}
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            let made = "";
            const ok = await run(async () => {
              made = (await api.createNode(node.id, trimmed, type)).nodeId;
            }, t.manage.made(trimmed));
            if (!ok) return;
            setAsking(null);
            onMade?.(made);
          }}
        >
          <label className="ask-field">
            <span>{t.manage.nameLabel}</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="ask-types" role="radiogroup" aria-label={t.manage.typeLabel}>
            {TYPES.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={type === k}
                className={`ask-type${type === k ? " is-on" : ""}`}
                onClick={() => setType(k)}
              >
                <TypeGlyph type={k} size={14} />
                {k}
              </button>
            ))}
          </div>
        </Ask>
      )}
      {asking === "move" && (
        <Ask
          title={t.manage.moveTitle(node.name)}
          confirm={t.manage.moveTop}
          busy={busy}
          disabled={node.parentId === null}
          onCancel={() => setAsking(null)}
          onConfirm={() => void moveTo(null)}
        >
          <input
            className="ask-find"
            autoFocus
            value={find}
            placeholder={t.manage.moveFind}
            aria-label={t.manage.moveFind}
            onChange={(e) => setFind(e.target.value)}
          />
          <div className="ask-places" role="listbox" aria-label={t.manage.moveTitle(node.name)}>
            {places.map((n) => (
              <button
                key={n.id}
                type="button"
                role="option"
                aria-selected={false}
                className="ask-place"
                disabled={busy}
                onClick={() => void moveTo(n.id)}
              >
                <TypeGlyph type={n.type} size={13} />
                <span className="ask-place-name">{n.name}</span>
                <span className="ask-place-path">
                  {graph
                    .ancestors(n.id)
                    .map((a) => a.name)
                    .join(" / ")}
                </span>
              </button>
            ))}
          </div>
          <p className="ask-note">{t.manage.moveNote}</p>
        </Ask>
      )}
      {asking === "delete" && (
        <DeleteAsk
          graph={graph}
          node={node}
          busy={busy}
          run={run}
          onGone={onGone}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  );
  return { items, dialogs };
}

function DeleteAsk({
  graph,
  node,
  busy,
  run,
  onGone,
  onCancel,
}: {
  graph: Graph;
  node: SnapshotNode;
  busy: boolean;
  run: ReturnType<typeof useRun>[1];
  onGone: () => void;
  onCancel: () => void;
}) {
  const { kids, links, cards } = deleteImpact(graph, node);
  return (
    <Ask
      title={t.manage.deleteTitle(node.name)}
      confirm={t.manage.delete}
      danger
      busy={busy}
      onCancel={onCancel}
      onConfirm={async () => {
        if (await run(() => api.deleteNode(node.id), t.manage.deleted(node.name))) {
          onCancel();
          onGone();
        }
      }}
    >
      <ul className="ask-list">
        {kids.length > 0 && <li className="is-strong">{t.manage.deleteKids(kids.length)}</li>}
        {links > 0 && <li>{t.manage.deleteLinks(links)}</li>}
        {cards > 0 && <li>{t.manage.deleteCards(cards)}</li>}
        <li>{t.manage.deleteKeeps}</li>
      </ul>
      {node.status !== "deprecated" && <p className="ask-note">{t.manage.deleteArchiveHint}</p>}
    </Ask>
  );
}

export function NodeMenu(props: Common & { graph: Graph; node: SnapshotNode; onGone: () => void }) {
  const { items, dialogs } = useNodeActions(props);
  const [requested, setRequested] = useState(false);
  const wantDetails = useWantDetails(false);
  if (!props.graph.detailed)
    return (
      <button
        type="button"
        className="icon-btn"
        aria-label={t.manage.more}
        data-tip={requested ? t.page.reading : t.manage.more}
        onClick={() => {
          setRequested(true);
          wantDetails();
        }}
      >
        <Icon name="working" size={16} />
      </button>
    );
  return (
    <>
      <MoreMenu items={items} initiallyOpen={requested} />
      {dialogs}
    </>
  );
}

/** A menu at the pointer, for a right click: the same items as a ⋯, closed by a click away or Esc. */
export function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  items: Item[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState(at);
  useLayoutEffect(() => {
    // Kept on screen: a menu opened near an edge opens the other way.
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setSpot({
      x: Math.min(at.x, window.innerWidth - r.width - 8),
      y: at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y,
    });
    box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [at.x, at.y]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={box}
      className="more-pop is-context"
      role="menu"
      style={{ left: spot.x, top: spot.y }}
      onKeyDown={(e) => {
        const all = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const now = all.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          all[(now + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
        }
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`more-item${item.danger ? " is-danger" : ""}${item.danger && i > 0 ? " is-apart" : ""}`}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.note && <small>{item.note}</small>}
        </button>
      ))}
    </div>
  );
}

/**
 * Cards that keep this Role from being deleted (judge 2026-10-17, node-cardreturnbounds17): pending ones
 * addressed to it, and unfinished returns, those coming back to it and those it took and still owes.
 * Pending ones can move elsewhere; withdrawing any of them lets the Role go. A Card moving right now
 * already counts in its new lane.
 */
export function waitingFor(
  work: Pick<Work, "laneCards">,
  cards: readonly SnapshotCard[],
  role: SnapshotRole,
): SnapshotCard[] {
  const here = work.laneCards(role.id).filter((c) => !isDraft(c));
  const owed = cards.filter(
    (c) =>
      !isDraft(c) &&
      c.status !== "deprecated" &&
      !here.includes(c) &&
      ((c.returnTo === role.id && c.state !== "closed") ||
        (c.receivedBy === role.id && cardStage(c) === "doing")),
  );
  return [...here, ...owed];
}

export function RoleMenu({
  graph,
  work,
  role,
  onGone,
  onToast,
}: Common & { graph: Graph; work: Work; role: SnapshotRole; onGone: () => void }) {
  const [busy, run] = useRun(onToast);
  // The ETag read when the dialog opened: deleting removes the version the user looked at.
  const [asking, setAsking] = useState<{ etag: string } | null>(null);
  const archived = role.status === "deprecated";
  const flip = () =>
    run(
      async () => api.setRoleArchived(role.id, (await api.role(role.id)).etag, !archived),
      archived ? t.manage.restored(role.title) : t.manage.archived(role.title),
    );
  const ask = async () => {
    try {
      setAsking({ etag: (await api.role(role.id)).etag });
    } catch (error) {
      onToast(describe(error));
    }
  };
  const waiting = waitingFor(work, graph.snapshot.cards, role);
  const received = graph.snapshot.cards.filter((c) => c.receivedBy === role.id).length;
  const links = role.incoming.filter((i) => i.from.kind !== "card").length;
  return (
    <>
      <MoreMenu
        items={
          busy
            ? []
            : [
                {
                  label: archived ? t.manage.restore : t.manage.archive,
                  note: archived ? undefined : t.manage.roleArchiveNote,
                  run: () => void flip(),
                },
                { label: t.manage.delete, danger: true, run: () => void ask() },
              ]
        }
      />
      {asking && (
        <Ask
          title={t.manage.roleDeleteTitle(role.title)}
          confirm={t.manage.delete}
          danger
          busy={busy}
          disabled={waiting.length > 0}
          instead={
            archived
              ? undefined
              : {
                  label: t.manage.archiveInstead,
                  run: async () => {
                    if (await flip()) setAsking(null);
                  },
                }
          }
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            const gone = await run(
              () => api.deleteRole(role.id, asking.etag),
              t.manage.deleted(role.title),
            );
            if (gone) {
              setAsking(null);
              onGone();
            }
          }}
        >
          {waiting.length > 0 && (
            <div className="ask-wait">
              <p className="ask-wait-head">{t.manage.roleWaiting(waiting.length)}</p>
              <ul>
                {waiting.map((card) => (
                  <Waiting key={card.id} card={card} role={role} work={work} onToast={onToast} />
                ))}
              </ul>
            </div>
          )}
          <ul className="ask-list">
            <li className="is-strong">{t.manage.roleDeleteFinal}</li>
            {received > 0 && <li>{t.manage.roleDeleteReceived(received)}</li>}
            {links > 0 && <li>{t.manage.roleDeleteLinks(links)}</li>}
            <li>{t.manage.roleDeleteKeeps}</li>
          </ul>
          {!archived && <p className="ask-note">{t.manage.roleArchiveHint}</p>}
        </Ask>
      )}
    </>
  );
}

/** The public lane is "", which a select cannot tell from its placeholder. */
const PUBLIC_KEY = "@public";

/** One Card holding up the delete: hand it to another lane or withdraw it, right here. */
function Waiting({
  card,
  role,
  work,
  onToast,
}: Common & { card: SnapshotCard; role: SnapshotRole; work: Work }) {
  const [busy, run] = useRun(onToast);
  const [sure, setSure] = useState(false);
  // Only a pending Card can move, and never to the Role it returns to.
  const movable = card.state === "pending" && card.returnTo !== role.id;
  const lanes = work.lanes.filter((lane) => lane !== role.id && lane !== card.returnTo);
  return (
    <li className="ask-wait-row">
      <span className="ask-wait-title">{work.title(card)}</span>
      {!movable && <span className="ask-wait-state">{cardStateLabel(card)}</span>}
      {movable && (
        <select
          className="ask-pick"
          aria-label={t.manage.moveTo}
          value=""
          disabled={busy || work.publishing === card.id}
          onChange={(e) =>
            void work.move(card.id, e.target.value === PUBLIC_KEY ? PUBLIC : e.target.value)
          }
        >
          <option value="" disabled>
            {t.manage.moveTo}
          </option>
          {lanes.map((lane) => (
            <option key={lane || PUBLIC_KEY} value={lane || PUBLIC_KEY}>
              {work.laneName(lane)}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={`btn ${sure ? "danger" : "plain"}`}
        disabled={busy}
        onClick={() => {
          if (!sure) return setSure(true);
          void run(
            async () => api.deprecateCard(card.id, (await api.card(card.id)).etag),
            t.manage.withdrawn,
          );
        }}
        onBlur={() => setSure(false)}
      >
        {sure ? t.manage.withdrawSure : t.manage.withdrawShort}
      </button>
    </li>
  );
}

export function CardMenu({ card, onToast }: Common & { card: SnapshotCard }) {
  const [asking, setAsking] = useState(false);
  const [busy, run] = useRun(onToast);
  if (isDraft(card) || card.status === "deprecated") return null;
  return (
    <>
      <MoreMenu items={[{ label: t.manage.withdraw, danger: true, run: () => setAsking(true) }]} />
      {asking && (
        <Ask
          title={t.manage.withdrawTitle}
          confirm={t.manage.withdraw}
          danger
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={async () => {
            const done = await run(
              async () => api.deprecateCard(card.id, (await api.card(card.id)).etag),
              t.manage.withdrawn,
            );
            if (done) setAsking(false);
          }}
        >
          <p className="ask-note">{t.manage.withdrawNote}</p>
        </Ask>
      )}
    </>
  );
}
