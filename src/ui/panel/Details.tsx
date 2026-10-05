/**
 * Pieces the pages (Reader.tsx) put together, as a page or as the panel beside the map: links to other
 * objects, a Node's properties, version history and file diffs.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { Graph } from "../data/store.js";
import { api, ApiError, describe, type NodeDocument } from "../data/api.js";
import type {
  SnapshotFile,
  SnapshotIncoming,
  SnapshotMaterial,
  SnapshotNode,
  SnapshotRef,
  SyncFlag,
} from "../data/types.js";
import { CardGlyph, Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { ago, inlineDiff, shortHash, trimSegments, when, type Segment } from "../util.js";
import { t } from "../i18n.js";

const glyphOf = (graph: Graph, target: SnapshotRef, size = 15) =>
  target.kind === "node" ? (
    <TypeGlyph type={graph.nodes.get(target.id)?.type ?? "prompt"} size={size} />
  ) : target.kind === "role" ? (
    <Pet id={target.id} size={14} />
  ) : (
    <CardGlyph size={size} />
  );

/** A link to another object: its icon and name; `note` says how it is linked, `flag` warns. */
export function RefLink({
  graph,
  target,
  onOpen,
  note,
  flag,
}: {
  graph: Graph;
  target: SnapshotRef;
  onOpen: (ref: SnapshotRef) => void;
  note?: string;
  flag?: string;
}) {
  const glyph = glyphOf(graph, target);
  if (!graph.exists(target))
    return (
      <span className="ref-link missing">
        {glyph}
        <span>{target.id}</span>
      </span>
    );
  return (
    <button
      type="button"
      className="ref-link"
      onClick={() => onOpen(target)}
      data-tip={note}
      title={target.kind === "card" ? graph.name(target) : undefined}
    >
      {glyph}
      <span>{graph.name(target)}</span>
      {flag && <small className="ref-flag">{flag}</small>}
    </button>
  );
}

function Stat({ add, del }: { add: number; del: number }) {
  return (
    <span className="stat">
      <span className="add">+{add}</span>
      <span className="del">−{del}</span>
    </span>
  );
}

const patches = new Map<string, Promise<string>>();
const loaded = new Map<string, string>();
const patchKey = (file: SnapshotFile) =>
  `${file.after?.commit ?? file.before?.commit}:${file.path}`;

/** One file's change as a unified patch; created and deleted documents show whole. */
function patchOf(file: SnapshotFile): Promise<string> {
  const key = patchKey(file);
  let patch = patches.get(key);
  if (!patch) {
    patch = (async () => {
      if (file.before && file.after) {
        const lines = (await api.diff(file.before, file.after)).text.split("\n");
        const start = lines.findIndex((line) => line.startsWith("@@"));
        return (start < 0 ? [] : lines.slice(start))
          .filter((line) => !line.startsWith("\\ No newline"))
          .join("\n")
          .trimEnd();
      }
      const sign = file.after ? "+" : "-";
      const { raw } = await api.document((file.after ?? file.before)!);
      return raw
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => sign + line)
        .join("\n");
    })();
    patch.then(
      (text) => loaded.set(key, text),
      () => patches.delete(key),
    );
    patches.set(key, patch);
  }
  return patch;
}

function countLines(patch: string) {
  const lines = patch.split("\n");
  return {
    add: lines.filter((line) => line.startsWith("+")).length,
    del: lines.filter((line) => line.startsWith("-")).length,
  };
}

export function FileDiff({ file, onLoad }: { file: SnapshotFile; onLoad?: () => void }) {
  const [patch, setPatch] = useState<string | null>(() => loaded.get(patchKey(file)) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    patchOf(file).then(
      (text) => {
        if (!live) return;
        setPatch(text);
        onLoad?.();
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [patchKey(file)]);
  if (failed) return <p className="empty">{t.history.diffFailed}</p>;
  if (patch === null) return <p className="empty">{t.history.diffLoading}</p>;
  return <Patch patch={patch} />;
}

type PatchRow =
  | { kind: "hunk"; line?: number }
  | { kind: "same" | "add" | "del"; text: string }
  | { kind: "edit"; segments: Segment[] };

/** Patch lines as rows to read: a lightly edited line shows once, with its changes marked in place. */
function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let dels: string[] = [],
    adds: string[] = [];
  const flush = () => {
    const paired = Math.min(dels.length, adds.length);
    for (let i = 0; i < paired; i++) {
      const segments = inlineDiff(dels[i]!, adds[i]!);
      if (segments) rows.push({ kind: "edit", segments: trimSegments(segments) });
      else rows.push({ kind: "del", text: dels[i]! }, { kind: "add", text: adds[i]! });
    }
    for (const text of dels.slice(paired)) rows.push({ kind: "del", text });
    for (const text of adds.slice(paired)) rows.push({ kind: "add", text });
    dels = [];
    adds = [];
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("-")) dels.push(line.slice(1));
    else if (line.startsWith("+")) adds.push(line.slice(1));
    else {
      flush();
      if (line.startsWith("@@")) {
        const start = /\+(\d+)/.exec(line)?.[1];
        rows.push({ kind: "hunk", ...(start ? { line: Number(start) } : {}) });
      } else rows.push({ kind: "same", text: line.slice(1) });
    }
  }
  flush();
  return rows;
}

export function Patch({ patch }: { patch: string }) {
  return (
    <div className="patch">
      {patchRows(patch).map((row, i) =>
        row.kind === "hunk" ? (
          <div key={i} className="hunk">
            {row.line ? t.history.fromLine(row.line) : "⋯"}
          </div>
        ) : row.kind === "edit" ? (
          <div key={i} className="edit">
            {row.segments.map((s, k) =>
              s.kind === "same" ? (
                s.text
              ) : s.kind === "del" ? (
                <del key={k}>{s.text}</del>
              ) : (
                <ins key={k}>{s.text}</ins>
              ),
            )}
          </div>
        ) : (
          <div key={i} className={row.kind === "same" ? "" : row.kind}>
            {row.text || " "}
          </div>
        ),
      )}
    </div>
  );
}

/** How many versions show before "show all". */
const RECENT = 6;

/** A document's versions as a timeline, newest first; each opens to show what it changed. */
export function History({
  graph,
  id,
  path,
  hashes,
}: {
  graph: Graph;
  id: string;
  path: string;
  hashes: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [, redraw] = useState(0);
  useEffect(() => {
    setOpen(null);
    setAll(false);
  }, [path]);
  if (!hashes.length) return <p className="empty">{t.history.none}</p>;
  // A renamed or moved document keeps its id; its older versions sit at the old path.
  const shown = (all ? hashes : hashes.slice(0, RECENT)).flatMap((h) => {
    const c = graph.commits.get(h);
    const f =
      c?.files.find((x) => x.ref?.id === id) ?? c?.files.find((x) => x.path === path && !x.ref);
    return c && f ? [{ h, c, f }] : [];
  });
  return (
    <>
      <ol className="versions">
        {shown.map(({ h, c, f }) => {
          const patch = loaded.get(patchKey(f));
          return (
            <li key={h} className={open === h ? "is-open" : ""}>
              <button
                type="button"
                className="version-row"
                onClick={() => setOpen(open === h ? null : h)}
                aria-expanded={open === h}
              >
                <span className="version-dot" />
                <span className="version-what">
                  <span className="version-kind">
                    {f.status === "A"
                      ? t.history.created
                      : f.status === "D"
                        ? t.history.deleted
                        : t.history.changed}
                  </span>
                  <span className="version-when">{when(c.date)}</span>
                </span>
                {patch !== undefined && <Stat {...countLines(patch)} />}
                <span className="version-hash">{shortHash(h)}</span>
              </button>
              {open === h && <FileDiff file={f} onLoad={() => redraw((n) => n + 1)} />}
            </li>
          );
        })}
      </ol>
      {hashes.length > RECENT && (
        <button type="button" className="versions-more" onClick={() => setAll((a) => !a)}>
          {all ? t.history.showFewer : t.history.showAll(hashes.length)}
          <Icon name={all ? "chevron" : "down"} size={13} />
        </button>
      )}
    </>
  );
}

/** A newer version only matters as a warning while the Card that pinned the old one is still waiting to be received. */
const pendingCard = (graph: Graph, ref: SnapshotRef) =>
  ref.kind === "card" && graph.cards.get(ref.id)?.state === "pending";

function incomingNote(i: SnapshotIncoming) {
  return `${t.rel.via(i.via)}${i.version ? t.rel.pinnedAt(shortHash(i.version.commit)) : ""}`;
}

/**
 * A material on one line, the part that names it first: a file's name before its folder, a web
 * address's site before its path. The full address shows on hover.
 */
export function MaterialName({ material: m }: { material: SnapshotMaterial }) {
  const full = m.workspacePath ?? m.uri ?? m.resource;
  let lead = full,
    rest = "";
  if (m.uri) {
    const bare = full.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
    const slash = bare.indexOf("/");
    [lead, rest] = slash > 0 ? [bare.slice(0, slash), bare.slice(slash)] : [bare, ""];
  } else if (m.workspacePath) {
    const slash = full.lastIndexOf("/");
    [lead, rest] = slash >= 0 ? [full.slice(slash + 1), full.slice(0, slash + 1)] : [full, ""];
  }
  return (
    <span className={`material${m.uri ? " is-uri" : ""}`} title={m.resource}>
      <Icon name={m.uri ? "globe" : "file"} size={15} />
      <span className="material-lead">{lead}</span>
      {rest && <span className="material-rest">{rest}</span>}
    </span>
  );
}

/** Label and value rows under a title, like the properties of an issue. */
type Verification = { by: string; at: string };
/** OKF allows one mapping or a list; the latest `at` is the one that counts. */
function latestVerification(value: unknown): Verification | null {
  const list = (Array.isArray(value) ? value : value ? [value] : []) as Partial<Verification>[];
  return (
    list
      .filter((v): v is Verification => typeof v?.by === "string" && typeof v?.at === "string")
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
  );
}

/**
 * Whether someone checked this Node against its materials, and the way to say so. A behind Node names
 * what changed; confirming signs with the name set in settings, or the service's OS user.
 */
export function ReviewRow({
  node,
  doc,
  disabled = false,
  flag,
  onRead,
  onToast,
}: {
  node: SnapshotNode;
  doc: NodeDocument | null;
  disabled?: boolean;
  flag?: SyncFlag;
  onRead: (doc: NodeDocument) => void;
  onToast: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const last = latestVerification(doc?.frontmatter.verified);
  const tier = doc?.trustTier ?? "unverified";
  const confirm = async () => {
    if (!doc || disabled || busy) return;
    setBusy(true);
    try {
      await confirmDisplayedNode(doc);
      onRead(await api.node(node.id));
      onToast(t.review.confirmed);
    } catch (error) {
      onToast(
        error instanceof ApiError && error.code === "ETAG_CONFLICT"
          ? t.review.conflict
          : describe(error),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <PropRow label={t.review.label}>
      <div className="review">
        {flag?.behind && <span className="review-why">{t.map.behindWhy(flag.behind.reasons)}</span>}
        <span className={`review-tier is-${tier}`}>
          {t.review.tier[tier]}
          {last && <span className="review-by">{t.review.by(last.by, ago(last.at))}</span>}
        </span>
        <button
          type="button"
          className={`review-confirm${flag?.behind ? " is-behind" : ""}`}
          onClick={confirm}
          disabled={busy || disabled || !doc}
          data-tip={t.review.confirmTip}
        >
          <Icon name="check" size={13} />
          {busy ? t.review.confirming : t.review.confirm}
        </button>
      </div>
    </PropRow>
  );
}

/** Confirmation applies to the complete document the reader displayed, even if the file changed. */
export const confirmDisplayedNode = (doc: NodeDocument) => api.confirmNode(doc.nodeId, doc.etag);

export function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Where a Node sits and what it touches: versions, Roles, parent and children, the documents it links to,
 * what cites it, and its materials. Replaces a separate relations page.
 */
export function NodeProps({
  graph,
  node,
  onOpen,
  onHistory,
  children,
}: {
  graph: Graph;
  node: SnapshotNode;
  onOpen: (ref: SnapshotRef) => void;
  onHistory?: () => void;
  /** Rows the page adds after these. */
  children?: ReactNode;
}) {
  const family = new Set([node.id, node.parentId, ...node.childIds]);
  const outgoing = [
    ...new Map(
      [
        ...node.links.flatMap((l) => (l.ref ? [l.ref] : [])),
        ...node.materials.flatMap((m) =>
          (m.kind === "node" || m.kind === "role") && m.id ? [{ kind: m.kind, id: m.id }] : [],
        ),
      ]
        .filter((r) => !(r.kind === "node" && family.has(r.id)))
        .map((r) => [`${r.kind}:${r.id}`, r as SnapshotRef]),
    ).values(),
  ];
  // Links between parent and child are already the tree; the rest is what really cites it.
  const incoming = node.incoming.filter(
    (i) => !(i.from.kind === "node" && family.has(i.from.id) && i.via === "link"),
  );
  const files = node.materials.filter((m) => m.kind !== "node" && m.kind !== "role");
  const roles = graph.rolesOf(node.id);
  const latest = node.history[0] ? graph.commits.get(node.history[0]) : undefined;
  return (
    <dl className="props">
      <PropRow label={t.props.versions}>
        {latest ? (
          <button type="button" className="ref-link plain" onClick={onHistory}>
            <Icon name="clock" size={15} />
            <span>{t.props.versionsValue(node.history.length, ago(latest.date))}</span>
          </button>
        ) : (
          <span className="prop-none">{t.history.none}</span>
        )}
      </PropRow>
      {roles.length > 0 && (
        <PropRow label={t.props.roles}>
          {roles.map((r) => (
            <RefLink key={r.id} graph={graph} target={{ kind: "role", id: r.id }} onOpen={onOpen} />
          ))}
        </PropRow>
      )}
      <PropRow label={t.rel.parent}>
        {node.parentId ? (
          <RefLink graph={graph} target={{ kind: "node", id: node.parentId }} onOpen={onOpen} />
        ) : (
          <span className="prop-none">{t.rel.topLevel}</span>
        )}
      </PropRow>
      {node.childIds.length > 0 && (
        <PropRow label={t.rel.children}>
          {graph.childrenOf(node.id).map((c) => (
            <RefLink key={c.id} graph={graph} target={{ kind: "node", id: c.id }} onOpen={onOpen} />
          ))}
        </PropRow>
      )}
      {outgoing.length > 0 && (
        <PropRow label={t.rel.linksTo}>
          {outgoing.map((r) => (
            <RefLink key={`${r.kind}:${r.id}`} graph={graph} target={r} onOpen={onOpen} />
          ))}
        </PropRow>
      )}
      {incoming.length > 0 && (
        <PropRow label={t.rel.citedBy}>
          {incoming.map((i, k) => (
            <RefLink
              key={k}
              graph={graph}
              target={i.from}
              onOpen={onOpen}
              note={incomingNote(i)}
              flag={i.changedSince && pendingCard(graph, i.from) ? t.rel.changedSince : undefined}
            />
          ))}
        </PropRow>
      )}
      {files.length > 0 && (
        <PropRow label={t.rel.materials}>
          {files.map((m, k) => (
            <span
              key={k}
              className="ref-link plain"
              data-tip={
                (m.field === "resource" ? t.rel.mainMaterial : t.rel.sourceN((m.index ?? 0) + 1)) +
                (m.kind === "text" ? t.rel.textDescription : "")
              }
            >
              <MaterialName material={m} />
            </span>
          ))}
        </PropRow>
      )}
      {children}
    </dl>
  );
}
