import { materialFields, validateMaterialAddresses, type MaterialFields } from "./material.js";
// Tent 状态动作的统一入口，供 CLI 与插件共同调用。

import { FsAdapter, withTentMutation } from "./adapter.js";
import { loadTent, join, nodeNotePath, LoadedTent } from "./tree.js";
import { isNodeId, makeUniqueNodeId } from "./id.js";
import { NODE_FRONTMATTER_KEY_ORDER, serializeFrontmatter } from "./frontmatter.js";
import { loadOrder, saveOrder, ROOT_KEY } from "./order.js";
import { Node, NodeType } from "./types.js";
import { assertContentMutable, isContentMutable } from "./tree.js";
import { normalizeTagList } from "./tags.js";
import { normalizeOptionalNodeType } from "./node-type.js";
import { validateNodeName } from "./scaffold.js";
import { moveNodeUnlocked } from "./move-ops.js";
import type { OpsEnv } from "./ops-context.js";
import { ORDER_PATH } from "./paths.js";
import { executeDeleteUnlocked, type DeleteWrite } from "./delete-recovery.js";
import { canonicalDocumentReferences } from "./document-links.js";
import type { CaptureMetadata } from "./git-history.js";
import { prepareNodeSyncSave } from "./node-sync-record.js";
import { prepareNodeProvenanceSave } from "./node-provenance.js";
import { captureDocumentUnlocked } from "./document-history.js";

export type { OpsEnv } from "./ops-context.js";
export { renameNode, type RenameNodeResult } from "./rename-ops.js";
export { archiveNode, restoreNode } from "./node-lifecycle.js";
export { moveNode, type MoveNodeResult, type MovePosition } from "./move-ops.js";

// ---- 结构编辑(建框/移动/改属性)----
// Node 文档与结构编辑。

export interface NewNodeInput extends MaterialFields {
  parentPath: string; // "" = 顶层
  name: string;
  type: NodeType;
  body?: string;
  tags?: string[];
  by?: string;
}

export async function createNode(env: OpsEnv, input: NewNodeInput): Promise<string> {
  return withMutation(env.fs, async () => createNodeUnlocked(env, input), {
    operation: "node.create",
  });
}

export async function createNodeUnlocked(env: OpsEnv, input: NewNodeInput): Promise<string> {
  const materials = materialFields(input as unknown as Record<string, unknown>);
  assertNotTempPath(input.parentPath);
  const name = validateNodeName(input.name, input.parentPath);
  const tent = await loadTent(env.fs);
  const type = normalizeOptionalNodeType(input.type);
  if (input.parentPath) {
    const parent = tent.byPath.get(input.parentPath);
    if (!parent || !isContentMutable(parent)) throw new Error("Target parent node is invalid.");
    assertContentMutable(parent, "used as create parent");
  }
  const existing = new Set([...tent.byPath.values()].map((node) => node.id));
  const id = makeUniqueNodeId(existing, env.rand);
  if (!isNodeId(id)) throw new Error("Invalid Node id.");
  if (tent.duplicateIds.has(id)) throw new Error(`Duplicate Node id: ${id}.`);
  const path = join(input.parentPath, name);
  assertNotTempPath(path);
  // V0.1: every user Node writes an exact canonical type marker.
  const tags = input.tags === undefined ? [] : normalizeTagList(input.tags);
  const fm = { id, type, ...(tags.length === 0 ? {} : { tags }), ...materials };
  const notePath = nodeNotePath(path);
  validateMaterialAddresses(fm, notePath);
  const body = await canonicalDocumentReferences(env.fs, notePath, fm, input.body ?? "");
  const content = prepareNodeProvenanceSave(
    serializeFrontmatter(fm, body, NODE_FRONTMATTER_KEY_ORDER),
    null,
    input.by,
    env.clock.now(),
  );
  if (await env.fs.exists(path)) {
    throw new Error(`Node path already exists: ${path}.`);
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
    const parent = input.parentPath ? tent.byPath.get(input.parentPath) : undefined;
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

/** 落点:成为某框子框(inside)/ 插到某兄弟之前(before)/ 之后(after)。 */
export type DropPosition =
  { mode: "inside" } | { mode: "before"; siblingId: string } | { mode: "after"; siblingId: string };

// 统一的换爹 + 换序:把 fromPath 放到 newParentPath 下的指定位置。
// 顺序记进隐藏的 .tent/order.json(对 user 不显式),不碰任何框身份文件 frontmatter。
export async function placeNode(
  env: OpsEnv,
  fromPath: string,
  newParentPath: string,
  position: DropPosition,
): Promise<void> {
  await withMutation(
    env.fs,
    async () => placeNodeUnlocked(env, fromPath, newParentPath, position),
    { operation: "node.move" },
  );
}

async function placeNodeUnlocked(
  env: OpsEnv,
  fromPath: string,
  newParentPath: string,
  position: DropPosition,
): Promise<void> {
  assertNotTempPath(newParentPath);
  const before = await loadTent(env.fs);
  const moved = before.byPath.get(fromPath);
  if (!moved) throw new Error(`Node not found: ${fromPath}.`);
  if (!isContentMutable(moved)) throw new Error("Invalid nodes cannot be moved.");
  assertContentMutable(moved, "moved");
  const parent = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && !parent) throw new Error("Target parent node is invalid.");
  const siblings = parent ? parent.children : before.roots;
  const effectivePosition =
    position.mode !== "inside" &&
    !siblings.some((node) => node.id !== moved.id && node.id === position.siblingId)
      ? { mode: "inside" as const }
      : position;
  await moveNodeUnlocked(env, moved.id, parent?.id ?? null, effectivePosition);
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
