import { isDeepStrictEqual } from "node:util";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { isNodeId, isCardId } from "../base/id.js";
import { nodeNotePath, ROLES_DIR, cardRecordPath, roleDocumentPath } from "../base/paths.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { plainLine } from "../base/document-title.js";
import { documentLifecycle } from "../base/document-status.js";
import {
  materialLocator,
  resolvedMaterialOccurrences,
  isDirectoryMaterial,
  type MaterialSource,
} from "../base/material.js";
import { extractOutLinksDetailed } from "../base/links.js";
import { resolveTargetPath } from "../base/link-target.js";
import { loadNodeCatalog, readCatalogDocument } from "../graph/node-catalog.js";
import { ReaderError } from "../graph/context-reader.js";
import {
  listCardDocumentHeaders,
  parseCardDocument,
  verifyCardSourceVersions,
  type CardDocumentState,
} from "../graph/card-document.js";
import { systemMaterialPath } from "../graph/material-target.js";
import {
  listWorkspaceRelations,
  readRelationDocument,
  readRelationDocuments,
  resolveDocumentRelations,
  type RelationDocument,
  type WorkspaceRelation,
  type DocumentRef,
} from "../graph/workspace-relations.js";
import { listHistoryChanges } from "./history-query.js";
import type {
  NodeHistoryDetails,
  NodeCardsDetails,
  NodeRelationsDetails,
  NodeDetailMaterial,
  NodeCardSource,
  NodeDetailRef,
  NodeIncomingSummary,
} from "./node-details-types.js";

async function selectedNode(fs: FsAdapter, nodeId: string) {
  if (!isNodeId(nodeId)) throw new ReaderError("INVALID_INPUT", "Expected a canonical Node id");
  const catalog = await loadNodeCatalog(fs);
  const node = catalog.byId.get(nodeId);
  if (!node) throw new ReaderError("NOT_FOUND", `Node not found: ${nodeId}`);
  return { catalog, node };
}

/** Identity follows a Node across renames. Unidentified legacy changes match only its current path. */
export async function readNodeHistoryDetails(
  source: FsAdapter,
  nodeId: string,
): Promise<NodeHistoryDetails> {
  const fs = readOnlyFs(source);
  const { node } = await selectedNode(fs, nodeId);
  const filePath = nodeNotePath(node.path);
  const items: NodeHistoryDetails["items"] = [];
  for (const commit of [...(await listHistoryChanges(fs))].reverse()) {
    const change =
      commit.changes.find((change) => change.objectId === nodeId) ??
      commit.changes.find(
        (change) => !change.objectId && (change.after ?? change.before)?.path === filePath,
      );
    if (change)
      items.push({
        hash: commit.commit,
        date: commit.time,
        file: {
          path: (change.after ?? change.before)!.path,
          status: !change.before ? "A" : !change.after ? "D" : "M",
          ref: change.objectId ? { kind: "node", id: nodeId } : null,
          before: change.before,
          after: change.after,
        },
      });
  }
  return { nodeId, items };
}

function cardTitle(document: RelationDocument) {
  return typeof document.data.title === "string" && document.data.title
    ? document.data.title
    : plainLine(
        /^#\s+(.+)$/m.exec(document.body)?.[1] ?? document.body.trim().split(/\r?\n/)[0] ?? "",
      );
}

/** Headers select Cards; retained source bytes, rather than today's path, decide pinned identity. */
export async function readNodeCardsDetails(
  source: FsAdapter,
  nodeId: string,
): Promise<NodeCardsDetails> {
  const fs = readOnlyFs(source);
  const { node } = await selectedNode(fs, nodeId);
  const listed = await listCardDocumentHeaders(fs, { includeDeprecated: true });
  const result: NodeCardsDetails = { nodeId, items: [], diagnostics: [] };
  const candidates: Array<{
    cardId: string;
    index: number;
    owner: string;
    source: MaterialSource;
  }> = [];
  for (const item of listed.items) {
    const cardId = String(item.cardId);
    const error = item.diagnostic ?? listed.sourceErrors.get(cardId);
    if (error) {
      result.diagnostics.push({ cardId, error: String(error) });
      continue;
    }
    for (const [index, source] of (listed.sourceSets.get(cardId) ?? []).entries())
      candidates.push({ cardId, index, owner: cardRecordPath(cardId), source });
  }
  const pinned = candidates.filter((entry) => entry.source.version !== undefined);
  const verified = await verifyCardSourceVersions(fs, pinned);
  const retained = new Map(pinned.map((entry, index) => [entry, verified[index]!]));
  const matching = new Map<string, NodeCardSource[]>();
  for (const entry of candidates) {
    const { cardId, index, source, owner } = entry;
    try {
      const value = retained.get(entry);
      if (value instanceof Error) throw value;
      if (value) {
        const data = value.frontmatter ?? parseFrontmatter(value.raw).data;
        if (value.version.path.startsWith(ROLES_DIR + "/") || data.id !== nodeId) continue;
      } else {
        const locator = materialLocator(source.resource, owner, true);
        if (
          isDirectoryMaterial(locator) ||
          systemMaterialPath(locator, fs.workspaceRoot) !== nodeNotePath(node.path)
        )
          continue;
      }
      const list = matching.get(cardId) ?? [];
      list.push({
        kind: "node",
        id: nodeId,
        resource: source.resource,
        field: "sources",
        index,
        ...(typeof source.title === "string" ? { title: source.title } : {}),
        version: value?.version ?? null,
        changedSince: value?.changedSince ?? false,
      });
      matching.set(cardId, list);
    } catch (error) {
      result.diagnostics.push({
        cardId,
        index,
        resource: source.resource,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const roleTitles = new Map<string, string | null>();
  for (const item of listed.items) {
    const id = String(item.cardId),
      sources = matching.get(id);
    if (!sources) continue;
    let title = typeof item.title === "string" ? item.title : "";
    if (!title) {
      const document = parseCardDocument(id, await fs.readFile(cardRecordPath(id)));
      const fields = ["title", "state", "target", "receivedBy", "returnTo"];
      if (
        fields.some((field) => item[field] !== document.data[field]) ||
        item.status !== documentLifecycle(document.data).status ||
        !isDeepStrictEqual(listed.sourceSets.get(id), document.data.sources)
      )
        throw new ReaderError("SOURCE_CHANGED", "Card metadata changed during lookup; retry");
      title = cardTitle({ ref: { kind: "card", id }, ...document });
    }
    const target = typeof item.target === "string" ? item.target : null;
    const receivedBy = typeof item.receivedBy === "string" ? item.receivedBy : null;
    const lane = receivedBy ?? target;
    if (lane && !roleTitles.has(lane)) {
      const file = roleDocumentPath(lane);
      const role = (await fs.exists(file))
        ? await readRelationDocument(fs, file, "role")
        : undefined;
      roleTitles.set(lane, role ? String(role.data.title ?? lane) : null);
    }
    result.items.push({
      id,
      title,
      state: item.state as CardDocumentState,
      status: typeof item.status === "string" ? item.status : null,
      target,
      receivedBy,
      ...(typeof item.returnTo === "string" ? { returnTo: item.returnTo } : {}),
      publishedAt: String(item.publishedAt),
      sources,
      lane: { id: lane, title: lane ? (roleTitles.get(lane) ?? null) : null },
    });
    if (item.statusDiagnostic)
      result.diagnostics.push({ cardId: id, error: String(item.statusDiagnostic) });
  }
  return result;
}

function targetRef(target: WorkspaceRelation["target"]): DocumentRef | null {
  return target.kind === "node" || target.kind === "role" || target.kind === "card" ? target : null;
}
function material(relation: WorkspaceRelation): NodeDetailMaterial {
  return {
    ...relation.target,
    kind: relation.target.kind === "unresolved" ? "text" : relation.target.kind,
    resource: relation.raw,
    field: relation.via === "resource" || relation.via === "sources" ? relation.via : undefined,
    index: relation.index,
    title: relation.title,
  };
}

/** Incoming is explicitly requested because discovering unknown referrers needs whole-workspace text. */
export async function readNodeRelationsDetails(
  source: FsAdapter,
  nodeId: string,
  direction: "outgoing" | "incoming",
): Promise<NodeRelationsDetails> {
  const fs = readOnlyFs(source);
  const { catalog, node } = await selectedNode(fs, nodeId);
  const roles = await readRelationDocuments(fs, ROLES_DIR, "role");
  const docs = new Map(roles.map((role) => [role.ref.id, role]));
  const nodes = [...catalog.tree.byPath.values()].filter((node) => !node.invalid);
  const result: NodeRelationsDetails = {
    nodeId,
    links: [],
    materials: [],
    incoming: [],
    roles: [],
    refs: [],
  };
  let relations: WorkspaceRelation[];
  if (direction === "incoming") {
    relations = await listWorkspaceRelations(fs);
  } else {
    const document = await readCatalogDocument(fs, node);
    const parsed = parseFrontmatter(document.raw);
    const selected: RelationDocument = {
      ref: { kind: "node", id: nodeId },
      path: nodeNotePath(node.path),
      data: parsed.data,
      body: parsed.body,
      etag: document.etag,
    };
    const cardPaths = new Set<string>();
    const consider = (file: string) => {
      const match = /^cards\/(card-[^/]+?)(?:\.md)?$/.exec(file);
      if (match && isCardId(match[1]!)) cardPaths.add(cardRecordPath(match[1]!));
    };
    for (const occurrence of resolvedMaterialOccurrences(selected.data, selected.path))
      if (occurrence.locator?.kind === "path") consider(occurrence.locator.target);
    for (const link of extractOutLinksDetailed(selected.body, true))
      consider(resolveTargetPath(link.raw, selected.path));
    for (const file of cardPaths) {
      const card = (await fs.exists(file))
        ? await readRelationDocument(fs, file, "card")
        : undefined;
      if (card) docs.set(card.ref.id, card);
    }
    const identities = [
      ...nodes.map((node) => ({
        path: nodeNotePath(node.path),
        ref: { kind: "node" as const, id: node.id },
      })),
      ...docs.values(),
    ];
    relations = await resolveDocumentRelations(fs, [selected, ...roles], nodes, identities);
    const outgoing = relations.filter((relation) => relation.from.id === nodeId);
    result.links = outgoing
      .filter(
        (relation) =>
          (relation.via === "link" || relation.via === "mention") && relation.target.kind !== "uri",
      )
      .map((relation) => ({
        label: relation.label ?? relation.raw,
        href: relation.raw,
        ref: targetRef(relation.target),
      }));
    result.materials = outgoing
      .filter((relation) => relation.via === "resource" || relation.via === "sources")
      .map(material);
    const roleIds = new Set(
      relations.flatMap((relation) => {
        const ref = targetRef(relation.target);
        if (relation.from.id === nodeId && ref?.kind === "role") return [ref.id];
        if (
          relation.from.kind === "role" &&
          ref?.id === nodeId &&
          (relation.via === "link" || relation.via === "mention")
        )
          return [relation.from.id];
        return [];
      }),
    );
    result.roles = roles
      .filter((role) => roleIds.has(role.ref.id))
      .map((role) => ({
        id: role.ref.id,
        title: String(role.data.title ?? role.ref.id),
        status: String(role.data.status ?? "stable"),
      }));
  }
  const referencedCards = new Set(
    relations.flatMap((relation) => {
      const ref = targetRef(relation.target);
      if (direction === "incoming")
        return ref?.id === nodeId && relation.from.kind === "card" ? [relation.from.id] : [];
      return relation.from.id === nodeId && ref?.kind === "card" ? [ref.id] : [];
    }),
  );
  const publishedCards = new Set(
    referencedCards.size
      ? (
          await listCardDocumentHeaders(fs, {
            cardIds: [...referencedCards],
            includeDeprecated: true,
          })
        ).items
          .filter((item) => !item.diagnostic && item.publishedAt)
          .map((item) => String(item.cardId))
      : [],
  );
  async function refInfo(ref: DocumentRef): Promise<NodeDetailRef> {
    if (ref.kind === "node") {
      const node = catalog.byId.get(ref.id);
      return { ...ref, title: node?.name ?? ref.id, exists: !!node };
    }
    if (ref.kind === "card" && !docs.has(ref.id)) {
      const file = cardRecordPath(ref.id);
      const document = (await fs.exists(file))
        ? await readRelationDocument(fs, file, "card")
        : undefined;
      if (document) docs.set(ref.id, document);
    }
    const document = docs.get(ref.id);
    if (ref.kind === "card" && !publishedCards.has(ref.id))
      return { ...ref, title: ref.id, exists: false };
    return {
      ...ref,
      title: document
        ? ref.kind === "card"
          ? cardTitle(document)
          : String(document.data.title ?? ref.id)
        : ref.id,
      exists: !!document,
    };
  }
  const refs = new Map<string, NodeDetailRef>();
  if (direction === "incoming") {
    const seen = new Set<string>();
    for (const relation of relations) {
      if (targetRef(relation.target)?.id !== nodeId) continue;
      const via =
        relation.from.kind === "card" && relation.via === "sources" ? "card-source" : relation.via;
      const key = `${relation.from.kind}:${relation.from.id}:${via}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = await refInfo(relation.from);
      refs.set(info.id, info);
      const incoming: NodeIncomingSummary = {
        from: relation.from,
        via,
        title: info.title,
        ...(relation.version
          ? { version: relation.version, changedSince: relation.changedSince }
          : {}),
      };
      if (relation.from.kind === "card" && publishedCards.has(relation.from.id))
        incoming.cardState = docs.get(relation.from.id)?.data.state as
          CardDocumentState | undefined;
      result.incoming.push(incoming);
    }
  } else {
    for (const relation of relations.filter((relation) => relation.from.id === nodeId)) {
      const ref = targetRef(relation.target);
      if (ref && !refs.has(ref.id)) refs.set(ref.id, await refInfo(ref));
    }
    for (const role of result.roles)
      if (!refs.has(role.id)) refs.set(role.id, await refInfo({ kind: "role", id: role.id }));
  }
  result.refs = [...refs.values()];
  return result;
}
