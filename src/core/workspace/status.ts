import * as fs from "node:fs/promises";
import * as path from "node:path";
import { INDEX_PATH } from "../base/paths.js";
import { isValidTentIndexMarker } from "../store/scaffold.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import {
  discoverTentSystemRoot,
  rootMarkerDigest,
  type RejectedRootMarker,
} from "./root-discovery.js";

export const NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/index.md marker found).";

/**
 * 定位 tent system root：
 * 1. cwd 本身是 system root（含 index.md marker）
 * 2. cwd 下有 `.tent/` system dir（workspace 根）
 * 3. 向上查找（兼容从子目录调用）
 */
export async function findTentSystemRoot(
  cwd = process.cwd(),
  stopAt?: string,
): Promise<string | undefined> {
  return (await observeTentSystemRoot(cwd, stopAt)).systemRoot;
}

/** Preserve the normal parser/routing result and expose only markers it actually rejected. */
export async function observeTentSystemRoot(
  cwd = process.cwd(),
  stopAt?: string,
): Promise<{
  systemRoot: string | undefined;
  rejectedRootMarkers: RejectedRootMarker[];
}> {
  const rejectedRootMarkers: RejectedRootMarker[] = [];
  const systemRoot = await discoverTentSystemRoot(
    cwd,
    async (root) => {
      let marker: Buffer | undefined;
      try {
        marker = await fs.readFile(path.join(root, INDEX_PATH));
        const raw = marker.toString("utf8");
        if (
          isValidTentIndexMarker(raw) &&
          (path.basename(root) === ".tent" || parseFrontmatter(raw).data.okf_version === "0.2")
        )
          return true;
      } catch {
        /* Normal discovery rejects unavailable or malformed markers. */
      }
      if (marker) rejectedRootMarkers.push({ root, digest: rootMarkerDigest(marker) });
      return false;
    },
    stopAt,
  );
  return { systemRoot, rejectedRootMarkers };
}
