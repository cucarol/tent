// Node 重命名保持稳定 ID；目录、身份文件与链接使用同一份中断恢复记录。

import { withTentMutation } from "./adapter.js";
import type { FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter, syncNodeTitle } from "./frontmatter.js";
import { buildNodeIndex, resolveNode, type OkfNode } from "./okf.js";
import { normalizeTarget, resolveTargetPath } from "./link-target.js";
import { rewriteMaterialPaths } from "./material.js";
import { rewriteMarkdownDestinations } from "../markdown/links.js";
import { executeNodeMoveUnlocked, type NodeMoveWrite } from "./node-move-recovery.js";
import type { OpsEnv } from "./ops-context.js";
import { isOperationalPath } from "./paths.js";
import { validateNodeName } from "./scaffold.js";
import type { Node } from "./types.js";
import {
  nodeNotePath,
  dirName,
  assertContentMutable,
  isContentMutable,
  join,
  loadTent,
  type LoadedTent,
} from "./tree.js";

export interface RenameNodeResult {
  id: string;
  oldPath: string;
  path: string;
  name: string;
  /** Full old→new path map for the moved subtree (root + descendants). */
  pathMap: Record<string, string>;
  rewrittenNotes: string[];
}

/**
 * Rename a Node folder (and its same-named identity note).
 * - `node-` / frontmatter id never change
 * - entire directory tree moves; child relative structure preserved
 * - path-based Markdown links rewritten in the same mutation
 * - unqualified name targets rewrite only when Tent resolution uniquely hits this node
 * - refuses target collision, illegal names, operational paths
 * - on post-move failure: restore every touched note + tree
 */
export async function renameNode(
  env: OpsEnv,
  nodeIdOrPath: string,
  newNameRaw: string,
): Promise<RenameNodeResult> {
  return withTentMutation(env.fs, async () => renameNodeUnlocked(env, nodeIdOrPath, newNameRaw), {
    operation: "node.rename",
  });
}

async function renameNodeUnlocked(
  env: OpsEnv,
  nodeIdOrPath: string,
  newNameRaw: string,
): Promise<RenameNodeResult> {
  const tent = await loadTent(env.fs);
  const target = resolveRenameTarget(tent, nodeIdOrPath);
  const newName = validateNodeName(newNameRaw, dirName(target.path));
  if (!isContentMutable(target)) {
    throw new Error("Invalid nodes cannot be renamed.");
  }
  assertContentMutable(target, "renamed");
  if (target.invalid) {
    throw new Error("Invalid nodes cannot be renamed.");
  }
  const oldPath = target.path;
  const oldName = target.name;
  if (newName === oldName) {
    return {
      id: target.id,
      oldPath,
      path: oldPath,
      name: oldName,
      pathMap: { [oldPath]: oldPath },
      rewrittenNotes: [],
    };
  }

  const parentPath = dirName(oldPath);
  const newPath = join(parentPath, newName);
  assertNotOperationalPath(oldPath);
  assertNotOperationalPath(newPath);
  if (newPath !== oldPath && (await env.fs.exists(newPath))) {
    throw new Error(`Rename target already exists: ${newPath}.`);
  }
  const siblings = target.parent ? target.parent.children : tent.roots;
  if (siblings.some((node) => node.id !== target.id && node.name === newName)) {
    throw new Error(`A sibling Node already uses the name: ${newName}.`);
  }

  const subtree = collectSubtree(target);
  const pathMap = new Map<string, string>();
  const materialMoves = new Map<string, string>();
  for (const node of subtree) {
    const rel = relativePath(oldPath, node.path);
    const nextNodePath = rel ? join(newPath, rel) : newPath;
    // Node path (folder) and identity-note path stem (folder/Name) both appear in links.
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
    renameNodeId: target.id,
    conceptIndex,
  };

  // Plan rewrites: resolve from pre-move note path; restyle relatives from post-move path when moved.
  const plannedWrites: NodeMoveWrite[] = [];
  const rewrittenNotes: string[] = [];
  for (const node of tent.byPath.values()) {
    const notePath = nodeNotePath(node.path);
    if (!(await env.fs.exists(notePath))) continue;
    const raw = await env.fs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (typeof data.id === "string" && data.id !== node.id) {
      throw new Error(`Refuse rename: frontmatter id drift on ${node.path}.`);
    }
    const afterNodePath = pathMap.get(node.path) ?? node.path;
    const restyleFromNotePath = nodeNotePath(afterNodePath);
    const rewritten = rewriteNodeLinks(body, notePath, pathMap, oldName, newName, {
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
      oldName,
      newName,
      rewriteOpts,
      materialMoves,
    )),
  );
  await executeNodeMoveUnlocked(env.fs, {
    nodeId: target.id,
    oldPath,
    newPath,
    writes: plannedWrites,
  });

  // order.json is id-keyed — no path rewrite. Attachments are node-keyed and stay put.

  const pathMapRecord: Record<string, string> = {};
  for (const [from, to] of pathMap) pathMapRecord[from] = to;

  return {
    id: target.id,
    oldPath,
    path: newPath,
    name: newName,
    pathMap: pathMapRecord,
    rewrittenNotes: rewrittenNotes.sort(),
  };
}

function resolveRenameTarget(tent: LoadedTent, nodeIdOrPath: string): Node {
  const key = nodeIdOrPath.trim().replace(/\\/g, "/");
  const byId = tent.byId.get(key);
  if (byId) return byId;
  const byPath = tent.byPath.get(key);
  if (byPath) return byPath;
  throw new Error(`Node not found: ${nodeIdOrPath}.`);
}

function assertNotOperationalPath(path: string): void {
  if (isOperationalPath(path) || path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ and other system pipelines cannot be renamed as Nodes.");
  }
  const top = path.split("/")[0] ?? "";
  if (top === "attachments" || top === ".tent") {
    throw new Error("System directories cannot be renamed as Nodes.");
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

export type RewriteNodeLinksOptions = {
  /** Immutable node- of the node being renamed/moved. */
  renameNodeId: string;
  /** Pre-rename concept index (name resolution uses Tent's unique-match rules). */
  conceptIndex: Map<string, OkfNode[]>;
  /**
   * Note path used when restyling `./` and `../` destinations after a tree move.
   * Resolve still uses `fromNotePath` (pre-move disk location). When the note itself
   * moves, pass the post-move note path so relatives stay valid at the write location.
   * Defaults to `fromNotePath`.
   */
  restyleFromNotePath?: string;
};

export async function rewriteRoleAndNoteLinks(
  fs: FsAdapter,
  pathMap: Map<string, string>,
  oldName: string,
  newName: string,
  opts: RewriteNodeLinksOptions,
  materialMoves: ReadonlyMap<string, string>,
): Promise<NodeMoveWrite[]> {
  const writes: NodeMoveWrite[] = [];
  for (const dir of ["roles"]) {
    if (!(await fs.exists(dir))) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = `${dir}/${entry.name}`;
      const raw = await fs.readFile(path);
      const { data, body, keyOrder } = parseFrontmatter(raw);
      const rewritten = rewriteNodeLinks(body, path, pathMap, oldName, newName, opts);
      const materialsChanged = rewriteMaterialPaths(data, path, path, materialMoves);
      if (rewritten.changed || materialsChanged)
        writes.push({
          originalPath: path,
          writePath: path,
          originalContent: raw,
          newContent: serializeFrontmatter(data, rewritten.body, keyOrder),
        });
    }
  }
  return writes;
}

/**
 * Rewrite Markdown destinations that targeted a moved path.
 * Unqualified name targets rewrite only when resolution uniquely targets the renamed node.
 *
 * Relative (`./` / `../`) links are resolved against `fromNotePath`, then restyled from
 * `opts.restyleFromNotePath` (post-move when the source note moves). Outbound relatives to
 * unmoved targets are restyled when source depth/path changes even if the target is outside pathMap.
 */
export function rewriteNodeLinks(
  body: string,
  fromNotePath: string,
  pathMap: Map<string, string>,
  oldName: string,
  newName: string,
  opts?: RewriteNodeLinksOptions,
): { body: string; changed: boolean } {
  if (pathMap.size === 0) return { body, changed: false };
  const oldPaths = [...pathMap.keys()].sort((a, b) => b.length - a.length);
  const next = rewriteMarkdownDestinations(body, (url) => {
    if (isExternalOrAnchor(url)) return undefined;
    return mapLinkTarget(url, fromNotePath, pathMap, oldPaths, oldName, newName, opts);
  });
  return { body: next, changed: next !== body };
}

/**
 * Map a link destination to its post-move/rename form.
 * - Path-like targets: resolve against pre-move fromNotePath; apply pathMap; restyle from restyleFromNotePath.
 * - Relative links with a moved source: restyle even when the absolute target is outside pathMap.
 * - Unqualified bare names: rewrite only when Tent resolveNode uniquely hits renameNodeId.
 */
function mapLinkTarget(
  raw: string,
  fromNotePath: string,
  pathMap: Map<string, string>,
  oldPaths: string[],
  oldName: string,
  newName: string,
  opts?: RewriteNodeLinksOptions,
): string | undefined {
  const { pathPart, tail } = splitDestTail(raw);
  if (!pathPart) return undefined;

  if (isUnqualifiedName(pathPart)) {
    return mapUnqualifiedName(pathPart, tail, oldName, newName, opts);
  }

  const restyleFrom = opts?.restyleFromNotePath ?? fromNotePath;
  const sourceMoved = restyleFrom.replace(/\\/g, "/") !== fromNotePath.replace(/\\/g, "/");
  const isRelativeForm = pathPart.startsWith("./") || pathPart.startsWith("../");

  // Resolve against the pre-move note path (link text was authored there).
  const targetPath = resolveTargetPath(pathPart, fromNotePath);
  const normalized = targetPath.replace(/\.md$/i, "");
  const mapped =
    normalized === ".." || normalized.startsWith("../")
      ? undefined
      : resolveMappedPath(normalized, pathMap, oldPaths);

  // Absolute / multi-segment system-root paths only rewrite on pathMap hits.
  // Relative forms also restyle when the source note itself moved (depth/path change).
  if (!mapped && !(isRelativeForm && sourceMoved)) {
    return undefined;
  }

  // A pathMap value is a Node stem; an unmapped material keeps its exact filename.
  const absTarget =
    mapped === undefined ? targetPath : /\.md$/i.test(targetPath) ? `${mapped}.md` : mapped;
  const styled = restyleRelative(pathPart, restyleFrom, absTarget);
  if (styled === pathPart) return undefined;
  return styled + tail;
}

function mapUnqualifiedName(
  pathPart: string,
  tail: string,
  oldName: string,
  newName: string,
  opts?: RewriteNodeLinksOptions,
): string | undefined {
  if (!opts || oldName === newName) return undefined;
  const bare = pathPart.replace(/\.md$/i, "");
  const resolved = resolveNode(opts.conceptIndex, bare);
  if (!resolved || resolved.nodeId !== opts.renameNodeId) return undefined;
  // Stable identity is already independent of the renamed display name/path.
  if (normalizeTarget(pathPart) === resolved.nodeId) return undefined;

  const sourceHadMd = /\.md$/i.test(pathPart);
  // Authors used a bare name form; keep bare name form with the new display name.
  // Only rewrite when the resolved target is uniquely this node (resolveNode guarantee).
  return (sourceHadMd ? `${newName}.md` : newName) + tail;
}

function resolveMappedPath(
  normalized: string,
  pathMap: Map<string, string>,
  oldPaths: string[],
): string | undefined {
  const clean = normalized.replace(/\\/g, "/").replace(/^\.\//, "");
  if (pathMap.has(clean)) return pathMap.get(clean);
  const noMd = clean.replace(/\.md$/i, "");
  if (pathMap.has(noMd)) return pathMap.get(noMd);
  for (const oldPath of oldPaths) {
    if (clean === oldPath || noMd === oldPath || clean === `${oldPath}.md`) {
      return pathMap.get(oldPath);
    }
  }
  return undefined;
}

function isUnqualifiedName(raw: string): boolean {
  const t = raw.trim().replace(/\\/g, "/");
  if (!t || t.includes("/") || t.startsWith(".")) return false;
  return true;
}

function splitDestTail(dest: string): { pathPart: string; tail: string } {
  const t = dest.trim();
  const hash = t.indexOf("#");
  const query = t.indexOf("?");
  let cut = -1;
  if (hash >= 0 && query >= 0) cut = Math.min(hash, query);
  else if (hash >= 0) cut = hash;
  else if (query >= 0) cut = query;
  if (cut < 0) return { pathPart: t, tail: "" };
  return { pathPart: t.slice(0, cut), tail: t.slice(cut) };
}

function isExternalOrAnchor(dest: string): boolean {
  const t = dest.trim();
  if (!t || t.startsWith("#")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(t);
}

function restyleRelative(
  originalPathPart: string,
  fromNotePath: string,
  absoluteNext: string,
): string {
  const orig = originalPathPart.replace(/\\/g, "/");
  if (orig.startsWith("./") || orig.startsWith("../")) {
    const rel = relativeMarkdownPath(fromNotePath, absoluteNext);
    return rel.replace(/[%?#]/g, (character) => encodeURIComponent(character));
  }
  // Absolute-from-system-root style path
  const escaped = absoluteNext.replace(/[%?#]/g, (character) => encodeURIComponent(character));
  return orig.startsWith("/") ? `/${escaped}` : escaped;
}

function relativeMarkdownPath(fromNotePath: string, toNotePath: string): string {
  const fromParts = dirName(fromNotePath).split("/").filter(Boolean);
  const toParts = toNotePath.split("/").filter(Boolean);
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  const up = fromParts.map(() => "..");
  const rel = [...up, ...toParts].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}
