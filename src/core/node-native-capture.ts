import type { FsAdapter } from "./adapter.js";
import { documentHeader, loadNodeCatalog, type NodeCatalog } from "./node-catalog.js";
import { MUTATION_LOCK_PATH, nodeNotePath } from "./paths.js";
import { parseFrontmatter } from "./frontmatter.js";
import { contentEtag } from "./etag.js";
import { prepareNodeDocumentWrite } from "./node-document-write.js";
import { prepareNodeSyncSave } from "./node-sync-record.js";
import type { NodeBasisRecord } from "./node-basis-record.js";

export type InvalidNativeNode = { path: string; nodeId?: string; reason: string };

/** Command/hook boundary. Ordinary native saves retain the same bases as CLI saves. */
export async function captureNativeNodeEdits(
  fs: FsAdapter,
): Promise<{ invalidNodes: InvalidNativeNode[]; catalog?: NodeCatalog }> {
  if (!fs.history || !(await fs.exists(".git"))) return { invalidNodes: [] };
  const capture = async (
    locked = false,
  ): Promise<{ invalidNodes: InvalidNativeNode[]; catalog: NodeCatalog }> => {
    fs.invalidNodeEdits = new Map();
    const observed = new Map<string, string>();
    const source = new Proxy(fs, {
      get(target, key) {
        if (key === "readFrontmatter")
          return async (path: string) => {
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
    const catalog = await loadNodeCatalog(source);
    const documents = [...catalog.tree.byPath.values()].map((node) => ({
      path: nodeNotePath(node.path),
      raw: observed.get(nodeNotePath(node.path))!,
    }));
    const invalid: InvalidNativeNode[] = [...catalog.tree.byPath.values()]
      .filter((node) => node.invalid)
      .map((node) => ({
        path: `.tent/${nodeNotePath(node.path)}`,
        ...(node.id ? { nodeId: node.id } : {}),
        reason: node.invalidReason ?? "Invalid Node",
      }));
    const pending = await fs.history!.changedRetainedDocuments(documents);
    // An unchanged workspace needs no write lock. A possible save is inspected
    // again under the lock before validating metadata or deriving new bases.
    if (pending.length && !locked && fs.withLock)
      return fs.withLock(MUTATION_LOCK_PATH, () => capture(true));
    const changes: { path: string; raw: string }[] = [];
    const nodeRecords: Record<string, NodeBasisRecord> = {};
    let records: Awaited<ReturnType<NonNullable<FsAdapter["history"]>["nodeRecords"]>> | undefined;
    for (const document of pending) {
      const directory = document.path.slice(0, document.path.lastIndexOf("/"));
      const node = catalog.tree.byPath.get(directory)!;
      if (node.invalid) continue;
      let id: string;
      try {
        const previous = parseFrontmatter(document.previousRaw);
        id = String(previous.data.id);
        prepareNodeDocumentWrite({ id, path: directory }, document.previousRaw, {
          raw: document.raw,
          baseEtag: contentEtag(document.previousRaw),
        });
      } catch (error) {
        invalid.push({
          path: `.tent/${document.path}`,
          ...(node.id ? { nodeId: node.id } : {}),
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const { record } = await prepareNodeSyncSave(fs, document.path, document.raw, {
        previousRaw: document.previousRaw,
        nodes: catalog.byId,
        records: (records ??= await fs.history!.nodeRecords()),
      });
      if ((await fs.readFile(document.path)) !== document.raw)
        throw new Error(`Node changed during native capture; retry: ${document.path}`);
      changes.push({ path: document.path, raw: document.raw });
      if (record) nodeRecords[id] = record;
    }
    if (changes.length)
      await fs.history!.captureUnlocked(changes, { operation: "node.native-save", nodeRecords });
    fs.invalidNodeEdits = new Map(invalid.map((node) => [node.path.slice(6), node.reason]));
    const current: NodeCatalog = invalid.length ? await loadNodeCatalog(fs) : catalog;
    if (!invalid.length)
      current.observedDocuments = new Map(
        [...catalog.byId.values()].map(({ header: _header, ...node }) => {
          const raw = observed.get(nodeNotePath(node.path))!;
          return [node.nodeId, { ...node, raw, etag: contentEtag(raw) }];
        }),
      );
    return { invalidNodes: invalid, catalog: current };
  };
  return capture();
}
