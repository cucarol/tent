import fs from "node:fs/promises";
import path from "node:path";
import type { StopMaterialIndex } from "../core/return/stop-material-index.js";
import { workspaceRootFromSystemRoot } from "../core/base/paths.js";
import {
  discoverTentSystemRoot,
  type RejectedRootMarker,
} from "../core/workspace/root-discovery.js";
import { hookIndexDigest, rootMarkerDigest } from "./hook-index-identity.js";

/** Exact prepared bytes only; a marker digest never replaces Core's YAML validation. */
async function readPreparedIndex(
  systemRoot: string,
  workspaceRoot: string,
  marker: Uint8Array,
): Promise<{ index: StopMaterialIndex; rejectedRootMarkers: RejectedRootMarker[] } | undefined> {
  try {
    const cached = JSON.parse(
      await fs.readFile(
        path.join(systemRoot, ".git/tent-material-cache/stop-material-index.json"),
        "utf8",
      ),
    );
    if (
      cached.schema !== 8 ||
      typeof cached.workspaceRoot !== "string" ||
      path.relative(cached.workspaceRoot, workspaceRoot) !== "" ||
      cached.rootMarkerDigest !== rootMarkerDigest(marker) ||
      !Array.isArray(cached.rejectedRootMarkers) ||
      !cached.rejectedRootMarkers.every(
        (marker: RejectedRootMarker) =>
          marker &&
          typeof marker.root === "string" &&
          path.isAbsolute(marker.root) &&
          typeof marker.digest === "string" &&
          /^[a-f0-9]{64}$/.test(marker.digest),
      ) ||
      hookIndexDigest(cached.index, cached.rootMarkerDigest, cached.rejectedRootMarkers) !==
        cached.indexDigest ||
      !Array.isArray(cached.index?.nodes)
    )
      return;
    for (const node of cached.index.nodes) {
      if (
        typeof node.nodeId !== "string" ||
        typeof node.path !== "string" ||
        !Array.isArray(node.names) ||
        !node.names.every((name: unknown) => typeof name === "string") ||
        !Array.isArray(node.moduleCoverage) ||
        !node.moduleCoverage.every(
          (coverage: { kind?: unknown; prefix?: unknown }) =>
            coverage &&
            ["directory", "prefix"].includes(String(coverage.kind)) &&
            typeof coverage.prefix === "string",
        )
      )
        return;
    }
    return { index: cached.index, rejectedRootMarkers: cached.rejectedRootMarkers };
  } catch {
    return;
  }
}

/** Tentative routing is usable only after every preceding marker has a Core rejection proof. */
export async function findPreparedHookWorkspace(cwd: string): Promise<
  | {
      systemRoot: string;
      workspaceRoot: string;
      index: StopMaterialIndex;
    }
  | undefined
> {
  let prepared:
    | {
        systemRoot: string;
        workspaceRoot: string;
        index: StopMaterialIndex;
        rejectedRootMarkers: RejectedRootMarker[];
      }
    | undefined;
  const unverified: RejectedRootMarker[] = [];
  const root = await discoverTentSystemRoot(cwd, async (systemRoot) => {
    let marker: Buffer;
    try {
      marker = await fs.readFile(path.join(systemRoot, "index.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
    if (workspaceRoot) {
      const cached = await readPreparedIndex(systemRoot, workspaceRoot, marker);
      if (cached) {
        prepared = { systemRoot, workspaceRoot, ...cached };
        return true;
      }
    }
    unverified.push({ root: systemRoot, digest: rootMarkerDigest(marker) });
    return false;
  });
  if (!root || prepared?.systemRoot !== root) return;
  // The bytes alone do not authorize skipping a candidate. Core must have rejected
  // those same bytes at that same path and marker-name context during preparation.
  for (const candidate of unverified)
    if (
      !prepared.rejectedRootMarkers.some(
        (proof) =>
          path.relative(proof.root, candidate.root) === "" &&
          proof.digest === candidate.digest &&
          (workspaceRootFromSystemRoot(proof.root) !== undefined) ===
            (workspaceRootFromSystemRoot(candidate.root) !== undefined),
      )
    )
      return;
  return prepared;
}
