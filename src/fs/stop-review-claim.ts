import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { StopHost } from "../core/stop-turn-review.js";

function claimPath(systemRoot: string, host: StopHost, sessionId: string, turnId: string) {
  const key = createHash("sha256")
    .update(JSON.stringify([host, sessionId, turnId]))
    .digest("hex");
  return path.join(systemRoot, "temp", "stop-reviews", `${key}.claim`);
}

export async function hasStopReviewClaim(
  systemRoot: string,
  host: StopHost,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  try {
    await fs.access(claimPath(systemRoot, host, sessionId, turnId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** One exclusive per-turn claim, no global lock or retry. A crash can lose a review, never repeat it. */
export async function claimStopReview(
  systemRoot: string,
  host: StopHost,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const directory = path.join(systemRoot, "temp", "stop-reviews");
  await fs.mkdir(directory, { recursive: true });
  try {
    const handle = await fs.open(claimPath(systemRoot, host, sessionId, turnId), "wx");
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
