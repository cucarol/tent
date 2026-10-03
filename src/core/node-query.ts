import { readOnlyFs, type FsAdapter } from "./adapter.js";
import {
  ContextReader,
  ReaderError,
  readerListSchema,
  readerReadSchema,
  readerRelationsSchema,
  readerSearchSchema,
} from "./context-reader.js";
import { liveContextReader, selectedContextReader } from "./context-reader-factory.js";
import {
  loadNodeCatalog,
  catalogSummary,
  catalogRelations,
  readCatalogDocument,
} from "./node-catalog.js";
import {
  captureReadDocument,
  captureReadDocuments,
  isHistoryDocument,
} from "./document-history.js";
import { parseFrontmatter } from "./frontmatter.js";
import { contentEtag } from "./etag.js";
import { documentLifecycle } from "./document-status.js";
import { nodeNotePath } from "./paths.js";
import { loadTent, canonicalIdentityError } from "./tree.js";
import { materialFields } from "./material.js";
import { isNodeId } from "./id.js";

/** Short-lived callers share these queries; no mount, registry, watcher or read-time repair. */
export async function readNode(fs: FsAdapter, workspaceId: string, input: unknown) {
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
  if (request.view === "summary")
    return {
      workspaceId,
      node: catalogSummary(
        await loadNodeCatalog(fs),
        { kind: "live", workspaceId },
        request.nodeId,
      ),
    };
  const reader = await selectedContextReader(fs, { kind: "live", workspaceId }, [request.nodeId]);
  const node = reader.read(request); // Validate the selected range before retaining bytes.
  const bytes = request.capture ? reader.documentBytes(request.nodeId) : undefined;
  const version = bytes ? await captureReadDocument(fs, bytes.path, bytes.raw) : undefined;
  return { workspaceId, node: version ? reader.read(request, version) : node };
}

export async function readNodeForEdit(
  fs: FsAdapter,
  nodeId: string,
  options: { capture?: boolean } = {},
) {
  if (!isNodeId(nodeId)) throw new ReaderError("INVALID_INPUT", "Expected a canonical Node id");
  const node = (await loadNodeCatalog(fs)).byId.get(nodeId);
  if (!node) throw new ReaderError("NOT_FOUND", `Node not found: ${nodeId}`);
  const document = await readCatalogDocument(fs, node);
  const { data, body } = parseFrontmatter(document.raw);
  const version = options.capture
    ? await captureReadDocument(fs, nodeNotePath(node.path), document.raw)
    : undefined;
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
    ...(version ? { version } : {}),
  };
}

export async function listNodes(fs: FsAdapter, workspaceId: string, input: unknown) {
  const request = readerListSchema.parse(input);
  return {
    workspaceId,
    ...catalogRelations(
      await loadNodeCatalog(fs),
      { kind: "live", workspaceId },
      { nodeId: request.parentNodeId ?? null, direction: "children", ...request },
    ),
  };
}

export async function searchNodes(fs: FsAdapter, workspaceId: string, input: unknown) {
  const request = readerSearchSchema.parse(input);
  return {
    workspaceId,
    ...(await liveContextReader(fs, { kind: "live", workspaceId })).search(request),
  };
}

export async function relatedNodes(fs: FsAdapter, workspaceId: string, input: unknown) {
  const request = readerRelationsSchema.parse(input);
  return {
    workspaceId,
    ...(request.direction === "parent" || request.direction === "children"
      ? catalogRelations(await loadNodeCatalog(fs), { kind: "live", workspaceId }, request)
      : (await liveContextReader(fs, { kind: "live", workspaceId })).relations(request)),
  };
}

/** Explicit whole-tree export; ordinary list/get never calls this unbounded operation. */
export async function readFullNodeTree(fs: FsAdapter, options: { capture?: boolean } = {}) {
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
  const documents = [...tree.byPath.values()].map((node) => ({
    path: nodeNotePath(node.path),
    raw: observed.get(nodeNotePath(node.path))!,
  }));
  // The loader already read exact raw bytes. Capture those bytes together, without reading the tree again.
  const versions = options.capture ? await captureReadDocuments(fs, documents) : [];
  const byPath = new Map(versions.map((version) => [version.path, version]));
  const project = (node: (typeof tree.roots)[number]): Record<string, unknown> => {
    const data = node.fm;
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
      ...(version ? { version } : {}),
      children: node.children.map(project),
    };
  };
  return tree.roots.map(project);
}
