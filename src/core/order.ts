// 隐藏的同级顺序表。order 对 user 不显式 —— 不写进框身份文件 frontmatter,
// 而是存 system root 的 order.json。
// 结构:{ <父框id 或 __root__>: [子框id, 子框id, …] }。
// 只为"被 user 拖动过的父级"留条目,其余按名字自然排,sidecar 保持稀疏。

import { FsAdapter } from "./adapter.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registry-recovery.js";
import { ORDER_PATH } from "./paths.js";

export type OrderMap = Record<string, string[]>;
export const ROOT_KEY = "__root__";
export { ORDER_PATH };

/** 正常路径只读扁平 order.json；嵌套 `.tent/order.json` 由一次性迁移搬迁。 */
export async function loadOrder(fs: FsAdapter): Promise<OrderMap> {
  if (!(await fs.exists(ORDER_PATH))) return {};
  try {
    return JSON.parse(await fs.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs, ORDER_PATH);
    await saveOrder(fs, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}

export async function saveOrder(fs: FsAdapter, map: OrderMap): Promise<void> {
  await fs.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
}

// 按 order 列表排:列表内的按列表序在前,其余走 fallback 排在后。
export function sortByOrder<T extends { id: string }>(
  items: T[],
  order: string[] | undefined,
  fallback: (a: T, b: T) => number,
): T[] {
  const sorted = [...items];
  if (!order || order.length === 0) {
    sorted.sort(fallback);
    return sorted;
  }
  const idx = new Map(order.map((id, i) => [id, i]));
  sorted.sort((a, b) => {
    const ai = idx.has(a.id) ? idx.get(a.id)! : Infinity;
    const bi = idx.has(b.id) ? idx.get(b.id)! : Infinity;
    if (ai !== bi) return ai - bi;
    return fallback(a, b);
  });
  return sorted;
}
