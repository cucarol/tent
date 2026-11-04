import path from "node:path";
import type { NodeFs } from "./node-fs.js";
import { loadNodeCatalog } from "../core/graph/node-catalog.js";
import { buildStopCoverageIndex, type StopCoverageIndex } from "../core/return/stop-coverage.js";
import { MUTATION_LOCK_PATH } from "../core/base/paths.js";
import { withMutationLock } from "./file-lock.js";

/** Scan only the Node topology and its headers. No repository or source population is observed. */
export function loadStopCoverage(
  systemRoot: string,
  workspaceRoot: string,
  adapter: NodeFs,
): Promise<StopCoverageIndex> {
  return adapter.observationScope(() =>
    // Another session's move must not show this listing a half-moved tree.
    withMutationLock(path.join(systemRoot, MUTATION_LOCK_PATH), async () =>
      buildStopCoverageIndex(await loadNodeCatalog(adapter), systemRoot, workspaceRoot),
    ),
  );
}
