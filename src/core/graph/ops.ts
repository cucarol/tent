import {
  materialFields,
  validateMaterialAddresses,
  type MaterialFields,
} from "../base/material.js";
// Tent 状态动作的统一入口，供 CLI 与插件共同调用。

import { withTentMutation } from "../store/adapter.js";
import { loadTent, join, nodeNotePath, LoadedTent } from "../store/tree.js";
import { isNodeId, makeUniqueNodeId } from "../base/id.js";
import { NODE_FRONTMATTER_KEY_ORDER, serializeFrontmatter } from "../base/frontmatter.js";
import { loadOrder, saveOrder, ROOT_KEY } from "../store/order.js";
import { Node } from "../base/types.js";
import { normalizeTagList } from "../base/tags.js";
import { normalizeOptionalNodeType } from "../base/node-type.js";
import { validateNodeName } from "../store/scaffold.js";
import type { OpsEnv } from "./ops-context.js";
import { canonicalDocumentReferences } from "./document-links.js";
import { captureDocumentUnlocked } from "../store/document-history.js";
import { validateSystemMaterials } from "./material-target.js";

export type { OpsEnv } from "./ops-context.js";
export { renameNode, type RenameNodeResult } from "./rename-ops.js";
export { archiveNode } from "./node-lifecycle.js";
export { moveNode, type MoveNodeResult } from "./move-ops.js";

// ---- 结构编辑(建框/移动/改属性)----
// Node 文档与结构编辑。

export type NewNodeInput = MaterialFields & {
  id?: string;
  name: string;
  /** Validated as goal, prompt or output. */
  type: string;
  body?: string;
  description?: string;
  tags?: string[];
} & ({ parentPath: string; parentId?: never } | { parentId: string | null; parentPath?: never });

export async function createNode(env: OpsEnv, input: NewNodeInput): Promise<string> {
  return withTentMutation(env.fs, () => createNodeUnlocked(env, input), {
    operation: "node.create",
  });
}

async function createNodeUnlocked(env: OpsEnv, input: NewNodeInput): Promise<string> {
  const materials = materialFields(input as unknown as Record<string, unknown>);
  const tent = await loadTent(env.fs);
  // Resolve an identity under the same mutation lock as the creation, after any earlier writer.
  const parentPath =
    input.parentId === undefined
      ? input.parentPath
      : input.parentId === null
        ? ""
        : requireNodeById(tent, input.parentId).path;
  const name = validateNodeName(input.name, parentPath);
  const type = normalizeOptionalNodeType(input.type);
  const parent = parentPath ? tent.byPath.get(parentPath) : undefined;
  if (parentPath && (!parent || parent.invalid)) throw new Error("Target parent node is invalid.");
  const existing = new Set([...tent.byPath.values()].map((node) => node.id));
  const id = input.id ?? makeUniqueNodeId(existing, env.rand);
  if (!isNodeId(id)) throw new Error("Invalid Node id.");
  if (existing.has(id)) throw new Error(`Node id already exists: ${id}.`);
  const path = join(parentPath, name);
  // V0.1: every user Node writes an exact canonical type marker.
  const tags = input.tags === undefined ? [] : normalizeTagList(input.tags);
  const fm = {
    id,
    type,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(tags.length === 0 ? {} : { tags }),
    ...materials,
  };
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
  const content = serializeFrontmatter(fm, body, NODE_FRONTMATTER_KEY_ORDER);
  if (await env.fs.exists(path)) {
    const current = tent.byPath.get(path);
    throw new Error(
      current
        ? `A sibling Node already uses the name ${JSON.stringify(name)}: ${current.id}.`
        : `Node path already exists: ${path}.`,
    );
  }
  await env.fs.writeFile(notePath, content);
  const parentKey = parent ? parent.id : ROOT_KEY;
  const order = await loadOrder(env.fs);
  order[parentKey] = [...(order[parentKey] ?? []), id];
  await saveOrder(env.fs, order);
  await captureDocumentUnlocked(env.fs, notePath, content, { operation: "node.create" });
  return id;
}

export async function deleteNode(
  env: OpsEnv,
  nodeId: string,
): Promise<{ nodeId: string; path: string }> {
  return withTentMutation(
    env.fs,
    async () => {
      const tent = await loadTent(env.fs);
      const node = requireNodeById(tent, nodeId);

      const removedIds = collectSubtreeIds(node);
      const order = await loadOrder(env.fs);
      for (const key of Object.keys(order)) {
        if (removedIds.has(key)) delete order[key];
        else order[key] = order[key].filter((id) => !removedIds.has(id));
      }
      await env.fs.remove(node.path);
      await saveOrder(env.fs, order);
      return { nodeId, path: node.path };
    },
    { operation: "node.delete" },
  );
}

// ---- 内部工具 ----

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
