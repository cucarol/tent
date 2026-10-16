import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";
import { materialCoverageContains, type MaterialCoverage } from "./material-coverage.js";
import { comparePaths, isTestSource, type RepositoryImport } from "./repository-imports.js";

export const structureDependenciesSchema = z
  .array(
    z
      .string()
      .min(1)
      .refine((value) => {
        const file = value.endsWith("/") ? value.slice(0, -1) : value;
        return (
          value === "./" ||
          (!file.startsWith("/") &&
            !file.includes("\\") &&
            !file
              .split("/")
              .some((part) => !part || part === "." || part === ".." || part === ".git"))
        );
      }),
  )
  .refine(
    (targets) => targets.every((target, index) => index === 0 || targets[index - 1]! < target),
    "Structure dependencies must be ordered and unique",
  );

/** The external outgoing target set is the complete structural basis. */
export function structureFingerprint(dependencies: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(dependencies)].sort(comparePaths)))
    .digest("hex");
}

export function changedStructureDependencies(before: readonly string[], after: readonly string[]) {
  const old = new Set(before),
    current = new Set(after);
  const changed = [...new Set([...old, ...current])]
    .sort(comparePaths)
    .filter((target) => old.has(target) !== current.has(target));
  return {
    changedDependencies: changed.slice(0, 20).map((target) => ({
      target,
      state: current.has(target) ? ("added" as const) : ("deleted" as const),
    })),
    ...(changed.length > 20 ? { changedDependenciesOverflow: changed.length - 20 } : {}),
  };
}

/** Observe one source's outgoing edges against all structure members of its Node. */
export function externalStructureDependencies(
  coverage: MaterialCoverage,
  edges: readonly RepositoryImport[],
  files: readonly string[],
  members: ReadonlySet<string>,
): string[] {
  const targets = new Set<string>();
  const isMember = (file: string) => members.has(file);
  for (const edge of edges) {
    if (
      !materialCoverageContains(coverage, edge.from) ||
      !isMember(edge.from) ||
      isTestSource(edge.from)
    )
      continue;
    if (edge.kind === "file") {
      if (isMember(edge.to)) continue;
      const directory = path.posix.dirname(edge.to);
      const sibling = directory === path.posix.dirname(edge.from);
      targets.add(sibling ? edge.to : directory === "." ? "./" : `${directory}/`);
      continue;
    }
    const packageFiles = files.filter(
      (file) => file.endsWith(".go") && !isTestSource(file) && path.posix.dirname(file) === edge.to,
    );
    const covered = packageFiles.filter(isMember);
    if (covered.length && covered.length !== packageFiles.length)
      throw new Error(
        `Structure unavailable: Go package ${edge.to}/ is partly covered by material ${coverage.kind === "prefix" ? `${coverage.prefix}*` : coverage.prefix || "./"}`,
      );
    if (covered.length) continue;
    targets.add(edge.to === "." ? "./" : `${edge.to}/`);
  }
  return [...targets].sort(comparePaths);
}
