import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scaffoldTent } from "../core/store/scaffold.js";
import { TENT_SYSTEM_DIR } from "../core/base/paths.js";
import { NodeFs } from "./node-fs.js";
import { renameWithRetry } from "./rename-with-retry.js";
import { SqliteDocumentHistory } from "../core/store/sqlite-history.js";
import { initializeGitIgnoreContext } from "./git-ignore-context.js";
import { observeTentSystemRoot } from "../core/workspace/status.js";
import { loadStopMaterialIndex } from "./stop-material-index.js";

/** Initialize an empty Tent and its independent SQLite history. */
export async function initializeTentWorkspace(workspaceRoot: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const systemRoot = path.join(root, TENT_SYSTEM_DIR);
  try {
    await fs.lstat(systemRoot);
    throw new Error(`Target already has a Tent system dir: ${TENT_SYSTEM_DIR}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, ".tent-init-"));
  try {
    const adapter = new NodeFs(staging);
    try {
      await scaffoldTent(adapter, { name: path.basename(root) });
      await (adapter.history as SqliteDocumentHistory).initialize();
      await initializeGitIgnoreContext(staging);
    } finally {
      await adapter.close();
    }
    await fs.writeFile(path.join(staging, ".gitignore"), "*\n");
    // Publish a complete, verified Tent. Failed preparation never creates a ready marker.
    await renameWithRetry(staging, systemRoot);
    const discovery = await observeTentSystemRoot(root);
    if (discovery.systemRoot === systemRoot)
      await loadStopMaterialIndex(systemRoot, root, discovery.rejectedRootMarkers);
  } catch (error) {
    if (path.dirname(staging) !== root || !path.basename(staging).startsWith(".tent-init-"))
      throw error;
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
