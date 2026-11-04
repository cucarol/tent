import { withTentMutation } from "../store/adapter.js";
import { documentLifecycle } from "../base/document-status.js";
import { parseFrontmatter, serializeFrontmatter } from "../base/frontmatter.js";
import { nodeNotePath } from "../store/tree.js";
import { loadNodeCatalog } from "./node-catalog.js";
import type { OpsEnv } from "./ops-context.js";

function statusRaw(raw: string, status: unknown) {
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (status === undefined) delete data.status;
  else data.status = status;
  return serializeFrontmatter(data, body, keyOrder);
}

/** Archive exactly the current subtree; local deprecated declarations are not inherited. */
export function archiveNode(env: OpsEnv, nodeId: string) {
  return withTentMutation(env.fs, async () => {
    const history = env.fs.history;
    if (!(await history.available())) throw new Error("Archive operations require Tent history");
    const catalog = await loadNodeCatalog(env.fs),
      root = catalog.byId.get(nodeId);
    if (!root) throw new Error(`Node not found: ${nodeId}`);
    const inSubtree = (path: string) => path === root.path || path.startsWith(root.path + "/");
    // Invalid descendants must not disappear from a successful subtree operation.
    if ([...catalog.byPath.values()].some((n) => inSubtree(n.path) && n.invalid))
      throw new Error("Archive subtree contains invalid documents; repair them first");
    const changes: { path: string; raw: string }[] = [];
    for (const member of catalog.byId.values()) {
      if (!inSubtree(member.path)) continue;
      const path = nodeNotePath(member.path);
      const raw = await env.fs.readFile(path);
      const { status } = documentLifecycle(parseFrontmatter(raw).data);
      if (status === null) throw new Error(`Unsupported status in archive subtree: ${member.path}`);
      if (status === "deprecated") continue;
      const after = statusRaw(raw, "deprecated");
      await env.fs.writeFile(path, after);
      changes.push({ path, raw: after });
    }
    const captured = changes.length
      ? await history.captureUnlocked(changes, { operation: "node.archive" })
      : undefined;
    return {
      nodeId,
      path: root.path,
      changed: changes.length > 0,
      paths: changes.map((change) => change.path),
      commit: captured?.commit ?? undefined,
      versions: captured?.versions ?? [],
    };
  });
}
