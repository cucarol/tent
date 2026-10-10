import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";
import { readOnlyFs } from "./adapter.js";
import { canonicalDocumentReferencesWithPaths } from "./document-links.js";
import { contentEtag } from "./etag.js";
import {
  NODE_FRONTMATTER_KEY_ORDER,
  parseFrontmatter,
  serializeFrontmatter,
} from "./frontmatter.js";
import { isNodeId, makeUniqueNodeId } from "./id.js";
import {
  materialFields,
  resourceSchema,
  sourcesSchema,
  validateMaterialAddresses,
} from "./material.js";
import { loadNodeCatalog, readCatalogDocument } from "./node-catalog.js";
import { NodeWriteError, prepareNodeDocumentWrite } from "./node-document-write.js";
import { isIncompleteNodeReadEtag } from "./node-read-basis.js";
import { normalizeOptionalNodeType } from "./node-type.js";
import type { OpsEnv } from "./ops-context.js";
import { loadOrder, ROOT_KEY } from "./order.js";
import { MUTATION_LOCK_PATH, nodeNotePath, ORDER_PATH } from "./paths.js";
import { validateNodeName } from "./scaffold.js";
import { normalizeTagList } from "./tags.js";
import { rewriteMarkdownDestinations } from "../markdown/links.js";
import { ReaderError } from "./context-reader.js";
import { recoverPendingNodeMoveUnlocked } from "./node-move-recovery.js";
import { recoverPendingDeleteUnlocked } from "./delete-recovery.js";
import {
  prepareNodeSyncSave,
  retainedNodeRecords,
  isOutputNode,
  type NodeBasisRecord,
} from "./node-sync-record.js";

import {
  prepareNodeProvenanceSave,
  nodeActorSchema,
  recordNodeVerification,
} from "./node-provenance.js";

const localRef = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const nodeId = z.string().refine(isNodeId, "Expected a canonical node-* id");
const createItem = z.strictObject({
  op: z.literal("create"),
  ref: localRef,
  parent: z
    .union([nodeId, z.string().regex(/^@[A-Za-z][A-Za-z0-9_-]*$/)])
    .nullable()
    .optional(),
  name: z.string(),
  type: z.string(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  resource: resourceSchema.optional(),
  sources: sourcesSchema.optional(),
  by: nodeActorSchema.optional(),
});
const updateItem = z
  .strictObject({
    op: z.literal("update"),
    nodeId,
    baseEtag: z.string().min(1),
    raw: z.string().optional(),
    body: z.string().optional(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
    confirm: z.boolean().optional(),
    by: nodeActorSchema.optional(),
  })
  .refine(
    (p) =>
      p.raw !== undefined
        ? p.body === undefined && p.frontmatter === undefined
        : p.confirm === true ||
          p.body !== undefined ||
          (p.frontmatter !== undefined && Object.keys(p.frontmatter).length > 0),
    "Supply raw alone, or body and/or frontmatter",
  );

export const nodeWriteBatchInputSchema = z.strictObject({
  items: z.array(z.union([createItem, updateItem])).min(1),
});
export type NodeWriteBatchInput = z.infer<typeof nodeWriteBatchInputSchema>;
export type NodeWriteBatchResult = {
  results: { nodeId: string; path: string; etag: string }[];
  commit?: string;
};
type PlannedNode = {
  nodeId: string;
  path: string;
  before: string | null;
  raw: string;
  parentId?: string;
  confirm?: boolean;
  by?: string;
};

export class NodeBatchWriteError extends Error {
  constructor(
    readonly details: { paths: string[]; conflicts: string[] },
    readonly causes: unknown[],
  ) {
    super(
      `Batch save failed and rollback was incomplete; reread before retrying. Affected paths: ${details.paths.join(", ")}. Conflicts: ${details.conflicts.join(", ") || "none"}`,
    );
    this.name = "NodeBatchWriteError";
  }
}

/** One lock, all-item preflight, one selected-document capture. No intermediate batch state is retained. */
export function writeNodesBatch(
  env: OpsEnv,
  input: NodeWriteBatchInput,
): Promise<NodeWriteBatchResult> {
  // Batch owns rollback and capture; the automatic write finalizer would capture
  // intermediate preimages and turn a capture failure into a partial batch save.
  const fs = env.fs;
  const action = async () => {
    // Preserve the shared mutation entry's recovery capture, then keep the
    // batch itself outside NodeFs's automatic per-write history scope.
    const recover = async () => {
      await recoverPendingNodeMoveUnlocked(env.fs);
      await recoverPendingDeleteUnlocked(env.fs);
    };
    if (env.fs.withDocumentHistory)
      await env.fs.withDocumentHistory(recover, { operation: "workspace.recovery" });
    else await recover();
    return writeNodesBatchUnlocked(env, input);
  };
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, action) : action();
}

async function writeNodesBatchUnlocked(
  env: OpsEnv,
  input: NodeWriteBatchInput,
): Promise<NodeWriteBatchResult> {
  const { items } = nodeWriteBatchInputSchema.parse(input),
    fs = env.fs;
  const catalog = await loadNodeCatalog(fs);
  const ids = new Set([...catalog.byPath.values()].map((n) => n.nodeId));
  const creates = new Map<
    string,
    { item: z.infer<typeof createItem>; nodeId: string; path?: string; parentId?: string }
  >();
  const updates = new Set<string>();
  for (const item of items) {
    if (item.op === "create") {
      if (creates.has(item.ref)) throw new Error(`Duplicate batch ref: @${item.ref}`);
      const id = makeUniqueNodeId(ids, env.rand);
      ids.add(id);
      creates.set(item.ref, { item, nodeId: id });
    } else {
      if (updates.has(item.nodeId)) throw new Error(`Duplicate batch update: ${item.nodeId}`);
      updates.add(item.nodeId);
      if (isIncompleteNodeReadEtag(item.baseEtag))
        throw new NodeWriteError(
          "INCOMPLETE_READ",
          "Batch update requires a complete Node read ETag; use tent node get <nodeId> --full before writing",
        );
    }
  }
  const visiting = new Set<string>();
  function locate(ref: string): string {
    const entry = creates.get(ref);
    if (!entry) throw new Error(`Unknown batch ref: @${ref}`);
    if (entry.path !== undefined) return entry.path;
    if (visiting.has(ref)) throw new Error(`Cyclic batch parent: @${ref}`);
    visiting.add(ref);
    const parent = entry.item.parent;
    let parentPath = "";
    if (parent?.startsWith("@")) {
      parentPath = locate(parent.slice(1));
      entry.parentId = creates.get(parent.slice(1))!.nodeId;
    } else if (parent) {
      const node = catalog.byId.get(parent);
      if (!node) throw new NodeWriteError("NOT_FOUND", `Parent Node not found: ${parent}`);
      parentPath = node.path;
      entry.parentId = node.nodeId;
    }
    const name = validateNodeName(entry.item.name, parentPath);
    entry.path = parentPath ? `${parentPath}/${name}` : name;
    visiting.delete(ref);
    return entry.path;
  }
  const paths = new Map([...catalog.byId.values()].map((n) => [n.nodeId, nodeNotePath(n.path)]));
  const createdPaths = new Set<string>();
  for (const [ref, entry] of creates) {
    const path = locate(ref);
    if (createdPaths.has(path) || (await fs.exists(path)))
      throw new Error(`Node path already exists: ${path}`);
    createdPaths.add(path);
    paths.set(entry.nodeId, nodeNotePath(path));
    paths.set(`@${ref}`, nodeNotePath(path));
  }
  function references(path: string, data: Record<string, unknown>, body: string): string {
    const resources = materialFields(data);
    function requireLocalRef(address: string | undefined) {
      if (address?.startsWith("@") && !paths.has(address.split(/[?#]/, 1)[0]!))
        throw new Error(`Unknown batch ref: ${address}`);
    }
    for (const address of [
      resources.resource,
      ...(resources.sources ?? []).map((s) => s.resource),
    ]) {
      requireLocalRef(address);
    }
    // Validate exactly the AST destinations that canonical writes visit,
    // including attachment-like links that relationship discovery excludes.
    rewriteMarkdownDestinations(body, (address) => {
      requireLocalRef(address);
      return undefined;
    });
    return canonicalDocumentReferencesWithPaths(nodeNotePath(path), data, body, paths);
  }
  function normalizeRaw(path: string, raw: string): string {
    const parsed = parseFrontmatter(raw),
      before = structuredClone(parsed.data);
    const body = references(path, parsed.data, parsed.body);
    return body === parsed.body && isDeepStrictEqual(before, parsed.data)
      ? raw
      : serializeFrontmatter(parsed.data, body, parsed.keyOrder);
  }
  const planned: PlannedNode[] = [];
  for (const item of items) {
    if (item.op === "create") {
      const entry = creates.get(item.ref)!,
        path = entry.path!;
      const tags = item.tags === undefined ? [] : normalizeTagList(item.tags);
      const data = {
        id: entry.nodeId,
        type: normalizeOptionalNodeType(item.type),
        ...(tags.length ? { tags } : {}),
        ...materialFields(item),
      };
      const body = references(path, data, item.body ?? "");
      validateMaterialAddresses(data, nodeNotePath(path));
      planned.push({
        nodeId: entry.nodeId,
        path,
        before: null,
        raw: serializeFrontmatter(data, body, NODE_FRONTMATTER_KEY_ORDER),
        parentId: entry.parentId,
        by: item.by,
      });
    } else {
      const node = catalog.byId.get(item.nodeId);
      if (!node) throw new NodeWriteError("NOT_FOUND", `Node not found: ${item.nodeId}`);
      const document = await readCatalogDocument(fs, node).catch((error) => {
        if (error instanceof ReaderError && error.code === "SOURCE_CHANGED")
          throw new NodeWriteError("ETAG_CONFLICT", "Node changed during batch lookup", {
            nodeId: item.nodeId,
            path: node.path,
          });
        throw error;
      });
      // Resolve only declared reference positions before material validation.
      const edit = { ...item };
      if (edit.raw !== undefined) edit.raw = normalizeRaw(node.path, edit.raw);
      else {
        if (edit.frontmatter !== undefined) edit.frontmatter = structuredClone(edit.frontmatter);
        const body = references(node.path, edit.frontmatter ?? {}, edit.body ?? "");
        if (edit.body !== undefined) edit.body = body;
      }
      const raw = normalizeRaw(
        node.path,
        prepareNodeDocumentWrite({ id: node.nodeId, path: node.path }, document.raw, edit),
      );
      planned.push({
        nodeId: node.nodeId,
        path: node.path,
        before: document.raw,
        raw,
        by: item.by,
        confirm: item.confirm,
      });
    }
  }
  const now = env.clock.now();
  const finalDocuments = new Map<string, string>();
  const nodes = new Map(catalog.byId);
  const nodeRecords: Record<string, NodeBasisRecord> = {};
  for (const node of planned) {
    node.raw = prepareNodeProvenanceSave(node.raw, node.before, node.by, now);
    if (node.confirm) {
      const parsed = parseFrontmatter(node.raw);
      recordNodeVerification(parsed.data, node.by, now);
      node.raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
    }
    finalDocuments.set(nodeNotePath(node.path), node.raw);
    const parsed = parseFrontmatter(node.raw);
    nodes.set(node.nodeId, {
      nodeId: node.nodeId,
      name: node.path.split("/").at(-1)!,
      path: node.path,
      type: parsed.data.type as string,
      header: node.raw.slice(0, node.raw.length - parsed.body.length),
      parentNodeId: node.parentId ?? nodes.get(node.nodeId)?.parentNodeId ?? null,
      childNodeIds: [],
      archived: false,
      invalid: false,
    });
  }
  const basisRecords = await retainedNodeRecords(fs);
  const acknowledgedOutputIds: string[] = [];
  for (const node of [...planned].sort(
    (a, b) =>
      Number(isOutputNode(parseFrontmatter(a.raw).data)) -
      Number(isOutputNode(parseFrontmatter(b.raw).data)),
  )) {
    const output = isOutputNode(parseFrontmatter(node.raw).data);
    if (output && node.confirm) acknowledgedOutputIds.push(node.nodeId);
    const prepared = await prepareNodeSyncSave(fs, nodeNotePath(node.path), node.raw, {
      now,
      created: node.before === null,
      previousRaw: node.before ?? undefined,
      confirm: node.confirm,
      by: node.by,
      nodes,
      finalDocuments,
      records: basisRecords,
    });
    node.raw = prepared.raw;
    if (prepared.record) {
      nodeRecords[node.nodeId] = prepared.record;
      basisRecords[node.nodeId] = prepared.record;
    }
  }
  const beforeOrder = (await fs.exists(ORDER_PATH)) ? await fs.readFile(ORDER_PATH) : null;
  const order = await loadOrder(readOnlyFs(fs));
  for (const node of planned.filter((n) => n.before === null)) {
    const key = node.parentId ?? ROOT_KEY;
    order[key] = [...(order[key] ?? []), node.nodeId];
  }
  const afterOrder = creates.size ? JSON.stringify(order, null, 2) + "\n" : beforeOrder;
  async function check(node: PlannedNode, expected: string | null) {
    const path = nodeNotePath(node.path);
    if (expected === null ? await fs.exists(node.path) : (await fs.readFile(path)) !== expected)
      throw new NodeWriteError("ETAG_CONFLICT", `Node changed during batch save: ${node.path}`);
  }
  for (const node of planned) await check(node, node.before);
  if (((await fs.exists(ORDER_PATH)) ? await fs.readFile(ORDER_PATH) : null) !== beforeOrder)
    throw new Error("Node order changed during batch preparation");
  const attempted: PlannedNode[] = [],
    directories: string[] = [];
  let orderAttempted = false;
  try {
    for (const path of [...createdPaths].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    )) {
      if (await fs.exists(path)) throw new Error(`Node path appeared during batch save: ${path}`);
      directories.push(path);
      await fs.mkdir(path);
    }
    for (const node of planned) {
      if (node.before !== null) await check(node, node.before);
      else if (await fs.exists(nodeNotePath(node.path)))
        throw new NodeWriteError(
          "ETAG_CONFLICT",
          `Node document appeared during batch save: ${nodeNotePath(node.path)}`,
        );
      if (node.raw === node.before) continue;
      attempted.push(node);
      await fs.writeFile(nodeNotePath(node.path), node.raw);
    }
    if (afterOrder !== beforeOrder && afterOrder !== null) {
      if (((await fs.exists(ORDER_PATH)) ? await fs.readFile(ORDER_PATH) : null) !== beforeOrder)
        throw new Error("Node order changed during batch save");
      orderAttempted = true;
      await fs.writeFile(ORDER_PATH, afterOrder);
    }
    for (const node of planned) await check(node, node.raw);
    const captured =
      fs.history && (await fs.exists(".git"))
        ? await fs.history.captureUnlocked(
            planned.map((n) => ({ path: nodeNotePath(n.path), raw: n.raw })),
            { operation: "node.write-many", nodeRecords, acknowledgedOutputIds },
          )
        : undefined;
    return {
      results: planned.map((n) => ({ nodeId: n.nodeId, path: n.path, etag: contentEtag(n.raw) })),
      ...(captured?.commit ? { commit: captured.commit } : {}),
    };
  } catch (error) {
    const failures: unknown[] = [],
      conflicts: string[] = [];
    async function restore(path: string, before: string | null, after: string) {
      const current = (await fs.exists(path)) ? await fs.readFile(path) : null;
      if (current === before) return;
      if (current !== after) {
        conflicts.push(path);
        return;
      }
      if (before === null) await fs.remove(path);
      else await fs.writeFile(path, before);
    }
    for (const node of attempted.reverse()) {
      try {
        await restore(nodeNotePath(node.path), node.before, node.raw);
      } catch (rollback) {
        failures.push(rollback);
      }
    }
    if (orderAttempted) {
      try {
        await restore(ORDER_PATH, beforeOrder, afterOrder!);
      } catch (rollback) {
        failures.push(rollback);
      }
    }
    for (const node of planned) {
      if (node.before !== null || attempted.includes(node)) continue;
      try {
        if (await fs.exists(nodeNotePath(node.path))) conflicts.push(nodeNotePath(node.path));
      } catch (rollback) {
        failures.push(rollback);
      }
    }
    // Never infer physical directory ownership from listDir's Node inventory:
    // it excludes Git files, and other entries can arrive after any inspection.
    for (const path of directories.reverse()) {
      try {
        await fs.removeEmptyDir(path);
      } catch (rollback) {
        const code = (rollback as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") conflicts.push(path);
        else if (code !== "ENOENT") failures.push(rollback);
      }
    }
    if (failures.length || conflicts.length)
      throw new NodeBatchWriteError(
        {
          paths: [
            ...new Set([
              ...attempted.map((n) => nodeNotePath(n.path)),
              ...directories,
              ...(orderAttempted ? [ORDER_PATH] : []),
            ]),
          ],
          conflicts: [...new Set(conflicts)],
        },
        [error, ...failures],
      );
    throw error;
  }
}
