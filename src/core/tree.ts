import { materialFields } from "./material.js";
import { documentLifecycle } from "./document-status.js";
// 加载帐 → Node 树 → 文档生命周期与 identity validity。
// operational pipeline（temp/ 等）永不进入 Node 索引。

import { FsAdapter } from "./adapter.js";
import { Node, NodeFrontmatter } from "./types.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadOrder, sortByOrder, OrderMap, ROOT_KEY } from "./order.js";
import { normalizeOptionalNodeType } from "./node-type.js";
import {
  isOperationalPath,
  isSystemNoteName,
  nodeNotePath,
  OPERATIONAL_TOP_LEVEL,
} from "./paths.js";
import { isNodeId } from "./id.js";
import { contentEtag } from "./etag.js";
import { assertCurrentLayout } from "./retired-layout.js";

export { nodeNotePath } from "./paths.js";

export interface LoadedTent {
  /** 顶层 Node，order.json 优先，缺省按稳定名称排序。temp 等 operational 不在树内。 */
  roots: Node[];
  /** id → Node 索引（仅 user-facing Nodes）。 */
  byId: Map<string, Node>;
  /** path → Node 索引。 */
  byPath: Map<string, Node>;
  duplicateIds: Set<string>;
}

export async function loadTent(fs: FsAdapter): Promise<LoadedTent> {
  const byId = new Map<string, Node>();
  const byPath = new Map<string, Node>();
  const roots: Node[] = [];
  const top = await fs.listDir("");
  await assertCurrentLayout(
    fs,
    top.filter((entry) => entry.isDir).map((entry) => entry.name),
  );
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (isOperationalPath(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadNodeInto(fs, entry.name, null, roots);
  }

  // 排序:隐藏 order 表优先;缺省时根与子框均按稳定名称排序
  const order = await loadOrder(fs);
  const sortedRoots = sortByOrder(roots, order[ROOT_KEY], compareNodes);
  for (const root of sortedRoots) sortChildren(root, order);

  // 解析隔离状态 + 建索引
  for (const root of sortedRoots) resolveSubtree(root);
  const duplicateIds = findDuplicateIds(sortedRoots);
  for (const root of sortedRoots) applyDuplicateInvalid(root, duplicateIds);
  for (const root of sortedRoots) indexSubtree(root, byId, byPath, duplicateIds);

  return { roots: sortedRoots, byId, byPath, duplicateIds };
}

function findDuplicateIds(roots: Node[]): Set<string> {
  const counts = new Map<string, number>();
  const visit = (node: Node) => {
    if (node.id) counts.set(node.id, (counts.get(node.id) || 0) + 1);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function applyDuplicateInvalid(
  node: Node,
  duplicateIds: Set<string>,
  inherited?: { rootId: string; reason: string },
): void {
  const direct = duplicateIds.has(node.id)
    ? {
        rootId: node.id,
        reason: `Duplicate id: ${node.id}; independent Nodes must have unique ids.`,
      }
    : undefined;
  const invalid = inherited || direct;
  if (invalid) {
    node.invalid = true;
    node.invalidRootId = invalid.rootId;
    node.invalidReason = invalid.reason;
  }
  for (const child of node.children) applyDuplicateInvalid(child, duplicateIds, invalid);
}

/** 单框内容落盘后的增量重载。结构与 id 不变时避免重扫整顶帐。 */
export async function reloadLoadedNode(
  fs: FsAdapter,
  tent: LoadedTent,
  path: string,
): Promise<Node> {
  const node = tent.byPath.get(path);
  if (!node) throw new Error(`Node not found: ${path}.`);
  const raw = await fs.readFile(nodeNotePath(path));
  const { data, body } = parseFrontmatter(raw);
  const schemaError = canonicalIdentityError(data);
  if (schemaError) throw new Error(schemaError);
  const identity = normalizeIdentity(data);
  if (identity.fm.id !== node.id) throw new Error("Incremental reload cannot change node id.");
  node.type = identity.fm.type;
  node.tags = identity.tags;
  node.fm = identity.fm;
  node.name = baseName(path);
  node.etag = contentEtag(raw);
  node.body = body;
  for (const root of tent.roots) resolveSubtree(root);
  return node;
}

function sortChildren(node: Node, order: OrderMap): void {
  node.children = sortByOrder(node.children, order[node.id], compareNodes);
  for (const c of node.children) sortChildren(c, order);
}

function compareNodes(left: Node, right: Node): number {
  return (
    compareText(left.name, right.name) ||
    compareText(left.path, right.path) ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function loadNode(fs: FsAdapter, path: string, parent: Node | null): Promise<Node | null> {
  if (isOperationalPath(path)) return null;
  const nodeFile = nodeNotePath(path);
  if (!(await fs.exists(nodeFile))) {
    // 没有同名 .md 的文件夹不是 Node（普通分组）。但其子孙里可能有 —— 透传扫描。
    return null;
  }
  const raw = await fs.readFile(nodeFile);
  let parsed: ReturnType<typeof parseFrontmatter>;
  let parseError: string | undefined;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path);
  const schemaError = canonicalIdentityError(data);

  const { fm, tags } = normalizeIdentity(data);
  const node: Node = {
    id: fm.id,
    type: fm.type,
    tags,
    ...documentLifecycle(fm),
    archived: false,
    invalid: !!parseError || !!schemaError,
    path,
    name,
    fm,
    etag: contentEtag(raw),
    body,
    children: [],
    parent,
  };
  if (parseError || schemaError) {
    node.invalidRootId = path;
    node.invalidReason = parseError ? `Invalid frontmatter: ${parseError}` : schemaError;
  }

  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadNodeInto(fs, join(path, entry.name), node, node.children);
  }
  return node;
}

export function canonicalIdentityError(data: Record<string, unknown>): string | undefined {
  if (typeof data.id !== "string" || !isNodeId(data.id)) {
    return `Invalid Node id: ${typeof data.id === "string" && data.id ? data.id : "<missing>"}; canonical Node ids must start with node-.`;
  }
  try {
    normalizeOptionalNodeType(data.type);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    materialFields(data);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function normalizeIdentity(data: Record<string, unknown>): {
  fm: NodeFrontmatter;
  tags: string[];
} {
  let type: string | undefined;
  try {
    type = normalizeOptionalNodeType(data.type);
  } catch {
    // canonicalIdentityError marks this Node invalid. Keep it discoverable by
    // path for repair without projecting a malformed typed value.
    type = undefined;
  }
  const fm: NodeFrontmatter = {
    ...data,
    id: typeof data.id === "string" ? data.id : "",
    ...(type ? { type } : {}),
  } as NodeFrontmatter;
  if (!type) delete fm.type;
  // Unknown frontmatter remains opaque user metadata. Runtime never translates
  // retired collaboration keys into canonical Node or Card state.
  const tags = normalizeTags(data.tags);
  if (tags.length > 0) fm.tags = tags;
  else delete fm.tags;
  return { fm, tags };
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// 普通分组文件夹:自己不是框,但把其下的框作为"虚拟同级"上浮给 parent。
async function loadNodeInto(
  fs: FsAdapter,
  path: string,
  parent: Node | null,
  target: Node[],
): Promise<void> {
  if (isOperationalPath(path)) return;
  const node = await loadNode(fs, path, parent);
  if (node) {
    target.push(node);
    return;
  }
  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadNodeInto(fs, join(path, entry.name), parent, target);
  }
}

function resolveSubtree(node: Node, inheritedInvalid?: { rootId: string; reason: string }): void {
  const directInvalid = node.invalid
    ? {
        rootId: node.invalidRootId || node.path,
        reason: node.invalidReason || "Invalid frontmatter.",
      }
    : invalidIdentityReference(node);
  const invalid = inheritedInvalid || directInvalid;
  node.invalid = !!invalid;
  node.invalidRootId = invalid?.rootId;
  node.invalidReason = invalid?.reason;
  const lifecycle = documentLifecycle(node.fm);
  node.status = lifecycle.status;
  node.statusDiagnostic = lifecycle.statusDiagnostic;
  node.archived = node.status === "deprecated";
  for (const c of node.children) resolveSubtree(c, invalid);
}

function invalidIdentityReference(node: Node): { rootId: string; reason: string } | undefined {
  if (!isNodeId(node.id)) {
    return {
      rootId: node.path,
      reason: `Invalid Node id: ${node.id || "<missing>"}; canonical Node ids must start with node-.`,
    };
  }
  return undefined;
}

/** Default current-context discovery; lifecycle never grants or denies write permission. */
export function isUsableNode(node: Node): boolean {
  return !node.invalid && node.status !== null && !node.archived;
}

/**
 * Core content & structure mutation gate.
 * A deprecated document may be explicitly selected and edited without reactivation.
 */
export function assertContentMutable(node: Node, action = "modified"): void {
  if (node.invalid) throw new Error(`Invalid nodes cannot be ${action}.`);
}

/** True when Core may mutate the explicitly selected document. */
export function isContentMutable(node: Node): boolean {
  return !node.invalid;
}

function indexSubtree(
  node: Node,
  byId: Map<string, Node>,
  byPath: Map<string, Node>,
  duplicateIds: Set<string>,
): void {
  if (!node.invalid && isNodeId(node.id) && !duplicateIds.has(node.id)) byId.set(node.id, node);
  byPath.set(node.path, node);
  for (const c of node.children) indexSubtree(c, byId, byPath, duplicateIds);
}

// ---- 路径工具(纯字符串,不依赖 node:path,核心层保持可移植) ----

export function join(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
