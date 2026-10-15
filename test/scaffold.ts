import type { FsAdapter } from "../src/core/adapter.js";
import { randomUUID } from "node:crypto";
import { NODE_FRONTMATTER_KEY_ORDER, serializeFrontmatter } from "../src/core/frontmatter.js";
import { normalizeOptionalNodeType } from "../src/core/node-type.js";
import { isNodeId, makeUniqueNodeId } from "../src/core/id.js";
import {
  INDEX_PATH,
  TEMP_DIR,
  TENT_SYSTEM_DIR,
  WORKSPACE_SETTINGS_PATH,
} from "../src/core/paths.js";
import {
  validateNodeName,
  tentIndexMarker,
  type ScaffoldTentOptions,
} from "../src/core/scaffold.js";
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
  await workspaceFs.writeFile(nested(INDEX_PATH), tentIndexMarker());
  await workspaceFs.writeFile(
    nested(WORKSPACE_SETTINGS_PATH),
    JSON.stringify({ workspaceId: `ws-${randomUUID()}` }, null, 2) + "\n",
  );

  return { systemRootRelative: systemRelative };
}
