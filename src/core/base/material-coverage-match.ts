import path from "node:path";

export type MaterialCoverage = { kind: "directory" | "prefix"; prefix: string };

/** The Workspace file domain excludes its local collaboration state. */
export function isTentWorkspacePath(workspacePath: string): boolean {
  const first = workspacePath.split("/")[0];
  return process.platform === "win32" ? first?.toLowerCase() === ".tent" : first === ".tent";
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
