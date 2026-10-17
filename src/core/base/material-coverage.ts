import path from "node:path";
import {
  isDirectoryMaterial,
  localMaterialPath,
  materialLocator,
  materialOccurrences,
} from "./material.js";

export type MaterialCoverage = { kind: "directory" | "prefix"; prefix: string };

/** The Workspace file domain excludes its local collaboration state. */
export function isTentWorkspacePath(workspacePath: string): boolean {
  const first = workspacePath.split("/")[0];
  return process.platform === "win32" ? first?.toLowerCase() === ".tent" : first === ".tent";
}

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

export function materialCoverageContains(
  coverage: MaterialCoverage,
  workspacePath: string,
): boolean {
  if (!workspacePath || workspacePath.includes("\\") || path.posix.isAbsolute(workspacePath))
    return false;
  if (isTentWorkspacePath(workspacePath)) return false;
  if (workspacePath.split("/").some((part) => part === "." || part === ".." || !part)) return false;
  const normalized = process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath;
  const prefix = process.platform === "win32" ? coverage.prefix.toLowerCase() : coverage.prefix;
  return (
    normalized.startsWith(prefix) &&
    (coverage.kind !== "directory" || normalized !== prefix.slice(0, -1))
  );
}
