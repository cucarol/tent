// Node 移动保持稳定 ID；路径、链接与排序的中断恢复由专用记录保护。

import { withTentMutation } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter, syncNodeTitle } from "./frontmatter.js";
import { buildNodeIndex } from "./okf.js";
import { rewriteMaterialPaths } from "./material.js";
import { executeNodeMoveUnlocked, type NodeMoveWrite } from "./node-move-recovery.js";
import type { OpsEnv } from "./ops-context.js";
import { loadOrder, saveOrder, ROOT_KEY, ORDER_PATH } from "./order.js";
import { isOperationalPath } from "./paths.js";
import { validateNodeName } from "./scaffold.js";
import {
  rewriteNodeLinks,
  rewriteRoleAndNoteLinks,
  type RewriteNodeLinksOptions,
} from "./rename-ops.js";
import type { Node } from "./types.js";
import {
  nodeNotePath,
  baseName,
  dirName,
  assertContentMutable,
  isContentMutable,
  join,
  loadTent,
  type LoadedTent,
} from "./tree.js";

/** Drop position: become child of target (inside) or insert before/after a sibling. */
export type MovePosition =
  { mode: "inside" } | { mode: "before"; siblingId: string } | { mode: "after"; siblingId: string };

export interface MoveNodeResult {
  changed: boolean;
  id: string;
  oldPath: string;
  path: string;
  /** Full old→new path map for the moved subtree (root + descendants). Identity map when reorder-only. */
  pathMap: Record<string, string>;
  rewrittenNotes: string[];
}

/**
 * Move or reorder a Node by stable `node-`.
 * - `node-` / frontmatter id never change; folder stem (display name) is preserved
 * - reparent: move directory tree, rewrite path-based links, roll back on failure
 * - same-parent reorder: order.json only — no link rewrite
 * - active Card consumption does not lock current Node structure; Git references retain their original context
 */
export async function moveNode(
  env: OpsEnv,
  nodeId: string,
  newParentId: string | null,
  position: MovePosition,
  expectedPath?: string,
): Promise<MoveNodeResult> {
  return withTentMutation(
    env.fs,
    async () => moveNodeUnlocked(env, nodeId, newParentId, position, expectedPath),
    { operation: "node.move" },
  );
}

// 兼容路径入口 placeNode 复用此实现；调用者必须已持有 Workspace 写锁。
export async function moveNodeUnlocked(
  env: OpsEnv,
  nodeId: string,
  newParentId: string | null,
  position: MovePosition,
  expectedPath?: string,
): Promise<MoveNodeResult> {
  const id = nodeId.trim();
  if (!id) throw new Error("Node id is required for move.");

  const tent = await loadTent(env.fs);
  const moved = tent.byId.get(id);
  if (!moved) throw new Error(`Node not found: ${id}.`);
  if (expectedPath !== undefined && moved.path !== expectedPath)
    throw new Error("Node path changed; reread before moving");
  if (!isContentMutable(moved)) throw new Error("Invalid nodes cannot be moved.");
  assertContentMutable(moved, "moved");
  if (moved.invalid) {
    throw new Error("Invalid nodes cannot be moved.");
  }
  assertNotOperationalPath(moved.path);

  const parentNode = resolveNewParent(tent, newParentId);
  if (parentNode) {
    if (!isContentMutable(parentNode)) throw new Error("Target parent node is invalid.");
    assertContentMutable(parentNode, "used as move parent");
    assertNotOperationalPath(parentNode.path);
  }

  const newParentPath = parentNode ? parentNode.path : "";
  validateNodeName(baseName(moved.path), newParentPath);
  if (newParentPath === moved.path || newParentPath.startsWith(moved.path + "/")) {
    throw new Error("Cannot move a node into its own subtree.");
  }

  // Validate before/after sibling belongs under the destination parent.
  if (position.mode !== "inside") {
    const sibling = tent.byId.get(position.siblingId);
    if (!sibling) throw new Error(`Sibling not found: ${position.siblingId}.`);
    const siblingParentId = sibling.parent ? sibling.parent.id : null;
    const destParentId = parentNode ? parentNode.id : null;
    if (siblingParentId !== destParentId) {
      throw new Error("before/after sibling must be under the destination parent.");
    }
    if (sibling.id === moved.id) {
      throw new Error("Cannot position a node relative to itself.");
    }
  }

  const oldPath = moved.path;
  const movedName = baseName(moved.path);
  const destination = join(newParentPath, movedName);
  const parentChanged = dirName(oldPath) !== newParentPath;

  if (parentChanged) {
    if (await env.fs.exists(destination)) {
      throw new Error(`Move target already exists: ${destination}.`);
    }
    // Name collision among destination siblings (tree may lag FS in edge cases).
    const destSiblings = parentNode ? parentNode.children : tent.roots;
    if (destSiblings.some((node) => node.id !== moved.id && baseName(node.path) === movedName)) {
      throw new Error(`A sibling Node already uses the name: ${movedName}.`);
    }
  }

  const parentKey = parentNode ? parentNode.id : ROOT_KEY;
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;

  const currentSiblings = (parentNode ? parentNode.children : tent.roots).map((node) => node.id);
  const siblings = (parentNode ? parentNode.children : tent.roots)
    .filter((b) => b.id !== moved.id)
    .map((b) => b.id);

  let insertAt: number;
  if (position.mode === "inside") {
    insertAt = siblings.length;
  } else {
    const idx = siblings.indexOf(position.siblingId);
    insertAt = idx === -1 ? siblings.length : position.mode === "before" ? idx : idx + 1;
  }
  siblings.splice(insertAt, 0, moved.id);

  // Same-parent reorder: order only — no pathMap rewrite, no FS move.
  if (!parentChanged) {
    const changed = currentSiblings.some((id, index) => id !== siblings[index]);
    if (changed) {
      const order = await loadOrder(env.fs);
      order[parentKey] = siblings;
      await saveOrder(env.fs, order);
    }
    const identityMap: Record<string, string> = {};
    for (const node of collectSubtree(moved)) {
      identityMap[node.path] = node.path;
      identityMap[nodeNotePath(node.path).replace(/\.md$/i, "")] = nodeNotePath(node.path).replace(
        /\.md$/i,
        "",
      );
    }
    return {
      changed,
      id: moved.id,
      oldPath,
      path: oldPath,
      pathMap: identityMap,
      rewrittenNotes: [],
    };
  }

  // ---- Reparent: pathMap + link rewrite + FS move + order + rollback ----
  const subtree = collectSubtree(moved);
  const pathMap = new Map<string, string>();
  const materialMoves = new Map<string, string>();
  for (const node of subtree) {
    const rel = relativePath(oldPath, node.path);
    const nextNodePath = rel ? join(destination, rel) : destination;
    pathMap.set(node.path, nextNodePath);
    materialMoves.set(node.path, nextNodePath);
    materialMoves.set(nodeNotePath(node.path), nodeNotePath(nextNodePath));
    pathMap.set(
      nodeNotePath(node.path).replace(/\.md$/i, ""),
      nodeNotePath(nextNodePath).replace(/\.md$/i, ""),
    );
  }

  const conceptIndex = buildNodeIndex(tent.byPath.values());
  const rewriteOpts: RewriteNodeLinksOptions = {
    renameNodeId: moved.id,
    conceptIndex,
  };

  // Display name unchanged on reparent — path links rewrite; bare names stay.
  // Resolve relatives against pre-move note path; restyle from post-move path so depth changes stay valid.
  const plannedWrites: NodeMoveWrite[] = [];
  const rewrittenNotes: string[] = [];
  for (const node of tent.byPath.values()) {
    const notePath = nodeNotePath(node.path);
    if (!(await env.fs.exists(notePath))) continue;
    const raw = await env.fs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (typeof data.id === "string" && data.id !== node.id) {
      throw new Error(`Refuse move: frontmatter id drift on ${node.path}.`);
    }
    const afterNodePath = pathMap.get(node.path) ?? node.path;
    const restyleFromNotePath = nodeNotePath(afterNodePath);
    const rewritten = rewriteNodeLinks(body, notePath, pathMap, moved.name, moved.name, {
      ...rewriteOpts,
      restyleFromNotePath,
    });
    const materialsChanged = rewriteMaterialPaths(
      data,
      notePath,
      restyleFromNotePath,
      materialMoves,
    );
    if (!rewritten.changed && !materialsChanged && !pathMap.has(node.path)) continue;
    syncNodeTitle(data, afterNodePath);
    const nextRaw = serializeFrontmatter(data, rewritten.body, keyOrder);
    if (nextRaw === raw) continue;
    plannedWrites.push({
      writePath: restyleFromNotePath,
      originalPath: notePath,
      originalContent: raw,
      newContent: nextRaw,
    });
    rewrittenNotes.push(afterNodePath);
  }

  plannedWrites.push(
    ...(await rewriteRoleAndNoteLinks(
      env.fs,
      pathMap,
      moved.name,
      moved.name,
      rewriteOpts,
      materialMoves,
    )),
  );
  const orderBefore = await loadOrder(env.fs);
  const orderContent = (await env.fs.exists(ORDER_PATH)) ? await env.fs.readFile(ORDER_PATH) : null;
  if (JSON.stringify(JSON.parse(orderContent ?? "{}")) !== JSON.stringify(orderBefore))
    throw new Error("Order changed while planning Node move.");
  if (orderBefore[oldParentKey])
    orderBefore[oldParentKey] = orderBefore[oldParentKey]!.filter((sid) => sid !== moved.id);
  orderBefore[parentKey] = siblings;
  plannedWrites.push({
    originalPath: ORDER_PATH,
    writePath: ORDER_PATH,
    originalContent: orderContent,
    newContent: JSON.stringify(orderBefore, null, 2) + "\n",
  });
  await executeNodeMoveUnlocked(env.fs, {
    nodeId: moved.id,
    oldPath,
    newPath: destination,
    writes: plannedWrites,
  });

  const pathMapRecord: Record<string, string> = {};
  for (const [from, to] of pathMap) pathMapRecord[from] = to;

  return {
    changed: true,
    id: moved.id,
    oldPath,
    path: destination,
    pathMap: pathMapRecord,
    rewrittenNotes: rewrittenNotes.sort(),
  };
}

function resolveNewParent(tent: LoadedTent, newParentId: string | null): Node | null {
  if (newParentId === null || newParentId === undefined || newParentId === "") {
    return null;
  }
  const parent = tent.byId.get(newParentId.trim());
  if (!parent) throw new Error(`Target parent not found: ${newParentId}.`);
  return parent;
}

function assertNotOperationalPath(path: string): void {
  if (isOperationalPath(path) || path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ and other system pipelines cannot be moved as Nodes.");
  }
  const top = path.split("/")[0] ?? "";
  if (top === "attachments" || top === ".tent") {
    throw new Error("System directories cannot be moved as Nodes.");
  }
}

function collectSubtree(node: Node, out: Node[] = []): Node[] {
  out.push(node);
  for (const child of node.children) collectSubtree(child, out);
  return out;
}

function relativePath(root: string, child: string): string {
  if (child === root) return "";
  return child.slice(root.length + 1);
}
