import path from "node:path";
import type { FsAdapter } from "./adapter.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { parseFrontmatter } from "./frontmatter.js";
import { documentLifecycle } from "./document-status.js";
import { localMaterialPath, resolvedMaterialOccurrences } from "./material.js";
import { nodeNotePath } from "./paths.js";
import { materialCheck, type ObserveMaterial } from "./material-check.js";

export type StopActivity = { paths: string[]; uncertain: boolean; cancelled?: true };
const key = (file: string) =>
  process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const fits = (message: string) =>
  Buffer.byteLength(JSON.stringify({ systemMessage: message }) + "\n", "utf8") <= 2048;

/** Advisory only: no baseline, completion receipt, document save, or model continuation. */
export async function stopAdvice(
  fs: FsAdapter,
  workspaceRoot: string,
  activity: StopActivity,
  observe: ObserveMaterial,
): Promise<string | undefined> {
  if (activity.cancelled || (!activity.uncertain && !activity.paths.length)) return undefined;
  if (activity.uncertain && !activity.paths.length)
    return "Tent：本轮修改路径归属未证实；未进行同步扫描。按实际工作检查需要维护的 Node。";
  const changed = activity.paths.map((file) => key(path.resolve(workspaceRoot, file)));
  const catalog = await loadNodeCatalog(fs);
  const candidates: string[] = [];
  let more = false,
    inspected = 0;
  for (const node of catalog.byId.values()) {
    const data = parseFrontmatter(node.header).data;
    if (!["draft", "stable"].includes(documentLifecycle(data).status ?? "")) continue;
    const addressed = resolvedMaterialOccurrences(data, nodeNotePath(node.path)).flatMap(
      ({ locator }) => {
        if (!locator) return [];
        const file = localMaterialPath(locator, workspaceRoot);
        return file === undefined ? [] : [key(file)];
      },
    );
    const affected = changed.filter((file) =>
      addressed.some((target) => file === target || file.startsWith(target + path.sep)),
    );
    if (!affected.length) continue;
    if (inspected++ === 5) {
      more = true;
      break;
    }
    if (await fs.exists(`temp/material-checks/${node.nodeId}.json`)) {
      try {
        const checked = await materialCheck(
          fs,
          { action: "inspect", nodeId: node.nodeId },
          observe,
        );
        if (
          checked.state === "current" &&
          affected.every((file) =>
            checked.record.materials.some((material) => key(material.canonicalPath) === file),
          )
        )
          continue;
      } catch {
        /* An unavailable check cannot suppress this candidate. */
      }
    }
    const title = Array.from(node.name)
      .slice(0, 48)
      .join("")
      .replace(/[\r\n]/g, " ");
    const item = `${node.nodeId} (${title})`;
    const trial = `Tent：已观察修改涉及以下 Node，可按需核对：\n${[...candidates, item].join("\n")}\n更多候选请用 node search --resource 查询实际修改路径。${activity.uncertain ? "本轮路径归属不完整；" : ""}提示不是同步完成证明。`;
    if (!fits(trial)) {
      more = true;
      break;
    }
    candidates.push(item);
  }
  if (!candidates.length && !more)
    return activity.uncertain
      ? "Tent：本轮路径归属不完整；已知修改路径未匹配到 Node。按实际工作检查需要维护的 Node。"
      : undefined;
  return `Tent：已观察修改涉及以下 Node，可按需核对：\n${candidates.join("\n")}${more ? "\n更多候选请用 node search --resource 查询实际修改路径。" : ""}\n${activity.uncertain ? "本轮路径归属不完整；" : ""}提示不是同步完成证明。`;
}
