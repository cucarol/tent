import path from "node:path";
import { isHookGraphFile, workspaceRootFromSystemRoot } from "../core/base/paths.js";
import { createTurnPathResolver } from "../core/workspace/git-checkout.js";
import { observeTentSystemRoot } from "../core/workspace/status.js";
import { loadStopMaterialIndex } from "./stop-material-index.js";
import { NodeFs } from "./node-fs.js";

/** This advisory path never performs the owning command's transaction recovery. */
class NativeGraphIndexFs extends NodeFs {
  override async ready(): Promise<void> {}
}

/** Only an explicit successful native graph write enters this authoritative path. */
export async function refreshNativeHookIndex(
  host: "codex" | "claude-code",
  cwd: string,
  files: readonly string[],
): Promise<boolean> {
  const discovery = await observeTentSystemRoot(cwd);
  const systemRoot = discovery.systemRoot;
  const workspaceRoot = systemRoot && workspaceRootFromSystemRoot(systemRoot);
  if (!systemRoot || !workspaceRoot) return false;
  const resolver = await createTurnPathResolver(workspaceRoot, cwd);
  for (const file of files) {
    if (!file || /[\u0000-\u001f]/.test(file)) continue;
    const relative = await resolver.relative(
      path.resolve(host === "codex" ? (resolver.checkoutRoot ?? cwd) : cwd, file),
    );
    const address = process.platform === "win32" ? relative?.toLowerCase() : relative;
    if (address?.startsWith(".tent/") && isHookGraphFile(address.slice(6))) {
      const adapter = new NativeGraphIndexFs(systemRoot);
      try {
        await loadStopMaterialIndex(
          systemRoot,
          workspaceRoot,
          discovery.rejectedRootMarkers,
          adapter,
        );
        return true;
      } catch {
        // A pending transaction or acquisition failure is unknown. Do not remove
        // another publisher's valid cache, or use stale coverage for this event.
        return false;
      } finally {
        await adapter.close();
      }
    }
  }
  return true;
}
