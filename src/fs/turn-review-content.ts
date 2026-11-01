import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { currentSourceFileIdentity } from "./checked-source-file.js";
import { fileState, sameFileState, withFileReadScope } from "./file-state-cache.js";
import type { StopMaterialIndex } from "../core/return/stop-material-index.js";
import type { TurnReviewModule } from "../core/return/tool-turn-review.js";
import { loadTurnReviewContent } from "../core/return/turn-review-content.js";

/** Selected live bytes, without initializing history, capture, transactions or any cache. */
export function loadHookTurnReviewContent(
  systemRoot: string,
  index: StopMaterialIndex,
  modules: readonly TurnReviewModule[],
  excludedNodeIds?: ReadonlySet<string>,
): Promise<TurnReviewModule[]> {
  const root = path.resolve(systemRoot);
  return loadTurnReviewContent(
    {
      observationScope: (action) => withFileReadScope(action),
      async readFile(relative) {
        const filename = path.resolve(root, relative);
        await currentSourceFileIdentity(root, filename);
        const handle = await fs.open(
          filename,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
          const before = fileState(await handle.stat({ bigint: true }));
          const opened = fileState(await currentSourceFileIdentity(root, filename));
          if (!sameFileState(before, opened)) throw new Error("Node changed while opening");
          const bytes = await handle.readFile();
          const after = fileState(await handle.stat({ bigint: true }));
          const current = fileState(await currentSourceFileIdentity(root, filename));
          if (
            BigInt(bytes.length) !== BigInt(before.size) ||
            !sameFileState(before, after) ||
            !sameFileState(before, current)
          )
            throw new Error("Node changed while reading");
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } finally {
          await handle.close();
        }
      },
    },
    index,
    modules,
    excludedNodeIds,
  );
}
