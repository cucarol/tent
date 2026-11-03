import path from "node:path";
import { isDirectoryMaterial, localMaterialPath, materialLocator } from "./material.js";

import { isTentWorkspacePath, type MaterialCoverage } from "./material-coverage-match.js";
export {
  isTentWorkspacePath,
  materialCoverageContains,
  type MaterialCoverage,
} from "./material-coverage-match.js";

/** Shared membership authority. A prefix has exactly one final-segment trailing star. */
export function materialCoverage(
  resource: string,
  documentPath: string,
  workspaceRoot: string,
  source = true,
): MaterialCoverage | undefined {
  try {
    const locator = materialLocator(resource, documentPath, source);
    const filename = localMaterialPath(locator, workspaceRoot);
    if (filename === undefined) return undefined;
    let relative = path.relative(workspaceRoot, filename).split(path.sep).join("/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return;
    if (isTentWorkspacePath(relative)) return;
    if (isDirectoryMaterial(locator)) {
      if (relative.includes("*")) return;
      return { kind: "directory", prefix: relative ? `${relative.replace(/\/$/, "")}/` : "" };
    }
    if (!relative.includes("*")) return relative ? { kind: "file", prefix: relative } : undefined;
    if (!relative.endsWith("*") || relative.indexOf("*") !== relative.length - 1) return;
    relative = relative.slice(0, -1);
    return { kind: "prefix", prefix: relative };
  } catch {
    return undefined;
  }
}
