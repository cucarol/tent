import { isTentWorkspacePath } from "../core/base/material-coverage.js";
import type { AgentContextRepository } from "../core/read/agent-context.js";
import { currentPreparedWorkspace } from "./prepared-workspace.js";
import { readRepositorySources } from "./repository-sources.js";
import { repositoryCommand } from "./repository-command.js";

/** Current file/import evidence does not load the planning or history analyzers. */
export async function readAgentContextRepository(
  workspaceRoot: string,
): Promise<AgentContextRepository> {
  const prepared = currentPreparedWorkspace(workspaceRoot);
  if (prepared) return prepared.repository;
  // ls-files discovers the owning repository and emits Workspace-relative paths.
  const names = await repositoryCommand(workspaceRoot, ["ls-files", "--cached", "-z", "--", "."]);
  const trackedFiles = names.split("\0").filter((file) => file && !isTentWorkspacePath(file));
  return {
    trackedFiles,
    sources: await readRepositorySources(workspaceRoot, trackedFiles, { includeTests: true }),
  };
}
