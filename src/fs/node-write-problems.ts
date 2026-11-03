import { stat } from "node:fs/promises";
import type { FsAdapter } from "../core/store/adapter.js";
import { checkSelectedNodes } from "../core/check/graph-check.js";
import type { GraphCheckResult } from "../core/check/graph-check.js";
import type { NodeWriteProblem } from "../core/check/node-write-problems.js";
import { isNodeNotePath } from "../core/base/paths.js";

/** Read-only diagnostics of the documents this mutation actually wrote. */
export async function checkNodeWriteProblems(
  fs: FsAdapter,
  workspaceRoot: string,
  paths: readonly string[],
): Promise<NodeWriteProblem[]> {
  const selected = [...new Set(paths.filter(isNodeNotePath))];
  if (!selected.length) return [];
  let checked: GraphCheckResult;
  try {
    checked = await checkSelectedNodes(
      fs,
      workspaceRoot,
      async (filename, directory = false) => {
        try {
          const info = await stat(filename);
          return directory ? info.isDirectory() : info.isFile();
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return false;
          throw error;
        }
      },
      selected,
    );
  } catch (cause) {
    // Diagnostics are advisory after the save has succeeded. Keep an observation
    // failure attached to its written documents instead of reporting a failed save.
    const reason = cause instanceof Error ? cause.message : String(cause);
    return selected.map((file) => ({ category: "error", path: `.tent/${file}`, reason }));
  }
  return [
    ...checked.issues.map((issue) => ({
      ...issue,
      category: "issue" as const,
      path: `.tent/${issue.path}`,
    })),
    ...checked.errors.map((error) => ({
      ...error,
      category: "error" as const,
      path: `.tent/${error.path}`,
    })),
    ...checked.notices.map((notice) => ({
      ...notice,
      category: "notice" as const,
      path: `.tent/${notice.path}`,
    })),
  ];
}
