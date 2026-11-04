import { hasDocumentHistory } from "../store/history-port.js";
import * as z from "zod/v4";
import { canonicalDocumentReferencesWithPaths } from "../graph/document-links.js";
import { validateSystemMaterials, systemMaterialPath } from "../graph/material-target.js";
import { materialLocator } from "../base/material.js";
import { contentEtag } from "../base/etag.js";
import {
  NODE_FRONTMATTER_KEY_ORDER,
  parseFrontmatter,
  serializeFrontmatter,
} from "../base/frontmatter.js";
import { isNodeId, makeUniqueNodeId } from "../base/id.js";
import {
  materialFields,
  resourceSchema,
  sourcesSchema,
  validateMaterialAddresses,
} from "../base/material.js";
import { loadNodeCatalog } from "../graph/node-catalog.js";
import { NodeWriteError } from "../graph/node-document-write.js";
import { normalizeOptionalNodeType } from "../base/node-type.js";
import type { OpsEnv } from "../graph/ops-context.js";
import { loadOrder, ROOT_KEY } from "../store/order.js";
import { MUTATION_LOCK_PATH, nodeNotePath, ORDER_PATH } from "../base/paths.js";
import { validateNodeName } from "../store/scaffold.js";
import { normalizeTagList } from "../base/tags.js";
import { nodeMaterialWarnings } from "../graph/node-material-warnings.js";
import { rewriteMarkdownDestinations } from "../base/links.js";
const requiredString = (field: string) =>
  z.string({ error: (issue) => (issue.input === undefined ? `${field} is required` : undefined) });
const localRef = requiredString("ref").regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const nodeId = requiredString("nodeId").refine(isNodeId, "Expected a canonical node-* id");
const createItem = z.strictObject({
  op: z.literal("create", { error: "op must be create" }),
  ref: localRef,
  id: nodeId.optional(),
  parent: z
    .union([nodeId, z.string().regex(/^@[A-Za-z][A-Za-z0-9_-]*$/)])
    .nullable()
    .optional(),
  name: requiredString("name"),
  type: requiredString("type"),
  body: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  resource: resourceSchema.optional(),
  sources: sourcesSchema.optional(),
});
export const nodeWriteBatchInputSchema = z.strictObject({ items: z.array(createItem).min(1) });
export type NodeWriteBatchInput = z.infer<typeof nodeWriteBatchInputSchema>;
export type NodeWriteBatchResult = {
  results: { nodeId: string; path: string; etag: string }[];
  commit?: string;
  warnings?: string[];
};
type PlannedNode = { nodeId: string; path: string; raw: string; parentId?: string };

/** Validates a created item's name, naming the item when it is not a portable file name. */
export function validateBatchItemName(ref: string, name: string, parentPath: string): string {
  try {
    return validateNodeName(name, parentPath);
  } catch (error) {
    throw new Error(`Batch item @${ref}: ${(error as Error).message}`);
  }
}

/** Shared batch mutation boundary, outside NodeFs's automatic per-write history scope. */
export function withNodeBatchMutation<T>(env: OpsEnv, operation: () => Promise<T>): Promise<T> {
  // Batch owns capture; the automatic write finalizer would capture
  // intermediate preimages and turn a capture failure into a partial batch save.
  const fs = env.fs;
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, operation) : operation();
}

export async function writeNodesBatchUnlocked(
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
  for (const item of items) {
    if (creates.has(item.ref)) throw new Error(`Duplicate batch ref: @${item.ref}`);
    const id = item.id ?? makeUniqueNodeId(ids, env.rand);
    if (ids.has(id)) throw new Error(`Node id already exists: ${id}.`);
    ids.add(id);
    creates.set(item.ref, { item, nodeId: id });
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
    const name = validateBatchItemName(ref, entry.item.name, parentPath);
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
    // including destinations that do not participate in document relationships.
    rewriteMarkdownDestinations(body, (address) => {
      requireLocalRef(address);
      return undefined;
    });
    return canonicalDocumentReferencesWithPaths(nodeNotePath(path), data, body, paths);
  }
  const planned: PlannedNode[] = [];
  for (const item of items) {
    const entry = creates.get(item.ref)!,
      path = entry.path!;
    const tags = item.tags === undefined ? [] : normalizeTagList(item.tags);
    const data = {
      id: entry.nodeId,
      type: normalizeOptionalNodeType(item.type),
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(tags.length ? { tags } : {}),
      ...materialFields(item),
    };
    const body = references(path, data, item.body ?? "");
    validateMaterialAddresses(data, nodeNotePath(path));
    planned.push({
      nodeId: entry.nodeId,
      path,
      raw: serializeFrontmatter(data, body, NODE_FRONTMATTER_KEY_ORDER),
      parentId: entry.parentId,
    });
  }
  const nodePaths = new Set([
    ...[...catalog.byId.values()]
      .filter((node) => !node.invalid)
      .map((node) => nodeNotePath(node.path)),
    ...[...creates.values()].map((node) => nodeNotePath(node.path!)),
  ]);
  for (const node of planned)
    await validateSystemMaterials(
      fs,
      parseFrontmatter(node.raw).data,
      nodeNotePath(node.path),
      {},
      nodePaths,
    );
  const finalDocuments = new Map(planned.map((node) => [nodeNotePath(node.path), node.raw]));
  const beforeOrder = (await fs.exists(ORDER_PATH)) ? await fs.readFile(ORDER_PATH) : null;
  const warnings: string[] = [];
  const warningFs = {
    workspaceRoot: fs.workspaceRoot,
    readMaterialText: async (resource: string, documentPath: string) => {
      const target = systemMaterialPath(
        materialLocator(resource, documentPath, true),
        fs.workspaceRoot,
      );
      const prepared = target === undefined ? undefined : finalDocuments.get(target);
      return prepared ?? fs.readMaterialText?.(resource, documentPath);
    },
  };
  for (const node of planned)
    warnings.push(
      ...(await nodeMaterialWarnings(
        warningFs,
        parseFrontmatter(node.raw).data,
        nodeNotePath(node.path),
        {},
      )),
    );
  const order = await loadOrder(fs);
  for (const node of planned) {
    const key = node.parentId ?? ROOT_KEY;
    order[key] = [...(order[key] ?? []), node.nodeId];
  }
  const afterOrder = JSON.stringify(order, null, 2) + "\n";
  const directories = [...createdPaths].sort((a, b) => a.split("/").length - b.split("/").length);
  await fs.prepareFileTransaction?.(
    [
      ...planned.map((n) => ({ path: nodeNotePath(n.path), before: null, after: n.raw })),
      { path: ORDER_PATH, before: beforeOrder, after: afterOrder },
    ],
    directories,
  );
  for (const path of directories) await fs.mkdir(path);
  for (const node of planned) await fs.writeFile(nodeNotePath(node.path), node.raw);
  await fs.writeFile(ORDER_PATH, afterOrder);
  const captured =
    fs.history && (await hasDocumentHistory(fs))
      ? await fs.history.captureUnlocked(
          planned.map((n) => ({ path: nodeNotePath(n.path), raw: n.raw })),
          { operation: "node.write-many" },
        )
      : undefined;
  return {
    results: planned.map((n) => ({ nodeId: n.nodeId, path: n.path, etag: contentEtag(n.raw) })),
    ...(captured?.commit ? { commit: captured.commit } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
