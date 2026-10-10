import path from "node:path";
import { nodeNotePath } from "../core/paths.js";
import { materialLocator, localMaterialPath } from "../core/material.js";
import { markdownMaterialHeading } from "../core/material-section.js";

/** Discovery addresses are directly usable by the host's file reader. */
export function workspaceReadPaths<T>(value: T, workspaceRoot: string): T {
  if (Array.isArray(value))
    return value.map((item) => workspaceReadPaths(item, workspaceRoot)) as T;
  if (!value || typeof value !== "object") return value;
  const item = { ...value } as Record<string, unknown>;
  const originalPath = typeof item.path === "string" ? item.path : undefined;
  const owner = originalPath?.replace(/^\.tent\//, "");
  const nodeDirectory =
    item.kind !== "node" &&
    (typeof item.nodeId === "string" ||
      (typeof item.id === "string" && item.id.startsWith("node-")));
  const nodeOwner = nodeDirectory || item.kind === "node";
  const document =
    owner && nodeDirectory && !originalPath?.startsWith(".tent/") ? nodeNotePath(owner) : owner;
  if (owner) {
    if (nodeOwner) item.path = `.tent/${document}`;
    else if (
      typeof item.cardId === "string" ||
      typeof item.roleId === "string" ||
      item.kind === "card" ||
      item.kind === "role"
    )
      item.path = `.tent/${owner}`;
  }
  if (owner && Array.isArray(item.sources))
    item.sources = item.sources.map((source) => {
      if (!source || typeof source.resource !== "string") return source;
      try {
        const locator = materialLocator(source.resource, document!, true);
        const filename = localMaterialPath(locator, workspaceRoot);
        const heading = markdownMaterialHeading(locator);
        return {
          ...source,
          ...(filename ? { path: path.relative(workspaceRoot, filename).replace(/\\/g, "/") } : {}),
          ...(heading ? { heading } : {}),
        };
      } catch {
        return source;
      }
    });
  for (const key of [
    "items",
    "node",
    "nodes",
    "results",
    "readBack",
    "children",
    "from",
    "target",
    "currentReferences",
  ])
    if (key in item) item[key] = workspaceReadPaths(item[key], workspaceRoot);
  return item as T;
}
