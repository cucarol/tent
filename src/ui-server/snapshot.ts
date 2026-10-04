// Build the Web UI read model (src/ui/data/types.ts) from Core.
import { readOnlyFs, type FsAdapter } from "../core/adapter.js";
import { listHistoryChanges } from "../core/history-query.js";
import { listWorkspaceRelations, type WorkspaceRelation } from "../core/workspace-relations.js";
import { isNodeId, isRoleId, isCardId } from "../core/id.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { CARDS_DIR, ROLES_DIR, nodeNotePath } from "../core/paths.js";
import { loadTent } from "../core/tree.js";
import type { Node } from "../core/types.js";
import type {
  Snapshot,
  SnapshotCard,
  SnapshotCommit,
  SnapshotIncoming,
  SnapshotLink,
  SnapshotMaterial,
  SnapshotNode,
  SnapshotRef,
  SnapshotRole,
} from "../ui/data/types.js";

export type SnapshotSource = {
  fs: FsAdapter;
  workspace: { id: string; name: string };
  revision: string;
};

export async function buildSnapshot(source: SnapshotSource): Promise<Snapshot> {
  const fs = readOnlyFs(source.fs);
  const tent = await loadTent(fs);
  const byPath = new Map<string, SnapshotRef>();

  const nodes: SnapshotNode[] = [];
  const visit = (node: Node, depth: number) => {
    byPath.set(nodeNotePath(node.path), { kind: "node", id: node.id });
    nodes.push({
      id: node.id,
      name: node.name,
      path: node.path,
      notePath: nodeNotePath(node.path),
      depth,
      type: node.type ?? "",
      tags: node.tags,
      status: node.status ?? "stable",
      archived: node.archived,
      description: typeof node.fm.description === "string" ? node.fm.description : "",
      body: node.body,
      parentId: node.parent?.id ?? null,
      childIds: node.children.map((child) => child.id),
      links: [],
      materials: [],
      incoming: [],
      history: [],
    });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of tent.roots) visit(root, 0);

  const readDocs = async (dir: string) => {
    if (!(await fs.exists(dir))) return [];
    const docs = [];
    for (const entry of (await fs.listDir(dir)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const file = `${dir}/${entry.name}`;
      const { data, body } = parseFrontmatter(await fs.readFile(file));
      docs.push({ file, data, body });
    }
    return docs;
  };
  const roleDocs = await readDocs(ROLES_DIR);
  const cardDocs = await readDocs(CARDS_DIR);
  for (const d of roleDocs) byPath.set(d.file, { kind: "role", id: String(d.data.id) });
  for (const d of cardDocs) byPath.set(d.file, { kind: "card", id: String(d.data.id) });

  const commits: SnapshotCommit[] = (await listHistoryChanges(fs)).reverse().map((commit) => ({
    hash: commit.commit,
    parent: commit.parent ?? null,
    date: commit.time,
    operation: commit.operation,
    entry: commit.entry,
    objectIds: commit.objectIds,
    files: commit.changes.map((change) => ({
      path: (change.after ?? change.before)!.path,
      status: !change.before ? "A" : !change.after ? "D" : "M",
      ref: change.objectId ? identityRef(change.objectId) : null,
      before: change.before,
      after: change.after,
    })),
  }));
  const touching = (id: string, file: string) =>
    commits
      .filter((c) => c.files.some((f) => (f.ref ? f.ref.id === id : f.path === file)))
      .map((c) => c.hash);
  const relations = await listWorkspaceRelations(fs);
  const from = (id: string) => relations.filter((r) => r.from.id === id);
  const linksOf = (id: string): SnapshotLink[] =>
    from(id)
      .filter((r) => r.via === "link" && r.target.kind !== "uri")
      .map((r) => ({
        label: r.label ?? r.raw,
        href: r.raw,
        ref: targetRef(r.target),
      }));
  const material = (r: WorkspaceRelation): SnapshotMaterial => ({
    ...r.target,
    kind: r.target.kind === "unresolved" ? "text" : r.target.kind,
    resource: r.raw,
    field: r.via === "link" ? undefined : r.via,
    index: r.index,
    title: r.title,
  });

  const incoming = new Map<string, SnapshotIncoming[]>();
  // A document that links here twice is still one reference.
  const addIncoming = (id: string, item: SnapshotIncoming) => {
    const list = incoming.get(id) ?? [];
    const same = (i: SnapshotIncoming) =>
      i.from.kind === item.from.kind && i.from.id === item.from.id && i.via === item.via;
    if (!list.some(same)) incoming.set(id, [...list, item]);
  };

  for (const r of relations) {
    const ref = targetRef(r.target);
    if (ref)
      addIncoming(ref.id, {
        from: r.from,
        via: r.from.kind === "card" && r.via === "sources" ? "card-source" : r.via,
        ...(r.version ? { version: r.version, changedSince: r.changedSince } : {}),
      });
  }
  for (const n of nodes) {
    n.links = linksOf(n.id);
    n.materials = from(n.id)
      .filter((r) => r.via !== "link")
      .map(material);
    n.history = touching(n.id, n.notePath);
  }

  const roles: SnapshotRole[] = roleDocs.map((d) => {
    const role: SnapshotRole = {
      id: String(d.data.id),
      title: typeof d.data.title === "string" ? d.data.title : String(d.data.id),
      status: typeof d.data.status === "string" ? d.data.status : "stable",
      path: d.file,
      body: d.body,
      links: linksOf(String(d.data.id)),
      incoming: [],
      history: touching(String(d.data.id), d.file),
    };
    return role;
  });

  const cards: SnapshotCard[] = cardDocs.map((d) => {
    const id = String(d.data.id);
    const history = touching(id, d.file);
    const sources = from(id)
      .filter((r) => r.via === "sources")
      .map((r) => ({
        ...material(r),
        version: r.version ?? null,
        changedSince: r.changedSince ?? false,
      }));
    const title =
      typeof d.data.title === "string" && d.data.title
        ? d.data.title
        : plainLine(/^#\s+(.+)$/m.exec(d.body)?.[1] ?? d.body.trim().split(/\r?\n/)[0] ?? "");
    return {
      id,
      title,
      state: String(d.data.state) as SnapshotCard["state"],
      target: typeof d.data.target === "string" ? d.data.target : null,
      receivedBy: typeof d.data.receivedBy === "string" ? d.data.receivedBy : null,
      status: typeof d.data.status === "string" ? d.data.status : "stable",
      body: d.body,
      sources,
      path: d.file,
      history,
      publishedAt: commits.find((c) => c.hash === history.at(-1))?.date ?? null,
      updatedAt: commits.find((c) => c.hash === history[0])?.date ?? null,
    };
  });
  for (const n of nodes) n.incoming = incoming.get(n.id) ?? [];
  for (const r of roles) r.incoming = incoming.get(r.id) ?? [];

  return {
    workspace: {
      ...source.workspace,
      revision: source.revision,
      generatedAt: new Date().toISOString(),
    },
    nodes,
    roles,
    cards,
    commits,
    paths: Object.fromEntries(byPath),
  };
}

/** A Markdown line as the plain text a title shows: no heading, list or quote marker, no inline marks. */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(`+)(.+?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2")
    .trim();
}

function identityRef(id: string): SnapshotRef | null {
  if (isNodeId(id)) return { kind: "node", id };
  if (isRoleId(id)) return { kind: "role", id };
  if (isCardId(id)) return { kind: "card", id };
  return null;
}

function targetRef(target: WorkspaceRelation["target"]): SnapshotRef | null {
  return target.kind === "node" || target.kind === "role" || target.kind === "card" ? target : null;
}
