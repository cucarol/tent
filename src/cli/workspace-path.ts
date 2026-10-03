import * as path from "node:path";
import { findTentSystemRoot, NOT_INSIDE_TENT_MESSAGE } from "../core/status.js";
import { workspaceRootFromSystemRoot } from "../core/paths.js";
export async function resolveWorkspacePaths(options: {
  cwd?: string;
  workspace?: string;
}): Promise<{ workspaceRoot: string; systemRoot: string }> {
  const start = path.resolve(options.workspace || options.cwd || process.cwd());
  const systemRoot = await findTentSystemRoot(start, options.workspace ? start : undefined);
  if (!systemRoot) {
    throw new Error(
      NOT_INSIDE_TENT_MESSAGE +
        (options.workspace
          ? ` (searched only from --workspace ${start}; parent roots are not used)`
          : ""),
    );
  }
  const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
  if (!workspaceRoot) {
    throw new Error(
      `Tent system root is not an in-workspace .tent layout: ${systemRoot}. ` +
        `Expected <workspace>/.tent/.`,
    );
  }
  return { workspaceRoot: path.resolve(workspaceRoot), systemRoot: path.resolve(systemRoot) };
}
