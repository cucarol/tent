import { createHash } from "node:crypto";
import { nodeIsStale } from "../base/node-provenance.js";
import { nodeNotePath } from "../base/paths.js";
import type { Node } from "../base/types.js";
import {
  readModuleDependencies,
  type ModuleDependencies,
  type ModuleDependencyRepository,
} from "../graph/module-dependencies.js";
import { loadNodeCatalog } from "../graph/node-catalog.js";
import { readOnlyFs, type FsAdapter } from "../store/adapter.js";

export type WorkspaceMapNode = {
  id: string;
  name: string;
  path: string;
  notePath: string;
  depth: number;
  type: string;
  tags: string[];
  status: string;
  archived: boolean;
  parentId: string | null;
  childIds: string[];
  stale: boolean;
  invalid: boolean;
  invalidReason?: string;
};

export type WorkspaceMap = {
  workspace: { id: string; name: string; revision: string; generatedAt: string };
  nodes: WorkspaceMapNode[];
  modules: ModuleDependencies;
};

/** First-screen topology and module lines; no document bodies, Cards or retained history. */
export async function readWorkspaceMap(
  fs: FsAdapter,
  workspace: { id: string; name: string },
  workspaceRoot: string,
  repository: ModuleDependencyRepository | Promise<ModuleDependencyRepository>,
  now = new Date().toISOString(),
): Promise<WorkspaceMap> {
  const source = readOnlyFs(fs);
  const [catalog, currentRepository] = await Promise.all([loadNodeCatalog(source), repository]);
  const modules = await readModuleDependencies(source, workspaceRoot, currentRepository, catalog);
  const nodes: WorkspaceMapNode[] = [];
  const headers: string[] = [];
  const visit = (node: Node, depth: number) => {
    headers.push(catalog.byPath.get(node.path)!.header);
    nodes.push({
      id: node.id,
      name: node.name,
      path: node.path,
      notePath: nodeNotePath(node.path),
      depth,
      type: node.type ?? "",
      tags: node.tags,
      status: node.status ?? "stable",
      archived: node.archived,
      parentId: node.parent?.id ?? null,
      childIds: node.children.map((child) => child.id),
      stale: !node.invalid && nodeIsStale(node.fm, now),
      invalid: node.invalid,
      ...(node.invalidReason ? { invalidReason: node.invalidReason } : {}),
    });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of catalog.tree.roots) visit(root, 0);
  // This revision belongs only to the map. Card/Role edits and Node body edits do not affect it.
  const revision = createHash("sha256")
    .update(JSON.stringify({ workspace, headers, nodes, modules }))
    .digest("hex");
  return { workspace: { ...workspace, revision, generatedAt: now }, nodes, modules };
}
