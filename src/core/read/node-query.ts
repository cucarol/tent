import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import {
  ContextReader,
  ReaderError,
  readerListSchema,
  readerReadSchema,
  readerRelationsSchema,
} from "../graph/context-reader.js";
import { liveContextReader, selectedContextReader } from "./context-reader-factory.js";
import * as z from "zod/v4";
import {
  loadNodeCatalog,
  catalogSummary,
  catalogRelations,
  catalogMatches,
  readCatalogDocument,
} from "../graph/node-catalog.js";
import {
  captureReadDocument,
  captureReadDocuments,
  isHistoryDocument,
} from "../store/document-history.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { contentEtag } from "../base/etag.js";
import { documentLifecycle } from "../base/document-status.js";
import { nodeNotePath } from "../base/paths.js";
import { loadTent, canonicalIdentityError } from "../store/tree.js";
import { materialFields } from "../base/material.js";
import { isNodeId } from "../base/id.js";
import { NODE_TYPES } from "../base/node-type.js";
import { NODE_TAG_PRESETS, countNodeTags, normalizeTagName } from "../base/tags.js";
import { uncapturedChecker } from "../graph/retained-read.js";
import { readOutputChanges } from "../graph/node-sync.js";
import { isOutputNode } from "../graph/node-sync-record.js";

/** Short-lived callers share these queries; no mount, registry, watcher or read-time repair. */
export async function readNode(
  fs: FsAdapter,
  workspaceId: string,
  input: unknown,
  options: { uncaptured?: boolean } = {},
) {
  const request = readerReadSchema.parse(input);
  if (request.version) {
    if (!isHistoryDocument(request.version.path) || !fs.history)
      throw new Error("Not a Tent history document");
    const raw = await fs.history.read(request.version);
    const data = parseFrontmatter(raw).data;
    const invalid = canonicalIdentityError(data);
    if (invalid) throw new Error(invalid);
    const nodeId = String(data.id);
    const path = request.version.path.slice(0, request.version.path.lastIndexOf("/"));
    if (nodeId !== request.nodeId) throw new Error("Historical version belongs to another Node");
    const reader = new ContextReader(
      { kind: "git", workspaceId, version: request.version },
      [
        {
          nodeId,
          name: path.split("/").at(-1)!,
          path,
          raw,
          etag: contentEtag(raw),
          archived: documentLifecycle(parseFrontmatter(raw).data).status === "deprecated",
          invalid: false,
          parentNodeId: null,
          childNodeIds: [],
        },
      ],
      [nodeId],
    );
    return { workspaceId, node: reader.read(request) };
  }
  if (request.view === "summary") {
    const catalog = await loadNodeCatalog(fs);
    const node = catalogSummary(catalog, { kind: "live", workspaceId }, request.nodeId);
    const document = options.uncaptured
      ? await readCatalogDocument(fs, catalog.byId.get(request.nodeId)!)
      : undefined;
    return {
      workspaceId,
      node: {
        ...node,
        ...(document && (await uncapturedChecker(fs))(nodeNotePath(document.path), document.raw)
          ? { uncaptured: true as const }
          : {}),
      },
    };
  }
  const reader = await selectedContextReader(fs, { kind: "live", workspaceId }, [request.nodeId]);
  const node = reader.read(request); // Validate the selected range before retaining bytes.
  const bytes = request.capture ? reader.documentBytes(request.nodeId) : undefined;
  const version = bytes ? await captureReadDocument(fs, bytes.path, bytes.raw) : undefined;
  const delivered = version ? reader.read(request, version) : node;
  const document =
    options.uncaptured && !request.capture ? reader.documentBytes(request.nodeId) : undefined;
  const changedSince =
    "partial" in delivered && !delivered.partial && isOutputNode(delivered)
      ? await readOutputChanges(fs, request.nodeId)
      : undefined;
  return {
    workspaceId,
    node: {
      ...delivered,
      ...(changedSince ? { changedSince } : {}),
      ...(document && (await uncapturedChecker(fs))(document.path, document.raw)
        ? { uncaptured: true as const }
        : {}),
    },
  };
}

export async function readNodeForEdit(
  fs: FsAdapter,
  nodeId: string,
  options: { capture?: boolean; uncaptured?: boolean; changes?: boolean } = {},
) {
  if (!isNodeId(nodeId)) throw new ReaderError("INVALID_INPUT", "Expected a canonical Node id");
  const node = (await loadNodeCatalog(fs)).byId.get(nodeId);
  if (!node) throw new ReaderError("NOT_FOUND", `Node not found: ${nodeId}`);
  const document = await readCatalogDocument(fs, node);
  const { data, body } = parseFrontmatter(document.raw);
  const version = options.capture
    ? await captureReadDocument(fs, nodeNotePath(node.path), document.raw)
    : undefined;
  const changedSince =
    options.changes && isOutputNode(data) ? await readOutputChanges(fs, nodeId) : undefined;
  return {
    nodeId,
    path: node.path,
    name: node.name,
    type: node.type,
    ...documentLifecycle(data),
    archived: node.archived,
    body,
    raw: document.raw,
    etag: document.etag,
    frontmatter: data,
    ...(changedSince ? { changedSince } : {}),
    ...(options.uncaptured &&
    !options.capture &&
    (await uncapturedChecker(fs))(nodeNotePath(node.path), document.raw)
      ? { uncaptured: true as const }
      : {}),
    ...(version ? { version } : {}),
  };
}

/** Without type or tag filters a list shows direct children; filters search the whole subtree. */
export const nodeListSchema = readerListSchema.extend({
  type: z.enum(NODE_TYPES).optional(),
  tags: z
    .array(z.string())
    .transform((tags) => [...new Set(tags.map(normalizeTagName))])
    .optional(),
});

export async function listNodes(
  fs: FsAdapter,
  workspaceId: string,
  input: unknown,
  options: { uncaptured?: boolean } = {},
) {
  const { type, tags, ...request } = nodeListSchema.parse(input);
  const catalog = await loadNodeCatalog(fs);
  const source = { kind: "live" as const, workspaceId };
  const result =
    type === undefined && !tags?.length
      ? catalogRelations(catalog, source, {
          nodeId: request.parentNodeId ?? null,
          direction: "children",
          ...request,
        })
      : catalogMatches(catalog, source, { ...request, type, tags });
  if (!options.uncaptured) return { workspaceId, ...result };
  const changed = await uncapturedChecker(fs);
  const items = [];
  for (const item of result.items) {
    const document = await readCatalogDocument(fs, catalog.byId.get(item.nodeId)!);
    items.push({
      ...item,
      ...(changed(nodeNotePath(document.path), document.raw) ? { uncaptured: true as const } : {}),
    });
  }
  return { workspaceId, ...result, items };
}

/** Tags in use with their counts, plus the suggested presets; no registry is consulted. */
export async function listNodeTags(
  fs: FsAdapter,
  workspaceId: string,
  input: { includeArchived?: boolean } = {},
) {
  const catalog = await loadNodeCatalog(fs);
  const nodes = [...catalog.tree.byPath.values()].filter((node) => !node.invalid);
  return {
    workspaceId,
    tags: countNodeTags(nodes, input),
    presets: [...NODE_TAG_PRESETS],
  };
}

export {
  searchNodeResources as searchNodes,
  nodeResourceSearchSchema,
} from "./node-resource-search.js";

export async function relatedNodes(fs: FsAdapter, workspaceId: string, input: unknown) {
  const request = readerRelationsSchema.parse(input);
  return {
    workspaceId,
    ...(request.direction === "parent" || request.direction === "children"
      ? catalogRelations(await loadNodeCatalog(fs), { kind: "live", workspaceId }, request)
      : (await liveContextReader(fs, { kind: "live", workspaceId }, { relations: true })).relations(
          request,
        )),
  };
}

/** Explicit whole-tree export; ordinary list/get never calls this unbounded operation. */
export async function readFullNodeTree(
  fs: FsAdapter,
  options: { capture?: boolean; uncaptured?: boolean } = {},
) {
  const observed = new Map<string, string>();
  const readonly = readOnlyFs(fs);
  const source = new Proxy(readonly, {
    get(target, key) {
      if (key === "readFile")
        return async (path: string) => {
          const raw = await target.readFile(path);
          if (isHistoryDocument(path)) observed.set(path, raw);
          return raw;
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const tree = await loadTent(source);
  const documents = [...tree.byPath.values()]
    .filter((node) => !node.invalid)
    .map((node) => ({
      path: nodeNotePath(node.path),
      raw: observed.get(nodeNotePath(node.path))!,
    }));
  // The loader already read exact raw bytes. Capture those bytes together, without reading the tree again.
  const versions = options.capture ? await captureReadDocuments(fs, documents) : [];
  const byPath = new Map(versions.map((version) => [version.path, version]));
  const changed = options.uncaptured && !options.capture ? await uncapturedChecker(fs) : undefined;
  const project = (node: (typeof tree.roots)[number]): Record<string, unknown> => {
    const data = node.fm;
    const raw = observed.get(nodeNotePath(node.path));
    const version = byPath.get(nodeNotePath(node.path));
    return {
      nodeId: node.id,
      name: node.name,
      path: node.path,
      type: node.type,
      tags: node.tags,
      ...documentLifecycle(data),
      archived: node.archived,
      invalid: node.invalid,
      text: node.body,
      etag: node.etag,
      ...materialFields(data),
      ...(raw !== undefined && changed?.(nodeNotePath(node.path), raw)
        ? { uncaptured: true as const }
        : {}),
      ...(version ? { version } : {}),
      children: node.children.map(project),
    };
  };
  return tree.roots.map(project);
}
