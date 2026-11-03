import { hasDocumentHistory } from "../store/history-port.js";
import type { DocumentHeaderObservation, FsAdapter } from "../store/adapter.js";
import { documentHeader, loadNodeCatalog, type NodeCatalog } from "./node-catalog.js";
import {
  DELETE_PENDING_PATH,
  MUTATION_LOCK_PATH,
  NODE_MOVE_PENDING_PATH,
  isNodeNotePath,
  nodeNotePath,
} from "../base/paths.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { contentEtag } from "../base/etag.js";
import { prepareNodeDocumentWrite } from "./node-document-write.js";
import { ReaderError } from "./context-reader.js";
import { recoverPendingNodeMoveUnlocked } from "../store/node-move-recovery.js";
import { recoverPendingDeleteUnlocked } from "../store/delete-recovery.js";

export type InvalidNativeNode = { path: string; nodeId?: string; reason: string };

/** Command/hook boundary. Native saves retain document versions just like CLI saves. */
export async function captureNativeNodeEdits(fs: FsAdapter): Promise<{
  invalidNodes: InvalidNativeNode[];
  changedNodePaths: string[];
  catalog?: NodeCatalog;
}> {
  if (!fs.history || !(await hasDocumentHistory(fs)))
    return { invalidNodes: [], changedNodePaths: [] };
  const capture = async (
    locked = false,
  ): Promise<{
    invalidNodes: InvalidNativeNode[];
    changedNodePaths: string[];
    catalog: NodeCatalog;
  }> => {
    fs.invalidNodeEdits = new Map();
    if ((await fs.exists(NODE_MOVE_PENDING_PATH)) || (await fs.exists(DELETE_PENDING_PATH))) {
      if (!locked && fs.withLock) return fs.withLock(MUTATION_LOCK_PATH, () => capture(true));
      const recover = async () => {
        await recoverPendingNodeMoveUnlocked(fs);
        await recoverPendingDeleteUnlocked(fs);
      };
      if (fs.withDocumentHistory)
        await fs.withDocumentHistory(recover, { operation: "workspace.recovery" });
      else await recover();
    }
    const observed = new Map<string, string>();
    const fingerprints = new Map<string, DocumentHeaderObservation>();
    const source = new Proxy(fs, {
      get(target, key) {
        if (key === "readFrontmatter")
          return async (path: string) => {
            if (target.readFrontmatterWithFingerprint) {
              const header = await target.readFrontmatterWithFingerprint(path);
              try {
                if (
                  /^[a-f0-9]{64}$/.test(header.fingerprint) &&
                  documentHeader(header.content) === header.content
                ) {
                  fingerprints.set(path, header);
                  return header.content;
                }
              } catch {
                // A malformed prefix still needs the ordinary current-byte diagnostic.
              }
            }
            const raw = await target.readFile(path);
            observed.set(path, raw);
            try {
              return documentHeader(raw);
            } catch {
              return raw;
            }
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const collect = async () => {
      const catalog = await loadNodeCatalog(source);
      const blobs = await fs.history!.documentBlobs();
      const retained = new Set([...blobs.keys()].filter(isNodeNotePath));
      const paths = [...catalog.tree.byPath.keys()].map(nodeNotePath);
      const documents: { path: string; raw: string }[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(16, paths.length) }, async () => {
          for (;;) {
            const path = paths[next++];
            if (path === undefined) return;
            const header = fingerprints.get(path);
            if (
              header &&
              /^[a-f0-9]{64}$/.test(header.fingerprint) &&
              blobs.get(path) === header.fingerprint
            )
              continue;
            const raw = observed.get(path) ?? (await fs.readFile(path));
            let currentHeader: string;
            try {
              currentHeader = documentHeader(raw);
            } catch {
              currentHeader = raw;
            }
            if (header && currentHeader !== header.content)
              throw new ReaderError(
                "SOURCE_CHANGED",
                "Node metadata changed during native collection; retry",
              );
            documents.push({ path, raw });
          }
        }),
      );
      documents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { catalog, documents, retained };
    };
    let collected: Awaited<ReturnType<typeof collect>>;
    try {
      // Candidate full reads share the header observation's scope. Fingerprints
      // never stand in for raw bytes when a document needs to be retained.
      collected = fs.observationScope ? await fs.observationScope(collect) : await collect();
    } catch (error) {
      // The unlocked scan is only a probe. If a writer invalidates it, queue
      // one fresh observation before any validation, capture or caller action.
      if (!locked && fs.withLock && error instanceof ReaderError && error.code === "SOURCE_CHANGED")
        return fs.withLock(MUTATION_LOCK_PATH, () => capture(true));
      throw error;
    }
    const { catalog, documents, retained } = collected;
    const invalid = new Map(
      [...catalog.tree.byPath.values()]
        .filter((node) => node.invalid)
        .map((node) => ({
          path: `.tent/${nodeNotePath(node.path)}`,
          ...(node.id ? { nodeId: node.id } : {}),
          reason: node.invalidReason ?? "Invalid Node",
        }))
        .map((node) => [node.path, node]),
    );
    const currentPaths = new Set([...catalog.tree.byPath.keys()].map(nodeNotePath));
    const removed = [...retained].filter((path) => !currentPaths.has(path));
    const edited = await fs.history!.changedRetainedDocuments(documents);
    const pending: { path: string; raw: string; previousRaw?: string }[] = [
      ...edited,
      ...documents.filter((document) => !retained.has(document.path)),
    ];
    const changedNodePaths = [
      ...new Set([...pending.map((document) => document.path), ...removed]),
    ].sort();
    // An unchanged workspace needs no write lock. A possible save is inspected
    // again under the lock before validating metadata or capturing versions.
    if (changedNodePaths.length && !locked && fs.withLock)
      return fs.withLock(MUTATION_LOCK_PATH, () => capture(true));
    const removedById = new Map<string, { path: string; raw: string }>();
    if (removed.length) {
      const head = await fs.history!.currentCommit();
      const previous = await fs.history!.readVersions(
        removed.map((path) => ({ commit: head!, path })),
      );
      for (let index = 0; index < previous.length; index++) {
        const document = previous[index]!;
        if (document instanceof Error) throw document;
        const id = parseFrontmatter(document.raw).data.id;
        if (typeof id === "string")
          removedById.set(id, { path: removed[index]!, raw: document.raw });
      }
    }
    const editedById = new Map(
      edited.map((document) => [String(parseFrontmatter(document.previousRaw).data.id), document]),
    );
    const rejectedMoves = new Set<string>();
    const changes: { path: string; raw: string | null }[] = [];
    for (const document of pending) {
      const directory = document.path.slice(0, document.path.lastIndexOf("/"));
      const node = catalog.tree.byPath.get(directory)!;
      const moved = removedById.get(node.id);
      if (node.invalid) {
        if (moved) rejectedMoves.add(moved.path);
        continue;
      }
      try {
        if (document.previousRaw === undefined && editedById.has(node.id))
          throw new Error(
            `Duplicate id: ${node.id}; retained Node identity remains at ${editedById.get(node.id)!.path}.`,
          );
        const previousRaw = document.previousRaw ?? moved?.raw ?? document.raw;
        const id = String(parseFrontmatter(previousRaw).data.id);
        prepareNodeDocumentWrite({ id, path: directory }, previousRaw, {
          raw: document.raw,
          baseEtag: contentEtag(previousRaw),
        });
      } catch (error) {
        invalid.set(`.tent/${document.path}`, {
          path: `.tent/${document.path}`,
          ...(node.id ? { nodeId: node.id } : {}),
          reason: error instanceof Error ? error.message : String(error),
        });
        if (moved) rejectedMoves.add(moved.path);
        continue;
      }
      changes.push({ path: document.path, raw: document.raw });
    }
    changes.push(
      ...removed.filter((path) => !rejectedMoves.has(path)).map((path) => ({ path, raw: null })),
    );
    for (const document of changes) {
      const raw = await fs.readFile(document.path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (raw !== document.raw)
        throw new Error(`Node changed during native capture; retry: ${document.path}`);
    }
    if (changes.length)
      await fs.history!.captureUnlocked(changes, { operation: "node.native-save" });
    const invalidNodes = [...invalid.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    fs.invalidNodeEdits = new Map(invalidNodes.map((node) => [node.path.slice(6), node.reason]));
    const current: NodeCatalog = invalidNodes.length ? await loadNodeCatalog(fs) : catalog;
    return { invalidNodes, changedNodePaths, catalog: current };
  };
  return capture();
}
