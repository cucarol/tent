/**
 * Pieces the pages (Reader.tsx) put together, as a page or as the panel beside the map: links to other
 * objects, a Node's properties, version history and file diffs.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { Graph } from "../data/store.js";
import { api, ApiError, describe, type NodeDocument } from "../data/api.js";
import type { NodeSection } from "../data/node-details.js";
import { materialFacts } from "../data/materials.js";
import { filesOf } from "../data/files.js";
import type {
  MaterialState,
  SnapshotFile,
  SnapshotIncoming,
  SnapshotMaterial,
  SnapshotNode,
  SnapshotRef,
  NodeHistoryDetails,
  NodeHistoryEntry,
  NodeRelationsDetails,
} from "../data/types.js";
import { CardGlyph, Icon, TypeGlyph } from "../components/Glyph.js";
import { Pet } from "../components/Pet.js";
import { ago, inlineDiff, shortHash, trimSegments, when, type Segment } from "../util.js";
import { t } from "../i18n.js";

const glyphOf = (graph: Graph, target: SnapshotRef, size = 15) =>
  target.kind === "node" ? (
    graph.nodes.get(target.id) ? (
      <TypeGlyph type={graph.nodes.get(target.id)!.type} size={size} />
    ) : (
      <TypeGlyph type="prompt" size={size} />
    )
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
  name,
  exists,
}: {
  graph: Graph;
  target: SnapshotRef;
  onOpen: (ref: SnapshotRef) => void;
  note?: string;
  flag?: string;
  name?: string;
  exists?: boolean;
}) {
  const glyph = glyphOf(graph, target);
  if (!(exists ?? graph.exists(target)))
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
      title={target.kind === "card" ? (name ?? graph.name(target)) : undefined}
    >
      {glyph}
      <span>{name ?? graph.name(target)}</span>
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
export const RECENT = 6;

/** A document's versions as a timeline, newest first; each opens to show what it changed. */
export function History({
  graph,
  id,
  path,
  hashes,
  items,
}: {
  graph?: Graph;
  id: string;
  path: string;
  hashes?: string[];
  items?: NodeHistoryEntry[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [, redraw] = useState(0);
  useEffect(() => {
    setOpen(null);
    setAll(false);
  }, [path]);
  const entries =
    items ??
    (hashes ?? []).flatMap((hash) => {
      const commit = graph?.commits.get(hash);
      const file =
        commit?.files.find((x) => x.ref?.id === id) ??
        commit?.files.find((x) => x.path === path && !x.ref);
      return commit && file ? [{ hash, date: commit.date, file }] : [];
    });
  if (!entries.length) return <p className="empty">{t.history.none}</p>;
  // A renamed or moved document keeps its id; its older versions sit at the old path.
  const shown = all ? entries : entries.slice(0, RECENT);
  return (
    <>
      <ol className="versions">
        {shown.map(({ hash: h, date, file: f }) => {
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
                  <span className="version-when">{when(date)}</span>
                </span>
                {patch !== undefined && <Stat {...countLines(patch)} />}
                <span className="version-hash">{shortHash(h)}</span>
              </button>
              {open === h && <FileDiff file={f} onLoad={() => redraw((n) => n + 1)} />}
            </li>
          );
        })}
      </ol>
      {entries.length > RECENT && (
        <button type="button" className="versions-more" onClick={() => setAll((a) => !a)}>
          {all ? t.history.showFewer : t.history.showAll(entries.length)}
          <Icon name={all ? "chevron" : "down"} size={13} />
        </button>
      )}
    </>
  );
}

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
 * Whether someone checked this Node against its materials, after an unreadable header if it has one.
 * Agents confirm Nodes; the page only says what Tent sees.
 */
export function ReviewRow({ doc, node }: { doc: NodeDocument | null; node?: SnapshotNode }) {
  const last = latestVerification(doc?.frontmatter.verified);
  const tier = doc?.trustTier ?? "unverified";
  // Nothing checked and nothing wrong: no row saying so.
  if (!node?.invalid && !last && tier === "unverified") return null;
  return (
    <PropRow label={t.review.label}>
      <div className="review">
        {node?.invalid && (
          <span className="review-why is-invalid">{t.map.invalidWhy(node.invalidReason)}</span>
        )}
        <span className={`review-tier is-${tier}`}>
          {t.review.tier[tier]}
          {last && <span className="review-by">{t.review.by(last.by, ago(last.at))}</span>}
        </span>
      </div>
    </PropRow>
  );
}

/** A property; a list takes a line of its own (wide) and shows its first few. */
export function PropRow({
  label,
  wide,
  hidden,
  children,
}: {
  label: string;
  wide?: boolean;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`prop${wide ? " is-wide" : ""}`} hidden={hidden}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The first few of a list, and +N for the rest. */
function Capped({ items, cap = 8 }: { items: ReactNode[]; cap?: number }) {
  const [all, setAll] = useState(false);
  return (
    <>
      {all ? items : items.slice(0, cap)}
      {items.length > cap && (
        <button type="button" className="prop-more" onClick={() => setAll(!all)}>
          {all ? t.page.showLess : `+${items.length - cap}`}
        </button>
      )}
    </>
  );
}

/**
 * Unread and failed sections stay distinct from a successful empty answer. Given `rows`, an unread
 * section holds the place its rows will take instead of saying it is reading, so nothing moves when they come.
 */
export function ReadState({
  section,
  rows,
  kind = "prop",
}: {
  section: NodeSection<unknown>;
  rows?: number;
  kind?: "prop" | "version" | "card";
}) {
  if (section.error)
    return (
      <p className="empty" role="alert">
        {describe(section.error)}{" "}
        <button type="button" className="btn plain" onClick={section.retry}>
          {t.app.retry}
        </button>
      </p>
    );
  if (section.data !== null) return null;
  if (rows === undefined) return <p className="empty">{t.page.reading}</p>;
  return (
    <div className={`skel skel-${kind}`} role="status" aria-label={t.page.reading}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
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
  details,
  children,
}: {
  graph: Graph;
  node: SnapshotNode;
  onOpen: (ref: SnapshotRef) => void;
  onHistory?: () => void;
  details: {
    history: NodeSection<NodeHistoryDetails>;
    outgoing: NodeSection<NodeRelationsDetails>;
    incoming: NodeSection<NodeRelationsDetails>;
    incomingOpen: boolean;
    onIncoming: () => void;
    /** Its own materials as Tent compares them now. */
    materials?: NodeSection<{ materials: MaterialState[] }>;
  };
  /** Rows the page adds after these. */
  children?: ReactNode;
}) {
  const family = new Set([node.id, node.parentId, ...node.childIds]);
  const relations = details.outgoing.data;
  const refs = new Map(
    [...(relations?.refs ?? []), ...(details.incoming.data?.refs ?? [])].map((ref) => [
      `${ref.kind}:${ref.id}`,
      ref,
    ]),
  );
  const namedLink = (ref: SnapshotRef) => refs.get(`${ref.kind}:${ref.id}`);
  const outgoing = [
    ...new Map(
      [
        ...(relations?.links ?? []).flatMap((l) => (l.ref ? [l.ref] : [])),
        ...(relations?.materials ?? []).flatMap((m) =>
          (m.kind === "node" || m.kind === "role") && m.id ? [{ kind: m.kind, id: m.id }] : [],
        ),
      ]
        .filter((r) => !(r.kind === "node" && family.has(r.id)))
        .map((r) => [`${r.kind}:${r.id}`, r as SnapshotRef]),
    ).values(),
  ];
  // Links between parent and child are already the tree; the rest is what really cites it.
  const incoming = (details.incoming.data?.incoming ?? []).filter(
    (i) => !(i.from.kind === "node" && family.has(i.from.id) && i.via === "link"),
  );
  // Files the page already shows as tabs, or as its own file, are listed there once, with what changed.
  const tabbed = new Set(filesOf(node).map((f) => f.file.path));
  const unshown = (m: SnapshotMaterial) =>
    m.kind !== "node" && m.kind !== "role" && !(m.workspacePath && tabbed.has(m.workspacePath));
  const files = (relations?.materials ?? []).filter(unshown);
  const facts = materialFacts(details.materials?.data?.materials ?? []);
  const roles = relations?.roles ?? [];
  const history = details.history.data?.items ?? [];
  const latest = history[0];
  return (
    <dl className="props">
      <PropRow label={t.props.versions}>
        {latest ? (
          <button type="button" className="ref-link plain" onClick={onHistory}>
            <Icon name="clock" size={15} />
            <span>{t.props.versionsValue(history.length, ago(latest.date))}</span>
          </button>
        ) : details.history.data ? (
          <span className="prop-none">{t.history.none}</span>
        ) : (
          <ReadState section={details.history} rows={1} />
        )}
      </PropRow>
      {roles.length > 0 && (
        <PropRow label={t.props.roles}>
          {roles.map((r) => (
            <RefLink
              key={r.id}
              graph={graph}
              target={{ kind: "role", id: r.id }}
              onOpen={onOpen}
              name={r.title}
              exists
            />
          ))}
        </PropRow>
      )}
      {/* Parents are the page's trail and children the map's branch; the rows say only what those cannot. */}
      <PropRow label={t.rel.linksTo} wide>
        {!relations && <ReadState section={details.outgoing} rows={1} />}
        {/* Said rather than dropped, so the rows under it stay where they are when the read comes. */}
        {!!relations && !outgoing.length && <span className="prop-none">{t.rel.noLinks}</span>}
        <Capped
          items={outgoing.map((r) => (
            <RefLink
              key={`${r.kind}:${r.id}`}
              graph={graph}
              target={r}
              onOpen={onOpen}
              name={namedLink(r)?.title}
              exists={namedLink(r)?.exists}
            />
          ))}
        />
      </PropRow>
      <PropRow label={t.rel.citedBy} wide>
        {!details.incomingOpen ? (
          <button type="button" className="ref-link plain" onClick={details.onIncoming}>
            {t.rel.loadIncoming}
          </button>
        ) : !details.incoming.data ? (
          <ReadState section={details.incoming} />
        ) : !incoming.length ? (
          <span className="prop-none">{t.rel.noIncoming}</span>
        ) : null}
        <Capped
          items={incoming.map((i, k) => (
            <RefLink
              key={k}
              graph={graph}
              target={i.from}
              onOpen={onOpen}
              note={incomingNote(i)}
              name={i.title}
              exists={namedLink(i.from)?.exists ?? true}
              flag={i.changedSince && i.cardState === "pending" ? t.rel.changedSince : undefined}
            />
          ))}
        />
      </PropRow>
      <PropRow
        label={t.rel.materials}
        wide
        hidden={relations ? !files.length : !node.materials.some(unshown)}
      >
        {!relations && <ReadState section={details.outgoing} rows={1} />}
        <Capped
          items={files.map((m, k) => (
            <span
              key={k}
              className="ref-link plain"
              data-tip={
                (m.field === "resource" ? t.rel.mainMaterial : t.rel.sourceN((m.index ?? 0) + 1)) +
                (m.kind === "text" ? t.rel.textDescription : "") +
                (m.error ? ` · ${m.error}` : "")
              }
            >
              <MaterialName material={m} />
              {facts.has(m.resource) && (
                <span className="material-fact">{t.rel.materialFact[facts.get(m.resource)!]}</span>
              )}
            </span>
          ))}
        />
      </PropRow>
      {children}
    </dl>
  );
}
