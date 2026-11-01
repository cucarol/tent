import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { FsAdapter } from "../core/store/adapter.js";
import { checkSelectedNodes } from "../core/check/graph-check.js";
import type { GraphCheckResult } from "../core/check/graph-check.js";
import type { NodeWriteProblem } from "../core/check/node-write-problems.js";
import { isNodeNotePath, nodeNotePath, workspaceRootFromSystemRoot } from "../core/base/paths.js";
import { createTurnPathResolver } from "../core/workspace/git-checkout.js";
import { observeTentSystemRoot } from "../core/workspace/status.js";
import { NodeFs } from "./node-fs.js";

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

/** Native inspection never acquires a mutation boundary or recovers pending writes. */
class NativeNodeCheckFs extends NodeFs {
  override async ready(): Promise<void> {}
}

/** Only successful writes to the discovered root's canonical Node files qualify. */
export async function checkNativeNodeWrites(
  host: "codex" | "claude-code",
  cwd: string,
  files: readonly string[],
): Promise<NodeWriteProblem[]> {
  const { systemRoot } = await observeTentSystemRoot(cwd);
  const workspaceRoot = systemRoot && workspaceRootFromSystemRoot(systemRoot);
  if (!systemRoot || !workspaceRoot) return [];
  const resolver = await createTurnPathResolver(workspaceRoot, cwd);
  const safeRoot = await realpath(systemRoot);
  const paths = new Set<string>();
  for (const file of files) {
    if (!file || /[\u0000-\u001f]/.test(file)) continue;
    const absolute = path.resolve(host === "codex" ? (resolver.checkoutRoot ?? cwd) : cwd, file);
    const relative = await resolver.relative(absolute);
    const address = process.platform === "win32" ? relative?.toLowerCase() : relative;
    if (!relative || !address?.startsWith(".tent/")) continue;
    // A linked checkout, traversal or symlink cannot redirect a write to a different Node.
    const actual = await realpath(absolute).catch(() => undefined);
    if (!actual) continue;
    const observed = path.relative(safeRoot, actual).split(path.sep).join("/");
    const identityAddress = process.platform === "win32" ? observed.toLowerCase() : observed;
    if (observed.startsWith("../") || path.isAbsolute(observed) || !isNodeNotePath(identityAddress))
      continue;
    const expected = await realpath(path.join(systemRoot, relative.slice(6))).catch(
      () => undefined,
    );
    if (!expected || path.relative(actual, expected) !== "") continue;
    // Catalog paths use the directory's spelling and its canonical identity name.
    const canonical =
      process.platform === "win32" ? nodeNotePath(path.posix.dirname(observed)) : observed;
    paths.add(canonical);
  }
  if (!paths.size) return [];
  const adapter = new NativeNodeCheckFs(systemRoot);
  try {
    return await checkNodeWriteProblems(adapter, workspaceRoot, [...paths]);
  } finally {
    await adapter.close();
  }
}
