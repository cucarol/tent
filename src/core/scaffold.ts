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
  INDEX_PATH,
  OPERATIONAL_TOP_LEVEL,
  TEMP_DIR,
  WORKSPACE_SETTINGS_PATH,
  isSystemNoteName,
  isOperationalPath,
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

  await fs.writeFile(INDEX_PATH, tentIndexMarker());
  await fs.writeFile(
    WORKSPACE_SETTINGS_PATH,
    JSON.stringify({ workspaceId: `ws-${randomUUID()}` }, null, 2) + "\n",
  );
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

/**
 * Windows device names stay reserved with any extension, so every checkout must reject them.
 * COM and LPT are also reserved with superscript ¹ ² ³ (U+00B9, U+00B2, U+00B3).
 */
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|(?:com|lpt)[1-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/i;

/** Names become directories on every platform, so Windows file-name rules apply everywhere. */
export function validateNodeName(value: string, parentPath = ""): string {
  // Check the raw input, so trimming never hides a tab, newline or control character at either end.
  if (/[\r\n\u2028\u2029]/.test(value)) throw new Error("Node name cannot contain newlines.");
  if (value.includes("\t")) throw new Error("Node name cannot contain a tab.");
  if (/[\x00-\x1F\x7F]/.test(value))
    throw new Error("Node name cannot contain control characters.");
  const name = value.trim();
  if (!name) throw new Error("Node name cannot be empty.");
  if (name.length > 200) throw new Error("Node name cannot be longer than 200 characters.");
  if (/[\/\\]/.test(name)) throw new Error("Node name cannot contain path separators.");
  const character = /[<>:"|?*]/.exec(name)?.[0];
  if (character)
    throw new Error(
      `Node name cannot contain the character ${character} (Windows file names exclude < > : " / \\ | ? *).`,
    );
  if (
    name === "." ||
    name === ".." ||
    name.startsWith(".git") ||
    OPERATIONAL_TOP_LEVEL.has(name) ||
    (!parentPath && (isSystemNoteName(name) || isOperationalPath(name)))
  ) {
    throw new Error(`Node name is reserved or excluded from the Node index: ${name}.`);
  }
  if (name.endsWith("."))
    throw new Error("Node name cannot end with a dot; Windows removes trailing dots.");
  if (WINDOWS_RESERVED_NAME.test(name))
    throw new Error(
      `Node name ${name} is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9, COM¹-COM³, LPT¹-LPT³), with or without an extension.`,
    );
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
