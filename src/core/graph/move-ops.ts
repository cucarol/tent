// Node 移动保持稳定 ID；路径、链接与排序在同一次写入里改。

import { withTentMutation } from "../store/adapter.js";
import type { OpsEnv } from "./ops-context.js";
import { loadOrder, saveOrder, ROOT_KEY } from "../store/order.js";
import { validateNodeName } from "../store/scaffold.js";
import { applyNodeMove, planNodeMove } from "./rename-ops.js";
import { dirName, join, loadTent } from "../store/tree.js";

export interface MoveNodeResult {
  changed: boolean;
  id: string;
  oldPath: string;
  path: string;
  /** Full old→new path map for the moved subtree (root + descendants). */
  pathMap: Record<string, string>;
  rewrittenNotes: string[];
}

/**
 * Move a Node by stable `node-` to the end of a parent's children.
 * - `node-` / frontmatter id never change; folder stem (display name) is preserved
 * - new parent: move directory tree, rewrite path-based links
 * - same parent: order.json only — no link rewrite
 * - active Card consumption does not lock current Node structure; Git references retain their original context
 */
export function moveNode(
  env: OpsEnv,
  nodeId: string,
  newParentId: string | null,
): Promise<MoveNodeResult> {
  return withTentMutation(env.fs, () => moveNodeUnlocked(env, nodeId, newParentId), {
    operation: "node.move",
  });
}

async function moveNodeUnlocked(
  env: OpsEnv,
  nodeId: string,
  newParentId: string | null,
): Promise<MoveNodeResult> {
  const tent = await loadTent(env.fs);
  const moved = tent.byId.get(nodeId);
  if (!moved) throw new Error(`Node not found: ${nodeId}.`);
  const parentNode = newParentId === null ? undefined : tent.byId.get(newParentId);
  if (newParentId !== null && !parentNode)
    throw new Error(`Target parent not found: ${newParentId}.`);

  const newParentPath = parentNode ? parentNode.path : "";
  validateNodeName(moved.name, newParentPath);
  if (newParentPath === moved.path || newParentPath.startsWith(moved.path + "/")) {
    throw new Error("Cannot move a node into its own subtree.");
  }

  const oldPath = moved.path;
  const destination = join(newParentPath, moved.name);
  const parentKey = parentNode ? parentNode.id : ROOT_KEY;
  const current = (parentNode ? parentNode.children : tent.roots).map((node) => node.id);
  const siblings = [...current.filter((id) => id !== moved.id), moved.id];

  // Same parent: order only — no pathMap rewrite, no FS move.
  if (dirName(oldPath) === newParentPath) {
    const changed = current.some((id, index) => id !== siblings[index]);
    if (changed) {
      const order = await loadOrder(env.fs);
      order[parentKey] = siblings;
      await saveOrder(env.fs, order);
    }
    return {
      changed,
      id: moved.id,
      oldPath,
      path: oldPath,
      pathMap: { [oldPath]: oldPath },
      rewrittenNotes: [],
    };
  }

  if (await env.fs.exists(destination)) {
    throw new Error(`Move target already exists: ${destination}.`);
  }
  // Display name unchanged on reparent — path links rewrite; bare names stay.
  const plan = await planNodeMove(env.fs, tent, moved, destination, moved.name);
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;
  const order = await loadOrder(env.fs);
  if (order[oldParentKey])
    order[oldParentKey] = order[oldParentKey]!.filter((sid) => sid !== moved.id);
  order[parentKey] = siblings;
  await applyNodeMove(env.fs, oldPath, destination, plan.writes);
  await saveOrder(env.fs, order);

  return {
    changed: true,
    id: moved.id,
    oldPath,
    path: destination,
    pathMap: plan.pathMap,
    rewrittenNotes: plan.rewrittenNotes,
  };
}
