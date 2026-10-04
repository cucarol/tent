// Tent 系统目录路径合同：协作事实落在 workspace 内固定名 `.tent/`。
// FsAdapter 的根是 tent system root（即 `<workspace>/.tent`），其内路径不再嵌套一层 `.tent/`。

/** 工作区内固定的 Tent 系统目录名。 */
export const TENT_SYSTEM_DIR = ".tent";

/** Role Markdown documents (operational, not Nodes). */
export const ROLES_DIR = "roles";
export const ORDER_PATH = "order.json";
export const MUTATION_LOCK_PATH = "mutation.lock";
export const NODE_MOVE_PENDING_PATH = "node-move.pending.json";
export const DELETE_PENDING_PATH = "delete.pending.json";
/** Structural marker for an initialized Tent system root. */
export const INDEX_PATH = "index.md";
/** Workspace identity and preserved custom settings. */
export const WORKSPACE_SETTINGS_PATH = "settings.json";
/** Card drafts, published input, destination and reception facts. */
export const CARDS_DIR = "cards";
export const TEMP_DIR = "temp";
export const ATTACHMENTS_DIR = "attachments";

/** Canonical Markdown identity file for a Node directory. */
export function nodeNotePath(nodePath: string): string {
  const separator = nodePath.lastIndexOf("/");
  const name = separator === -1 ? nodePath : nodePath.slice(separator + 1);
  return nodePath === "" ? ".md" : `${nodePath}/${name}.md`;
}

/** 不进入 Node 索引的顶层/路径前缀（相对 system root）。 */
export const OPERATIONAL_TOP_LEVEL = new Set([
  ".git",
  ROLES_DIR,
  CARDS_DIR,
  TEMP_DIR,
  ATTACHMENTS_DIR,
  // 若仍见嵌套 .tent，视为系统区而非 Node。
  TENT_SYSTEM_DIR,
]);

/** Canonical Role Markdown path relative to the Tent system root. */
export function roleDocumentPath(roleId: string): string {
  return `${ROLES_DIR}/${roleId}.md`;
}

export function cardRecordPath(cardId: string): string {
  return `${CARDS_DIR}/${safeOperationalSegment(cardId, "card")}.md`;
}

/** 系统注册表文件名（非 Node）。 */
export const SYSTEM_REGISTRY_FILES = new Set([
  ORDER_PATH,
  MUTATION_LOCK_PATH,
  NODE_MOVE_PENDING_PATH,
  DELETE_PENDING_PATH,
  WORKSPACE_SETTINGS_PATH,
  INDEX_PATH,
]);

/**
 * 若 system root 目录名是 `.tent`，其父目录即 workspace 根。
 * 否则无法从布局推导 workspace（纯协作目录 / 测试 fixture）。
 */
export function workspaceRootFromSystemRoot(systemRoot: string): string | undefined {
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base = normalized.split(/[\\/]/).pop() ?? "";
  if (base !== TENT_SYSTEM_DIR) return undefined;
  const parent = normalized.replace(/[\\/]+[^\\/]+$/, "");
  return parent || undefined;
}

/** 从 workspace 根得到 system root 路径（字符串拼接，不访问磁盘）。 */
export function systemRootFromWorkspace(workspaceRoot: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${sep}${TENT_SYSTEM_DIR}`;
}

/** 路径是否落在 operational pipeline（相对 system root，posix 风格）。 */
export function isOperationalPath(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path) return false;
  const top = path.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}

/**
 * Sanitize identity segments for operational directory names.
 * Deterministic, path-safe; not a security boundary.
 */
export function safeOperationalSegment(value: string, emptyPrefix = "id"): string {
  const source = value.trim();
  if (!source) throw new Error("Operational segment cannot be empty.");
  const normalized = source.normalize("NFKC");
  let clean = normalized
    .replace(/[<>:"/\\|?*\x00-\x1f~^:[\]@{}]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 40);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean);
  if (reserved) clean = `${emptyPrefix}-${clean}`;
  if (!clean) {
    // Short stable hash of the original so empty sanitization never collides on "".
    let h = 0;
    for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
    return `${emptyPrefix}-${h.toString(36)}`;
  }
  if (clean !== normalized || normalized !== source || reserved) {
    let h = 0;
    for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
    return `${clean}-${h.toString(36)}`;
  }
  return clean;
}

/** 是否为应排除在 Node 索引外的生成/系统文件名。 */
export function isSystemNoteName(fileName: string): boolean {
  return SYSTEM_REGISTRY_FILES.has(fileName);
}
