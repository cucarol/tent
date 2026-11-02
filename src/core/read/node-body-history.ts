import { parseFrontmatter } from "../base/frontmatter.js";
import { isNodeId } from "../base/id.js";
import { rewriteMarkdownDestinations } from "../base/links.js";
import {
  isDirectoryMaterial,
  isCardResponseSource,
  materialOccurrences,
  materialIdentity,
  materialLocator,
} from "../base/material.js";
import { isNodeNotePath, nodeNotePath } from "../base/paths.js";
import type { FsAdapter } from "../store/adapter.js";
import { hasDocumentHistory, type DocumentVersion } from "../store/history-port.js";

type NodePath = { nodeId: string; path: string };
export type RetainedBodyNode = NodePath & {
  data: Record<string, unknown>;
  body: string;
  content: string;
  declaredContent: string;
};
export type RetainedBodyChange = {
  nodeId: string;
  /** null means absent; undefined means retained bytes could not be read. */
  before: RetainedBodyNode | null | undefined;
  after: RetainedBodyNode | null | undefined;
};
export type NodeBodyHistory = {
  events: { order: number; time: string; changes: RetainedBodyChange[] }[];
  latest: Map<string, RetainedBodyNode | undefined>;
  changed: Map<string, { content: string | undefined; order: number | null; at: string | null }>;
};

/** Compare prose while keeping destination rewrites caused by Node moves invisible. */
export function nodeBodyContent(
  body: string,
  documentPath: string,
  nodes: ReadonlyMap<string, NodePath>,
): string {
  const byPath = new Map([...nodes.values()].map((node) => [nodeNotePath(node.path), node.nodeId]));
  return rewriteMarkdownDestinations(body.replace(/\r\n?/g, "\n"), (resource) => {
    try {
      const locator = materialLocator(resource, documentPath, false);
      if (locator.kind === "path" && !isDirectoryMaterial(locator)) {
        const id = byPath.get(locator.target);
        if (id) return `node:${id}${locator.suffix}`;
      }
      return materialIdentity(locator) ?? resource;
    } catch {
      return resource;
    }
  });
}

/** Historical Node declarations, not the contents or versions of their materials. */
export function nodeDeclaredContent(
  data: Record<string, unknown>,
  body: string,
  documentPath: string,
  nodes: ReadonlyMap<string, NodePath>,
  workspaceRoot?: string,
): string {
  const byPath = new Map([...nodes.values()].map((node) => [nodeNotePath(node.path), node.nodeId]));
  const addresses = materialOccurrences(data)
    .filter(
      ({ resource, field }) =>
        field !== "sources" || !isCardResponseSource(resource, documentPath, workspaceRoot),
    )
    .map(({ resource, track }) => {
      let address = resource;
      try {
        const locator = materialLocator(resource, documentPath, false);
        const id =
          locator.kind === "path" && !isDirectoryMaterial(locator)
            ? byPath.get(locator.target)
            : undefined;
        address =
          id && locator.kind === "path"
            ? `node:${id}${locator.suffix}`
            : (materialIdentity(locator) ?? resource);
      } catch {
        /* Invalid addresses keep their original declaration bytes. */
      }
      return track ? [address, track] : address;
    });
  return JSON.stringify({ addresses, body: nodeBodyContent(body, documentPath, nodes) });
}

/** Retained event order is authoritative; timestamps are display values only. */
export async function readNodeBodyHistory(fs: FsAdapter): Promise<NodeBodyHistory | undefined> {
  if (!fs.history || !(await hasDocumentHistory(fs))) return;
  const events = await fs.history.changesInRange();
  const key = (version: DocumentVersion) => `${version.commit}:${version.path}`;
  const versions = [
    ...new Map(
      events.flatMap((event) =>
        event.changes.flatMap((change) =>
          change.objectId && isNodeId(change.objectId)
            ? [change.before, change.after].flatMap((version) =>
                version ? [[key(version), version] as const] : [],
              )
            : [],
        ),
      ),
    ).values(),
  ];
  const reads = await fs.history.readVersions(versions);
  const bytes = new Map(
    versions.map((version, i) => [
      key(version),
      reads[i] instanceof Error ? undefined : reads[i]?.raw,
    ]),
  );
  // Replay documents by path: an imported event may retain several documents
  // with the same id, including ones unchanged by the following repair event.
  const documents = new Map<string, { nodeId: string; version: DocumentVersion }>();
  const unique = () => {
    const byId = new Map<string, DocumentVersion | undefined>();
    for (const { nodeId, version } of documents.values())
      byId.set(nodeId, byId.has(nodeId) ? undefined : version);
    return byId;
  };
  const nodePaths = (versions: ReturnType<typeof unique>) =>
    new Map(
      [...versions].flatMap(([nodeId, version]) =>
        version
          ? [
              [
                nodeId,
                {
                  nodeId,
                  path: version.path.slice(0, version.path.lastIndexOf("/")),
                },
              ] as const,
            ]
          : [],
      ),
    );
  const result: NodeBodyHistory = { events: [], latest: new Map(), changed: new Map() };
  const read = (
    id: string,
    version: DocumentVersion | undefined,
    at: ReadonlyMap<string, NodePath>,
  ): RetainedBodyNode | null | undefined => {
    if (!version) return null;
    const raw = bytes.get(key(version));
    if (raw === undefined || !isNodeNotePath(version.path)) return;
    try {
      const { data, body } = parseFrontmatter(raw);
      if (data.id !== id) return;
      return {
        nodeId: id,
        path: version.path.slice(0, version.path.lastIndexOf("/")),
        data,
        body,
        content: nodeBodyContent(body, version.path, at),
        declaredContent: nodeDeclaredContent(data, body, version.path, at, fs.workspaceRoot),
      };
    } catch {
      return;
    }
  };
  for (const [order, event] of events.entries()) {
    const selected = event.changes.filter((change) => change.objectId && isNodeId(change.objectId));
    const ids = new Set(selected.map((change) => change.objectId!));
    for (const change of selected)
      if (change.before)
        documents.set(change.before.path, {
          nodeId: change.objectId!,
          version: change.before,
        });
    const prior = unique();
    const paths = nodePaths(prior);
    const before = new Map(
      [...ids].map((id) => [
        id,
        prior.has(id) && !prior.get(id) ? undefined : read(id, prior.get(id), paths),
      ]),
    );
    for (const change of selected) if (change.before) documents.delete(change.before.path);
    for (const change of selected)
      if (change.after)
        documents.set(change.after.path, {
          nodeId: change.objectId!,
          version: change.after,
        });
    const following = unique();
    const nextPaths = nodePaths(following);
    const changes: RetainedBodyChange[] = [];
    for (const id of ids) {
      const previous = before.get(id);
      const next =
        following.has(id) && !following.get(id)
          ? undefined
          : read(id, following.get(id), nextPaths);
      changes.push({ nodeId: id, before: previous, after: next });
      const knownChange =
        !!next && (previous === null || (!!previous && previous.content !== next.content));
      const unchanged = !!next && !!previous && previous.content === next.content;
      result.changed.set(id, {
        content: next?.content,
        order: knownChange ? order : unchanged ? (result.changed.get(id)?.order ?? null) : null,
        at: knownChange ? event.time : unchanged ? (result.changed.get(id)?.at ?? null) : null,
      });
      if (next === null) result.latest.delete(id);
      else result.latest.set(id, next);
    }
    result.events.push({ order, time: event.time, changes });
  }
  return result;
}
