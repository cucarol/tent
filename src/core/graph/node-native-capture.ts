import type { DocumentHeaderObservation, FsAdapter } from "../store/adapter.js";
import { loadNodeCatalog, type NodeCatalog } from "./node-catalog.js";
import { isNodeNotePath, nodeNotePath } from "../base/paths.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { assertNodeEdit } from "./node-document-write.js";

export type InvalidNativeNode = { path: string; nodeId?: string; reason: string };

/** Command/hook boundary. Native saves retain document versions just like CLI saves. */
export async function captureNativeNodeEdits(fs: FsAdapter): Promise<{
  invalidNodes: InvalidNativeNode[];
  changedNodePaths: string[];
  catalog: NodeCatalog;
}> {
  const capture = async (
    locked = false,
  ): Promise<{
    invalidNodes: InvalidNativeNode[];
    changedNodePaths: string[];
    catalog: NodeCatalog;
  }> => {
    fs.invalidNodeEdits = new Map();
    const fingerprints = new Map<string, DocumentHeaderObservation>();
    const source = new Proxy(fs, {
      get(target, key) {
        if (key === "readFrontmatter")
          return async (path: string) => {
            const header = await target.readFrontmatterWithFingerprint(path);
            fingerprints.set(path, header);
            return header.content;
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const collect = async () => {
      const catalog = await loadNodeCatalog(source);
      const blobs = await fs.history.documentBlobs();
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
            if (header && blobs.get(path) === header.fingerprint) continue;
            documents.push({ path, raw: await fs.readFile(path) });
          }
        }),
      );
      documents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { catalog, documents, retained };
    };
    // Candidate full reads share the header observation's scope. Fingerprints
    // never stand in for raw bytes when a document needs to be retained.
    const { catalog, documents, retained } = await fs.observationScope(collect);
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
    const edited = await fs.history.changedRetainedDocuments(documents);
    const pending: { path: string; raw: string; previousRaw?: string }[] = [
      ...edited,
      ...documents.filter((document) => !retained.has(document.path)),
    ];
    const changedNodePaths = [
      ...new Set([...pending.map((document) => document.path), ...removed]),
    ].sort();
    // An unchanged workspace needs no write lock. A possible save is inspected
    // again under the lock before validating metadata or capturing versions.
    if (changedNodePaths.length && !locked) return fs.withLock(() => capture(true));
    const removedById = new Map<string, { path: string; raw: string }>();
    if (removed.length) {
      const head = await fs.history.currentCommit();
      const previous = await fs.history.readVersions(
        removed.map((path) => ({ commit: head!, path })),
      );
      for (const [index, raw] of previous.entries()) {
        const id = parseFrontmatter(raw).data.id;
        if (typeof id === "string") removedById.set(id, { path: removed[index]!, raw });
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
        assertNodeEdit(directory, document.previousRaw ?? moved?.raw ?? document.raw, document.raw);
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
    if (changes.length)
      await fs.history.captureUnlocked(changes, { operation: "node.native-save" });
    const invalidNodes = [...invalid.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    fs.invalidNodeEdits = new Map(invalidNodes.map((node) => [node.path.slice(6), node.reason]));
    const current: NodeCatalog = invalidNodes.length ? await loadNodeCatalog(fs) : catalog;
    return { invalidNodes, changedNodePaths, catalog: current };
  };
  return capture();
}
