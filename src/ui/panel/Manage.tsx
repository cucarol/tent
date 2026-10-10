import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, describe } from "../data/api.js";
import type { Graph } from "../data/store.js";
import type { SnapshotCard, SnapshotNode, SnapshotRole } from "../data/types.js";
import { isDraft } from "../data/drafts.js";
import { PUBLIC, type Work } from "../shell/work.js";
import { Icon } from "../components/Glyph.js";
import { t } from "../i18n.js";

type Item = { label: string; note?: string; danger?: boolean; run: () => void };

/** The quiet ⋯ in a page's bar: the object's rarer actions, the destructive one last and set apart. */
function MoreMenu({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
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

export function NodeMenu({
  graph,
  node,
  onGone,
  onToast,
}: Common & { graph: Graph; node: SnapshotNode; onGone: () => void }) {
  const [asking, setAsking] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(node.name);
  const [busy, run] = useRun(onToast);
  const { kids, links, cards } = deleteImpact(graph, node);
  const archived = node.status === "deprecated";
  const restoreFrom = archived ? archiveCommitOf(graph, node) : undefined;
  const items: Item[] = [
    {
      label: t.manage.rename,
      run: () => {
        setName(node.name);
        setAsking("rename");
      },
    },
    ...(!archived
      ? [
          {
            label: t.manage.archive,
            note: t.manage.archiveNote(kids.length) || undefined,
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
    { label: t.manage.delete, danger: true, run: () => setAsking("delete") },
  ];
  const trimmed = name.trim();
  return (
    <>
      <MoreMenu items={items} />
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
      {asking === "delete" && (
        <Ask
          title={t.manage.deleteTitle(node.name)}
          confirm={t.manage.delete}
          danger
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={async () => {
            if (await run(() => api.deleteNode(node.id), t.manage.deleted(node.name))) {
              setAsking(null);
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
          {!archived && <p className="ask-note">{t.manage.deleteArchiveHint}</p>}
        </Ask>
      )}
    </>
  );
}

/**
 * Pending Cards still addressed to this Role: Core refuses to delete it until each moves elsewhere or
 * is withdrawn. A Card moving right now already counts in its new lane.
 */
export function waitingFor(work: Pick<Work, "laneCards">, role: SnapshotRole): SnapshotCard[] {
  return work.laneCards(role.id).filter((c) => !isDraft(c));
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
  const waiting = waitingFor(work, role);
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
  const lanes = work.lanes.filter((lane) => lane !== role.id);
  return (
    <li className="ask-wait-row">
      <span className="ask-wait-title">{work.title(card)}</span>
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
