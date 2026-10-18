import type { FsAdapter } from "../store/adapter.js";
import {
  isDirectoryMaterial,
  isPrefixMaterial,
  resolvedMaterialOccurrences,
} from "../base/material.js";
import { systemMaterialPath } from "./material-target.js";

/** Advice for explicit writes only; no warning changes a Node's type or synchronization basis. */
export async function nodeMaterialWarnings(
  fs: Pick<FsAdapter, "workspaceRoot" | "materialIsTracked">,
  data: Record<string, unknown>,
  documentPath: string,
): Promise<string[]> {
  if ((data.type !== "goal" && data.type !== "prompt") || !fs.materialIsTracked) return [];
  const untracked: string[] = [];
  for (const { resource, locator } of resolvedMaterialOccurrences(data, documentPath)) {
    if (
      !locator ||
      locator.kind === "unresolved" ||
      (locator.kind === "uri" && !locator.uri.startsWith("file:")) ||
      isDirectoryMaterial(locator) ||
      isPrefixMaterial(locator) ||
      systemMaterialPath(locator, fs.workspaceRoot) !== undefined ||
      untracked.includes(resource)
    )
      continue;
    // A hint must never turn a successful write into a failed receipt or guess from a Git error.
    if ((await fs.materialIsTracked(resource, documentPath).catch(() => undefined)) === false)
      untracked.push(resource);
  }
  return untracked.length
    ? [
        `${String(data.id ?? "Node")}: Local material is not tracked by Git; Tent cannot inspect how it changed. Record a result from one point in time as output. Materials: ${untracked.map((resource) => JSON.stringify(resource)).join(", ")}`,
      ]
    : [];
}
