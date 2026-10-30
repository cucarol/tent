import fs from "node:fs/promises";
import path from "node:path";
import { createTurnPathResolver, readGitCheckout } from "../core/workspace/git-checkout.js";
import { turnDirtyPaths } from "../core/return/turn-changes.js";
import { readTurnDirty, saveTurnDirty, turnDirtyPath } from "./turn-review-state.js";
import { withFileLockGuard } from "./file-lock-guard.js";

/** Keep the previous list, status observation and publication in one ordered transaction. */
export async function observeTurnDirty(
  systemRoot: string,
  checkout: string,
  host: string,
  session: string,
) {
  const record = turnDirtyPath(systemRoot, host, session, checkout);
  await fs.mkdir(path.dirname(record), { recursive: true });
  return withFileLockGuard(
    record,
    async () => {
      const previous = await readTurnDirty(systemRoot, host, session, checkout);
      const status = await turnDirtyPaths(checkout);
      await saveTurnDirty(
        systemRoot,
        host,
        session,
        checkout,
        status.paths.map((item) => item.address),
      );
      return { previous, status };
    },
    { flush: false },
  );
}

/** SessionStart's deletion baseline is independent of graph capture and section fingerprints. */
export async function seedSessionTurnDirty(
  systemRoot: string,
  workspaceRoot: string,
  cwd: string,
  host: string,
  session: string,
): Promise<void> {
  const checkout = (await createTurnPathResolver(workspaceRoot, cwd)).checkoutRoot;
  if (!checkout || !(await readGitCheckout(checkout))) return;
  await observeTurnDirty(systemRoot, checkout, host, session);
}
