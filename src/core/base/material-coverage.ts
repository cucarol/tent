import path from "node:path";
import {
  isDirectoryMaterial,
  localMaterialPath,
  materialLocator,
  materialOccurrences,
} from "./material.js";

import { isTentWorkspacePath, type MaterialCoverage } from "./material-coverage-match.js";
export {
  isTentWorkspacePath,
  materialCoverageContains,
  type MaterialCoverage,
} from "./material-coverage-match.js";

/** Shared membership authority. A prefix has exactly one final-segment trailing star. */
export function structureMaterialCoverage(
  resource: string,
  documentPath: string,
  workspaceRoot: string,
): MaterialCoverage | undefined {
  try {
    const locator = materialLocator(resource, documentPath, true);
    const filename = localMaterialPath(locator, workspaceRoot);
    if (filename === undefined) return undefined;
    let relative = path.relative(workspaceRoot, filename).split(path.sep).join("/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return;
    if (isTentWorkspacePath(relative)) return;
    if (locator.kind === "path" && locator.suffix) return;
    if (locator.kind === "uri" && (new URL(locator.uri).search || new URL(locator.uri).hash))
      return;
    if (isDirectoryMaterial(locator)) {
      if (relative.includes("*")) return;
      return { kind: "directory", prefix: relative ? `${relative.replace(/\/$/, "")}/` : "" };
    }
    if (!relative.endsWith("*") || relative.indexOf("*") !== relative.length - 1) return;
    relative = relative.slice(0, -1);
    return { kind: "prefix", prefix: relative };
  } catch {
    return undefined;
  }
}

/** Directory/prefix declarations implement a goal; individual references do not. */
export function isCoverageGoal(
  data: Record<string, unknown>,
  documentPath: string,
  workspaceRoot: string | undefined,
): boolean {
  return (
    data.type === "goal" &&
    workspaceRoot !== undefined &&
    materialOccurrences(data).some(({ resource }) =>
      structureMaterialCoverage(resource, documentPath, workspaceRoot),
    )
  );
}
