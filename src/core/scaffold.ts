import { FsAdapter } from "./adapter.js";
import { randomUUID } from "node:crypto";
import {
  NODE_FRONTMATTER_KEY_ORDER,
  parseFrontmatter,
  serializeFrontmatter,
} from "./frontmatter.js";
import { normalizeOptionalNodeType } from "./node-type.js";
import { nodeNotePath } from "./tree.js";
import { isNodeId, makeUniqueNodeId } from "./id.js";
import {
  ATTACHMENTS_DIR,
  INDEX_PATH,
  OPERATIONAL_TOP_LEVEL,
  TEMP_DIR,
  TENT_SYSTEM_DIR,
  WORKSPACE_SETTINGS_PATH,
  isSystemNoteName,
  systemRootFromWorkspace,
} from "./paths.js";

/** Optional explicit Nodes for internal fixtures and import operations. */
export interface ScaffoldNode {
  name: string; // 文件夹名 = 框身份(真名)
  type: string; // canonical direct Node type marker
  body?: string; // 身份笔记正文
  id?: string; // 缺省自动生成 node-
}

export interface ScaffoldTentOptions {
  name: string;
  /** Explicit Nodes only; ordinary initialization starts empty. */
  nodes?: ScaffoldNode[];
}

/**
 * 在 **tent system root**（`<workspace>/.tent`）上 scaffold。
 * 调用方须把 FsAdapter 根指向 system root；本函数不写外置 vault 双路径。
 */
export async function scaffoldTent(fs: FsAdapter, options: ScaffoldTentOptions): Promise<void> {
  const name = options.name.trim();
  if (!name) throw new Error("Tent name cannot be empty.");

  const usedIds = new Set<string>();
  for (const node of options.nodes ?? []) {
    const nodeName = validateNodeName(node.name);
    const type = normalizeOptionalNodeType(node.type, `Node ${nodeName} type`);
    const id = node.id?.trim() || makeUniqueNodeId(usedIds);
    if (!isNodeId(id)) throw new Error(`Scaffold Node id must use canonical node-* form: ${id}`);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    await writeNode(fs, nodeName, frontmatter, node.body ?? "");
  }

  await fs.mkdir(TEMP_DIR);
  await fs.mkdir(ATTACHMENTS_DIR);

  await fs.writeFile(INDEX_PATH, tentIndexMarker());
  await fs.writeFile(
    WORKSPACE_SETTINGS_PATH,
    JSON.stringify({ workspaceId: `ws-${randomUUID()}` }, null, 2) + "\n",
  );
}

/**
 * 在 **workspace 根** 上创建 in-workspace tent：`<workspace>/.tent/`。
 * 会确保 workspace `.gitignore` 忽略 `.tent/`（若仓库使用 Git 且文件可写）。
 * 不创建外置 vault 路径，不双写。
 */
export async function scaffoldInWorkspace(
  workspaceFs: FsAdapter,
  options: ScaffoldTentOptions,
): Promise<{ systemRootRelative: string }> {
  const systemRelative = TENT_SYSTEM_DIR;
  if (await workspaceFs.exists(systemRelative)) {
    throw new Error(`Target already has a Tent system dir: ${systemRelative}`);
  }
  await workspaceFs.mkdir(systemRelative);
  // Nested adapter-style paths under workspace root
  const nested = (p: string) => `${systemRelative}/${p}`.replace(/\\/g, "/");

  const usedIds = new Set<string>();
  for (const node of options.nodes ?? []) {
    const nodeName = validateNodeName(node.name);
    const type = normalizeOptionalNodeType(node.type, `Node ${nodeName} type`);
    const id = node.id?.trim() || makeUniqueNodeId(usedIds);
    if (!isNodeId(id)) throw new Error(`Scaffold Node id must use canonical node-* form: ${id}`);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    const path = nested(nodeName);
    await workspaceFs.mkdir(path);
    await workspaceFs.writeFile(
      `${path}/${nodeName}.md`,
      serializeFrontmatter(frontmatter, node.body ?? "", NODE_FRONTMATTER_KEY_ORDER),
    );
  }

  await workspaceFs.mkdir(nested(TEMP_DIR));
  await workspaceFs.mkdir(nested(ATTACHMENTS_DIR));
  await workspaceFs.writeFile(nested(INDEX_PATH), tentIndexMarker());
  await workspaceFs.writeFile(
    nested(WORKSPACE_SETTINGS_PATH),
    JSON.stringify({ workspaceId: `ws-${randomUUID()}` }, null, 2) + "\n",
  );

  await ensureWorkspaceGitignore(workspaceFs);
  return { systemRootRelative: systemRelative };
}

/** True when raw content is a structural Tent index marker (OKF 0.2). */
export function isValidTentIndexMarker(raw: string): boolean {
  try {
    const { data } = parseFrontmatter(raw);
    return (
      data.type === undefined && (data.okf_version === undefined || data.okf_version === "0.2")
    );
  } catch {
    return false;
  }
}

/** 确保 workspace 根 `.gitignore` 含 `.tent/` 条目。 */
export async function ensureWorkspaceGitignore(workspaceFs: FsAdapter): Promise<void> {
  const path = ".gitignore";
  const entry = `${TENT_SYSTEM_DIR}/`;
  if (!(await workspaceFs.exists(path))) {
    await workspaceFs.writeFile(path, `${entry}\n`);
    return;
  }
  const text = await workspaceFs.readFile(path);
  const lines = text.split(/\r?\n/);
  const has = lines.some((line) => {
    const t = line.trim();
    return t === entry || t === TENT_SYSTEM_DIR || t === `/${entry}` || t === `/${TENT_SYSTEM_DIR}`;
  });
  if (has) return;
  const next = text.endsWith("\n") || text === "" ? `${text}${entry}\n` : `${text}\n${entry}\n`;
  await workspaceFs.writeFile(path, next);
}

export function validateNodeName(value: string, parentPath = ""): string {
  const name = value.trim();
  if (!name) throw new Error("Node name cannot be empty.");
  if (name.length > 200) throw new Error("Node name cannot be longer than 200 characters.");
  if (/[\/\\]/.test(name)) throw new Error("Node name cannot contain path separators.");
  if (/[\r\n]/.test(name)) throw new Error("Node name cannot contain newlines.");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name))
    throw new Error("Node name cannot contain control characters.");
  if (
    name === "." ||
    name === ".." ||
    name.startsWith(".git") ||
    OPERATIONAL_TOP_LEVEL.has(name) ||
    (!parentPath && isSystemNoteName(name))
  ) {
    throw new Error(`Node name is reserved or excluded from the Node index: ${name}.`);
  }
  return name;
}

export function tentIndexMarker(): string {
  return `---\nokf_version: "0.2"\n---\n# Index\n`;
}

async function writeNode(
  fs: FsAdapter,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  await fs.mkdir(path);
  await fs.writeFile(
    nodeNotePath(path),
    serializeFrontmatter(frontmatter, body, NODE_FRONTMATTER_KEY_ORDER),
  );
}

export { systemRootFromWorkspace };
