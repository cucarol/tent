import { isDeepStrictEqual } from "node:util";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { documentLifecycle } from "./document-status.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { nodeNotePath } from "./tree.js";
import { loadNodeCatalog, readCatalogDocument } from "./node-catalog.js";
import { isHistoryDocument } from "./document-history.js";
import type { OpsEnv } from "./ops-context.js";
import type { DocumentVersion } from "./git-history.js";

type StatusWrite = { path: string; before: string; after: string };
type SaveContext = { savedPaths: string[]; beforeCommit?: string };

export class NodeLifecycleError extends Error {
  constructor(
    message: string,
    readonly details: { savedPaths: string[]; beforeCommit?: string; conflicts?: string[] },
  ) {
    super(message);
    this.name = "NodeLifecycleError";
  }
}

function statusRaw(raw: string, status: unknown) {
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (status === undefined) delete data.status;
  else data.status = status;
  return serializeFrontmatter(data, body, keyOrder);
}

/** Writes have finite before/after images. Files and Git are not one atomic transaction. */
async function saveStatusWrites(
  fs: FsAdapter,
  writes: StatusWrite[],
  context: SaveContext,
  operation: string,
) {
  if (!fs.history || !(await fs.history.available()))
    throw new Error("Archive operations require Tent Git history");
  if (!writes.length)
    return { changed: false, paths: [] as string[], versions: [] as DocumentVersion[] };
  const before = await fs.history.captureUnlocked(
    writes.map((w) => ({ path: w.path, raw: w.before })),
    { operation: "document.external-capture" },
  );
  context.beforeCommit = before.commit ?? undefined;
  const savedPaths = context.savedPaths;
  try {
    // Preflight all bytes before the first write; check again immediately before each write.
    for (const w of writes)
      if ((await fs.readFile(w.path)) !== w.before)
        throw new Error(`Document changed before lifecycle save: ${w.path}`);
    for (const w of writes) {
      if ((await fs.readFile(w.path)) !== w.before)
        throw new Error(`Document changed during lifecycle save: ${w.path}`);
      await fs.writeFile(w.path, w.after);
      savedPaths.push(w.path);
    }
    for (const w of writes)
      if ((await fs.readFile(w.path)) !== w.after)
        throw new Error(`Document changed after lifecycle save: ${w.path}`);
    const captured = await fs.history.captureUnlocked(
      writes.map((w) => ({ path: w.path, raw: w.after })),
      { operation },
    );
    return {
      changed: true,
      paths: savedPaths,
      commit: captured.commit!,
      versions: captured.versions,
    };
  } catch (error) {
    throw new NodeLifecycleError(
      `Lifecycle save failed; files may be partially saved. Reread before continuing: ${String(error)}`,
      { savedPaths, ...(before.commit ? { beforeCommit: before.commit } : {}) },
    );
  }
}

/** Keep known save evidence through the outer NodeFs history finalizer as well. */
async function lifecycleMutation<T>(fs: FsAdapter, action: (context: SaveContext) => Promise<T>) {
  const context: SaveContext = { savedPaths: [] };
  try {
    return await withTentMutation(fs, () => action(context));
  } catch (error) {
    if (error instanceof NodeLifecycleError) throw error;
    throw new NodeLifecycleError(
      `Lifecycle operation failed; reread before continuing: ${String(error)}`,
      context,
    );
  }
}

/** Archive exactly the current subtree; local deprecated declarations are not inherited. */
export function archiveNode(env: OpsEnv, nodeId: string) {
  return lifecycleMutation(env.fs, async (context) => {
    const catalog = await loadNodeCatalog(env.fs),
      root = catalog.byId.get(nodeId);
    if (!root) throw new Error(`Node not found: ${nodeId}`);
    const members = [...catalog.byId.values()].filter(
      (n) => n.path === root.path || n.path.startsWith(root.path + "/"),
    );
    // Invalid descendants must not disappear from a successful subtree operation.
    if (
      [...catalog.byPath.values()].some(
        (n) => (n.path === root.path || n.path.startsWith(root.path + "/")) && n.invalid,
      )
    ) {
      throw new Error("Archive subtree contains invalid documents; repair them first");
    }
    const writes: StatusWrite[] = [];
    for (const member of members) {
      const { raw } = await readCatalogDocument(env.fs, member);
      const lifecycle = documentLifecycle(parseFrontmatter(raw).data);
      if (lifecycle.status === null)
        throw new Error(`Unsupported status in archive subtree: ${member.path}`);
      if (lifecycle.status !== "deprecated")
        writes.push({
          path: nodeNotePath(member.path),
          before: raw,
          after: statusRaw(raw, "deprecated"),
        });
    }
    const result = await saveStatusWrites(env.fs, writes, context, "node.archive");
    return { nodeId, path: root.path, ...result };
  });
}

/** Undo only the status changes in a supplied, verifiable archive commit. */
export function restoreNode(env: OpsEnv, nodeId: string, archiveCommit: string) {
  return lifecycleMutation(env.fs, async (context) => {
    const history = env.fs.history;
    if (!history) throw new Error("Archive undo requires Tent Git history");
    const { changes } = await history.commitChanges(archiveCommit);
    const catalog = await loadNodeCatalog(env.fs),
      root = catalog.byId.get(nodeId);
    if (!root) throw new Error(`Node not found: ${nodeId}`);
    if (!changes.length) throw new Error("Commit contains no archive changes");
    const writes: StatusWrite[] = [],
      conflicts: string[] = [];
    for (const change of changes) {
      if (
        !isHistoryDocument(change.path) ||
        !change.path.startsWith(root.path + "/") ||
        change.before === null ||
        change.after === null
      ) {
        throw new Error("Commit is not a pure status archive of the selected subtree");
      }
      const before = parseFrontmatter(change.before),
        after = parseFrontmatter(change.after);
      const { status: previous, ...oldFields } = before.data,
        { status, ...newFields } = after.data;
      const member = catalog.byId.get(String(after.data.id));
      if (
        documentLifecycle(before.data).status === null ||
        previous === "deprecated" ||
        status !== "deprecated" ||
        !isDeepStrictEqual(oldFields, newFields) ||
        before.body !== after.body ||
        !member ||
        nodeNotePath(member.path) !== change.path
      ) {
        throw new Error(`Commit is not a pure status archive: ${change.path}`);
      }
      if (
        (await readCatalogDocument(env.fs, member)).raw !== change.after ||
        (await history.changedSince({ commit: archiveCommit, path: change.path }))
      ) {
        conflicts.push(change.path);
      }
      writes.push({
        path: change.path,
        before: change.after,
        after: statusRaw(change.after, previous),
      });
    }
    if (conflicts.length)
      throw new NodeLifecycleError(
        "Archive undo conflicts with later edits; use explicit status edits against current bytes",
        { savedPaths: [], conflicts },
      );
    return {
      nodeId,
      path: root.path,
      archiveCommit,
      ...(await saveStatusWrites(env.fs, writes, context, "node.restore")),
    };
  });
}
