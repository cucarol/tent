import {
  materialFields,
  validateMaterialAddresses,
  type MaterialFields,
} from "../base/material.js";
// Tent 状态动作的统一入口，供 CLI 与插件共同调用。

import { FsAdapter, withTentMutation } from "../store/adapter.js";
import { loadTent, join, nodeNotePath, LoadedTent } from "../store/tree.js";
import { isNodeId, makeUniqueNodeId } from "../base/id.js";
import { NODE_FRONTMATTER_KEY_ORDER, serializeFrontmatter } from "../base/frontmatter.js";
import { loadOrder, saveOrder, ROOT_KEY } from "../store/order.js";
import { Node } from "../base/types.js";
import { assertContentMutable, isContentMutable } from "../store/tree.js";
import { normalizeTagList } from "../base/tags.js";
import { normalizeOptionalNodeType } from "../base/node-type.js";
import { validateNodeName } from "../store/scaffold.js";
import type { OpsEnv } from "./ops-context.js";
import { ORDER_PATH } from "../base/paths.js";
import { executeDeleteUnlocked, type DeleteWrite } from "../store/delete-recovery.js";
import { canonicalDocumentReferences } from "./document-links.js";
import type { CaptureMetadata } from "../store/history-port.js";
import { prepareNodeSyncSave } from "./node-sync-record.js";
import { prepareNodeProvenanceSave } from "../base/node-provenance.js";
import { captureDocumentUnlocked } from "../store/document-history.js";
import { validateSystemMaterials } from "./material-target.js";

export type { OpsEnv } from "./ops-context.js";
export { renameNode, type RenameNodeResult } from "./rename-ops.js";
export { archiveNode, restoreNode } from "./node-lifecycle.js";
export { moveNode, type MoveNodeResult, type MovePosition } from "./move-ops.js";

// ---- 结构编辑(建框/移动/改属性)----
// Node 文档与结构编辑。

export type NewNodeInput = MaterialFields & {
  id?: string;
  name: string;
  /** Validated as goal, prompt or output. */
  type: string;
  body?: string;
  tags?: string[];
  by?: string;
} & ({ parentPath: string; parentId?: never } | { parentId: string | null; parentPath?: never });

export async function createNode(env: OpsEnv, input: NewNodeInput): Promise<string> {
  return withMutation(env.fs, async () => createNodeUnlocked(env, input), {
    operation: "node.create",
  });
}

export async function createNodeUnlocked(env: OpsEnv, input: NewNodeInput): Promise<string> {
  const materials = materialFields(input as unknown as Record<string, unknown>);
  const tent = await loadTent(env.fs);
  // Resolve an identity under the same mutation lock as the creation, after any earlier writer.
  const parentPath =
    input.parentId === undefined
      ? input.parentPath
      : input.parentId === null
        ? ""
        : requireNodeById(tent, input.parentId).path;
  assertNotTempPath(parentPath);
  const name = validateNodeName(input.name, parentPath);
  const type = normalizeOptionalNodeType(input.type);
  if (parentPath) {
    const parent = tent.byPath.get(parentPath);
    if (!parent || !isContentMutable(parent)) throw new Error("Target parent node is invalid.");
    assertContentMutable(parent, "used as create parent");
  }
  const existing = new Set([...tent.byPath.values()].map((node) => node.id));
  const id = input.id ?? makeUniqueNodeId(existing, env.rand);
  if (!isNodeId(id)) throw new Error("Invalid Node id.");
  if (tent.duplicateIds.has(id)) throw new Error(`Duplicate Node id: ${id}.`);
  const path = join(parentPath, name);
  assertNotTempPath(path);
  // V0.1: every user Node writes an exact canonical type marker.
  const tags = input.tags === undefined ? [] : normalizeTagList(input.tags);
  const fm = { id, type, ...(tags.length === 0 ? {} : { tags }), ...materials };
  const notePath = nodeNotePath(path);
  validateMaterialAddresses(fm, notePath);
  const body = await canonicalDocumentReferences(env.fs, notePath, fm, input.body ?? "");
  await validateSystemMaterials(
    env.fs,
    fm,
    notePath,
    {},
    new Set([
      ...[...tent.byId.values()]
        .filter((node) => !node.invalid)
        .map((node) => nodeNotePath(node.path)),
      notePath,
    ]),
  );
  const content = prepareNodeProvenanceSave(
    serializeFrontmatter(fm, body, NODE_FRONTMATTER_KEY_ORDER),
    null,
    input.by,
    env.clock.now(),
  );
  if (await env.fs.exists(path)) {
    const current = tent.byPath.get(path);
    throw new Error(
      current
        ? `A sibling Node already uses the name ${JSON.stringify(name)}: ${current.id}.`
        : `Node path already exists: ${path}.`,
    );
  }
  if (existing.has(id)) {
    throw new Error(`Node id already exists: ${id}.`);
  }
  // Only a missing order table is removed on rollback; other read failures stop before any write.
  const beforeOrder = await env.fs.readFile(ORDER_PATH).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  });
  try {
    await ensureDir(env.fs, path);
    await env.fs.writeFile(notePath, content);
    const parent = parentPath ? tent.byPath.get(parentPath) : undefined;
    const parentKey = parent ? parent.id : ROOT_KEY;
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
    const prepared = await prepareNodeSyncSave(env.fs, notePath, content, { created: true });
    await captureDocumentUnlocked(env.fs, notePath, prepared.raw, {
      operation: "node.create",
      ...(prepared.record ? { nodeRecords: { [id]: prepared.record } } : {}),
    });
  } catch (error) {
    await env.fs.remove(path);
    if (beforeOrder === null) await env.fs.remove(ORDER_PATH);
    else await env.fs.writeFile(ORDER_PATH, beforeOrder);
    throw error;
  }
  return id;
}

export async function deleteNode(
  env: OpsEnv,
  nodeId: string,
): Promise<{ nodeId: string; path: string }> {
  return withTentMutation(
    env.fs,
    async (recovered) => {
      if (recovered?.kind === "node" && recovered.id === nodeId)
        return { nodeId, path: recovered.source };
      const tent = await loadTent(env.fs);
      const node = requireNodeById(tent, nodeId);

      const removedIds = collectSubtreeIds(node);
      const writes: DeleteWrite[] = [];
      const order = await loadOrder(env.fs);
      const beforeOrder = (await env.fs.exists(ORDER_PATH))
        ? await env.fs.readFile(ORDER_PATH)
        : null;
      for (const key of Object.keys(order)) {
        if (removedIds.has(key)) delete order[key];
        else order[key] = order[key].filter((id) => !removedIds.has(id));
      }
      writes.push({
        path: ORDER_PATH,
        before: beforeOrder,
        after: JSON.stringify(order, null, 2) + "\n",
      });
      await executeDeleteUnlocked(env.fs, {
        kind: "node",
        id: node.id,
        source: node.path,
        raw: await env.fs.readFile(nodeNotePath(node.path)),
        writes,
        nodeIds: [...removedIds],
      });
      return { nodeId, path: node.path };
    },
    { operation: "node.delete" },
  );
}

// ---- 内部工具 ----

async function ensureDir(fs: FsAdapter, path: string): Promise<void> {
  if (path && !(await fs.exists(path))) await fs.mkdir(path);
}

function assertNotTempPath(path: string): void {
  if (path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ is a system pipeline; typed nodes cannot be created or moved there.");
  }
}

function collectSubtreeIds(node: Node, ids = new Set<string>()): Set<string> {
  ids.add(node.id);
  for (const child of node.children) collectSubtreeIds(child, ids);
  return ids;
}

function requireNodeById(tent: LoadedTent, nodeId: string): Node {
  if (tent.duplicateIds.has(nodeId)) {
    throw new Error(
      `Duplicate node id '${nodeId}' found; give independent Nodes unique ids before using this id.`,
    );
  }
  const node = tent.byId.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}.`);
  return node;
}

async function withMutation<T>(
  fs: FsAdapter,
  action: () => Promise<T>,
  metadata: CaptureMetadata,
): Promise<T> {
  return withTentMutation(fs, action, metadata);
}
