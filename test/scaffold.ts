import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NODE_FRONTMATTER_KEY_ORDER, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { normalizeOptionalNodeType } from "../src/core/base/node-type.js";
import { isNodeId, makeUniqueNodeId } from "../src/core/base/id.js";
import {
  INDEX_PATH,
  TEMP_DIR,
  TENT_SYSTEM_DIR,
  WORKSPACE_SETTINGS_PATH,
} from "../src/core/base/paths.js";
import {
  validateNodeName,
  tentIndexMarker,
  type ScaffoldTentOptions,
} from "../src/core/store/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { ensureTestHistory } from "./node-fs.js";

export async function scaffoldInWorkspace(
  workspace: string,
  options: ScaffoldTentOptions,
): Promise<void> {
  const systemRoot = path.join(workspace, TENT_SYSTEM_DIR);
  if (existsSync(systemRoot))
    throw new Error(`Target already has a Tent system dir: ${TENT_SYSTEM_DIR}`);
  ensureTestHistory(systemRoot);
  const tent = new NodeFs(systemRoot);

  const usedIds = new Set<string>();
  for (const node of options.nodes ?? []) {
    const nodeName = validateNodeName(node.name);
    const type = normalizeOptionalNodeType(node.type, `Node ${nodeName} type`);
    const id = node.id?.trim() || makeUniqueNodeId(usedIds);
    if (!isNodeId(id)) throw new Error(`Scaffold Node id must use canonical node-* form: ${id}`);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    await tent.mkdir(nodeName);
    await tent.writeFile(
      `${nodeName}/${nodeName}.md`,
      serializeFrontmatter(frontmatter, node.body ?? "", NODE_FRONTMATTER_KEY_ORDER),
    );
  }

  await tent.mkdir(TEMP_DIR);
  await tent.writeFile(INDEX_PATH, tentIndexMarker());
  await tent.writeFile(
    WORKSPACE_SETTINGS_PATH,
    JSON.stringify({ workspaceId: `ws-${randomUUID()}` }, null, 2) + "\n",
  );
}
