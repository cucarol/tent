import { createHash } from "node:crypto";
import type { StopMaterialIndex } from "../core/return/stop-material-index.js";
import type { RejectedRootMarker } from "../core/workspace/root-discovery.js";
export { rootMarkerDigest } from "../core/workspace/root-discovery.js";

export const hookIndexDigest = (
  index: StopMaterialIndex,
  markerDigest: string,
  rejected: readonly RejectedRootMarker[],
) =>
  createHash("sha256")
    .update(JSON.stringify([markerDigest, rejected, index]))
    .digest("hex");
