import path from "node:path";

export type MaterialCoverage = { kind: "file" | "directory" | "prefix"; prefix: string };

/** The Workspace file domain excludes its local collaboration state. */
export function isTentWorkspacePath(workspacePath: string): boolean {
  const first = workspacePath.split("/")[0];
  return process.platform === "win32" ? first?.toLowerCase() === ".tent" : first === ".tent";
}

/** Validate the Workspace file domain and fold Windows case once per path. */
export function normalizedMaterialWorkspacePath(workspacePath: string): string | undefined {
  if (!workspacePath || workspacePath.includes("\\") || path.posix.isAbsolute(workspacePath))
    return undefined;
  const normalized = process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath;
  if (normalized === ".tent" || normalized.startsWith(".tent/")) return undefined;
  if (workspacePath.split("/").some((part) => part === "." || part === ".." || !part))
    return undefined;
  return normalized;
}

/** Internal matching step: both inputs are case-folded, and the file path is valid. */
export function normalizedMaterialCoverageContains(
  coverage: MaterialCoverage,
  workspacePath: string,
): boolean {
  if (coverage.kind === "file") return workspacePath === coverage.prefix;
  return (
    workspacePath.startsWith(coverage.prefix) &&
    (coverage.kind !== "directory" || workspacePath !== coverage.prefix.slice(0, -1))
  );
}

export function materialCoverageContains(
  coverage: MaterialCoverage,
  workspacePath: string,
): boolean {
  const normalized = normalizedMaterialWorkspacePath(workspacePath);
  if (normalized === undefined) return false;
  const prefix = process.platform === "win32" ? coverage.prefix.toLowerCase() : coverage.prefix;
  return normalizedMaterialCoverageContains(
    prefix === coverage.prefix ? coverage : { ...coverage, prefix },
    normalized,
  );
}
