// Node 重命名保持稳定 ID；目录、身份文件与链接使用同一份中断恢复记录。

import { withTentMutation } from "../store/adapter.js";
import type { FsAdapter } from "../store/adapter.js";
import { parseFrontmatter, serializeFrontmatter, syncNodeTitle } from "../base/frontmatter.js";
import { buildNodeIndex, resolveNode, type OkfNode } from "../base/okf.js";
import { buildOkfNodeIndex } from "../base/okf-index.js";
import { normalizeTarget, resolveTargetPath } from "../base/link-target.js";
import { materialLocator, rewriteMaterialPaths } from "../base/material.js";
import { rewriteMarkdownDestinations } from "../base/links.js";
import {
  executeNodeMoveUnlocked,
  revertNodeMoveUnlocked,
  NODE_MOVE_PENDING_PATH,
  type NodeMoveWrite,
  type PendingMove,
} from "../store/node-move-recovery.js";
import type { OpsEnv } from "./ops-context.js";
import { isOperationalPath } from "../base/paths.js";
import { validateNodeName } from "../store/scaffold.js";
import type { Node } from "../base/types.js";
import {
  nodeNotePath,
  dirName,
  assertContentMutable,
  isContentMutable,
  join,
  loadTent,
  type LoadedTent,
} from "../store/tree.js";

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
 * - on post-move failure: settle the file transaction; legacy adapters prove HEAD before reversing
 */
export async function renameNode(
  env: OpsEnv,
  nodeIdOrPath: string,
  newNameRaw: string,
): Promise<RenameNodeResult> {
  let moved: CompletedMove | undefined;
  return withTentMutation(
    env.fs,
    async () =>
      renameNodeUnlocked(env, nodeIdOrPath, newNameRaw, async (plan) => {
        moved = { plan, head: await readHead(env.fs) };
      }),
    { operation: "node.rename" },
    // Durable transactions own recovery; legacy adapters retain their structural rollback.
    async (error) => {
      if (!moved) return;
      const { plan } = moved;
      const cause = message(error).replace(
        /^Tent files may already be saved, but history capture failed; reread before retrying: /,
        "history capture failed: ",
      );
      const settled = await env.fs.recoverFileTransaction?.().catch((recovery) => {
        throw new AggregateError(
          [error, recovery],
          `${cause}; recovery also failed: ${message(recovery)}`,
        );
      });
      if (settled !== undefined)
        throw new Error(
          `Node rename to ${plan.newPath} failed; its file transaction was settled against history publication.${settled.length ? ` External edits retained: ${settled.join(", ")}.` : ""} Cause: ${cause}`,
        );
      const published = await renamePublished(env.fs, moved);
      if (published)
        throw new Error(
          `Node rename to ${plan.newPath} is recorded in retained history and kept on disk, but finishing the history capture failed. Cause: ${cause}`,
        );
      if (published === undefined)
        throw new Error(
          `Node rename to ${plan.newPath} is kept on disk because Tent history could not show whether it was recorded; run workspace check before the next write. Cause: ${cause}`,
        );
      try {
        await revertNodeMoveUnlocked(env.fs, plan);
      } catch (rollback) {
        // exists() cannot tell a missing record from an unreadable one, so only a found record is claimed.
        const kept = await env.fs.exists(NODE_MOVE_PENDING_PATH).catch(() => false);
        throw new Error(
          `Node rename to ${plan.newPath} failed and could not be rolled back: ${message(rollback)}; ${kept ? "the recovery record is kept for the next write" : "Tent could not determine whether a recovery record was saved, so run workspace check before the next write"}. Cause: ${cause}`,
        );
      }
      throw new Error(
        `Node rename to ${plan.newPath} was rolled back; disk and Tent history keep ${plan.oldPath}. Cause: ${cause}`,
      );
    },
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

interface CompletedMove {
  plan: PendingMove;
  /** retained history read right after the move; undefined when it could not be read. */
  head: string | null | undefined;
}

async function readHead(fs: FsAdapter): Promise<string | null | undefined> {
  try {
    return fs.history ? await fs.history.currentCommit() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * false only when HEAD is the commit read after the move, so the capture published nothing;
 * true when HEAD records the renamed identity document; undefined when neither can be shown.
 */
async function renamePublished(
  fs: FsAdapter,
  { plan, head }: CompletedMove,
): Promise<boolean | undefined> {
  const current = await readHead(fs);
  if (current === undefined) return undefined;
  if (head !== undefined && current === head) return false;
  const identity = plan.writes.find((write) => write.originalPath === nodeNotePath(plan.oldPath));
  if (!current || !identity) return undefined;
  try {
    const retained = await fs.history!.read({ commit: current, path: identity.writePath });
    return retained === identity.newContent ? true : undefined;
  } catch {
    return undefined;
  }
}

async function renameNodeUnlocked(
  env: OpsEnv,
  nodeIdOrPath: string,
  newNameRaw: string,
  onMoved: (plan: PendingMove) => Promise<void>,
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
  await onMoved(
    await executeNodeMoveUnlocked(env.fs, {
      nodeId: target.id,
      oldPath,
      newPath,
      writes: plannedWrites,
    }),
  );

  // order.json is id-keyed — no path rewrite.

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
   * Note path used when restyling document-relative destinations after a tree move.
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
 * Document-relative links are resolved against `fromNotePath`, then restyled from
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
  let afterIndex: Map<string, OkfNode[]> | undefined;
  const postMoveIndex = opts
    ? () => (afterIndex ??= movedNodeIndex(opts.conceptIndex, pathMap))
    : undefined;
  const next = rewriteMarkdownDestinations(body, (url) => {
    if (isExternalOrAnchor(url)) return undefined;
    return mapLinkTarget(
      url,
      fromNotePath,
      pathMap,
      oldPaths,
      oldName,
      newName,
      opts,
      postMoveIndex,
    );
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
  postMoveIndex?: () => Map<string, OkfNode[]>,
): string | undefined {
  const { pathPart, tail } = splitDestTail(raw);
  if (!pathPart) return undefined;

  if (isUnqualifiedName(pathPart)) {
    return mapUnqualifiedName(pathPart, tail, oldName, newName, opts);
  }

  const restyleFrom = opts?.restyleFromNotePath ?? fromNotePath;
  const sourceMoved = restyleFrom.replace(/\\/g, "/") !== fromNotePath.replace(/\\/g, "/");
  let isRelativeForm = pathPart.startsWith("./") || pathPart.startsWith("../");
  let localNode: OkfNode | undefined;

  // Resolve against the pre-move note path (link text was authored there).
  let targetPath = resolveTargetPath(pathPart, fromNotePath);
  if (
    opts &&
    !isRelativeForm &&
    !pathPart.startsWith("/") &&
    !resolveIndexDocument(opts.conceptIndex, targetPath)
  ) {
    // Readers prefer a resolved Node root shorthand, then check the destination
    // as a document-relative file. Keep the same precedence during rewriting.
    try {
      const locator = materialLocator(pathPart, fromNotePath);
      if (locator.kind === "path" && locator.anchor === "document") {
        localNode = resolveIndexDocument(opts.conceptIndex, locator.target);
        if (localNode) {
          targetPath = locator.target;
          isRelativeForm = true;
        }
      }
    } catch {
      // Unsupported local destinations keep their original bytes.
    }
  }
  const normalized = targetPath.replace(/\.md$/i, "");
  const mapped =
    normalized === ".." || normalized.startsWith("../")
      ? undefined
      : resolveMappedPath(normalized, pathMap, oldPaths);
  const needsDisambiguation =
    localNode !== undefined &&
    postMoveIndex !== undefined &&
    resolveDocumentNode(postMoveIndex(), pathPart, restyleFrom)?.nodeId !== localNode.nodeId;

  // Absolute / multi-segment system-root paths only rewrite on pathMap hits.
  // Relative forms also restyle when the source note itself moved (depth/path change).
  // A new root alias may shadow a local Node even when neither endpoint moved.
  if (!mapped && !(isRelativeForm && sourceMoved) && !needsDisambiguation) {
    return undefined;
  }

  // A pathMap value is a Node stem; an unmapped material keeps its exact filename.
  const absTarget =
    mapped === undefined ? targetPath : /\.md$/i.test(targetPath) ? `${mapped}.md` : mapped;
  const styled = restyleRelative(
    pathPart,
    restyleFrom,
    absTarget,
    isRelativeForm,
    needsDisambiguation,
  );
  if (styled === pathPart) return undefined;
  return styled + tail;
}

/** Project the same Node identities and aliases at their planned write locations. */
function movedNodeIndex(
  before: Map<string, OkfNode[]>,
  pathMap: Map<string, string>,
): Map<string, OkfNode[]> {
  const nodes = new Map<string, OkfNode>();
  for (const matches of before.values()) {
    for (const node of matches) {
      if (nodes.has(node.nodeId)) continue;
      const nextPath = pathMap.get(node.path);
      const notePath = nextPath === undefined ? node.notePath : nodeNotePath(nextPath);
      nodes.set(
        node.nodeId,
        nextPath === undefined
          ? node
          : {
              ...node,
              path: nextPath,
              notePath,
              id: notePath.replace(/\.md$/i, ""),
              name: nextPath.slice(nextPath.lastIndexOf("/") + 1),
            },
      );
    }
  }
  return buildOkfNodeIndex(nodes.values());
}

/** Match the reader's index-first, then exact identity-document lookup. */
function resolveIndexDocument(index: Map<string, OkfNode[]>, target: string): OkfNode | undefined {
  return (
    resolveNode(index, target) ??
    index.get(target)?.find((node) => node.notePath === target) ??
    index.get(`${target}.md`)?.find((node) => node.notePath === `${target}.md`)
  );
}

function resolveDocumentNode(
  index: Map<string, OkfNode[]>,
  destination: string,
  owner: string,
): OkfNode | undefined {
  const direct = resolveIndexDocument(index, resolveTargetPath(destination, owner));
  if (direct) return direct;
  try {
    const locator = materialLocator(destination, owner);
    return locator.kind === "path" ? resolveIndexDocument(index, locator.target) : undefined;
  } catch {
    return undefined;
  }
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
  documentRelative: boolean,
  forceExplicitRelative: boolean,
): string {
  const orig = originalPathPart.replace(/\\/g, "/");
  const escape = (value: string) =>
    /%[\da-f]{2}/i.test(orig)
      ? value.split("/").map(encodeURIComponent).join("/")
      : value.replace(/[%?#]/g, (character) => encodeURIComponent(character));
  if (documentRelative) {
    const rel = relativeMarkdownPath(fromNotePath, absoluteNext);
    if (!orig.startsWith("./") && !orig.startsWith("../")) {
      // Keep an unchanged bare relative, but make a changed destination explicit:
      // its new spelling may collide with an existing root shorthand.
      const bare = rel.replace(/^\.\//, "");
      if (!forceExplicitRelative && resolveTargetPath(orig) === bare) return originalPathPart;
    }
    return escape(rel);
  }
  // Absolute-from-system-root style path
  const escaped = escape(absoluteNext);
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
