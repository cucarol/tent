import * as fs from "node:fs/promises";
import * as path from "node:path";
import { INDEX_PATH } from "./paths.js";
import { isValidTentIndexMarker } from "./scaffold.js";
import { parseFrontmatter } from "./frontmatter.js";

export const NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/index.md marker found).";

/**
 * 定位 tent system root：
 * 1. cwd 本身是 system root（含 index.md marker）
 * 2. cwd 下有 `.tent/` system dir（workspace 根）
 * 3. 向上查找（兼容从子目录调用）
 */
export async function findTentSystemRoot(
  cwd = process.cwd(),
  stopAt?: string,
): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  const boundary = stopAt ? path.resolve(stopAt) : undefined;
  for (;;) {
    if (await isSystemRoot(dir)) return dir;
    const nested = path.join(dir, ".tent");
    if (await isSystemRoot(nested)) return nested;
    if (boundary && dir === boundary) return undefined;
    // A clone or worktree owns its workspace boundary even without a Tent.
    // .git can be a directory (checkout) or a file (linked worktree).
    if (await fs.lstat(path.join(dir, ".git")).catch(() => undefined)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function isSystemRoot(root: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(root, INDEX_PATH), "utf8");
    if (!isValidTentIndexMarker(raw)) return false;
    // .tent 以外需要明确版本标记，否则普通 Markdown 首页会截断向上发现。
    return path.basename(root) === ".tent" || parseFrontmatter(raw).data.okf_version === "0.2";
  } catch {
    return false;
  }
}
