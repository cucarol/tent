import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FsAdapter } from "./adapter.js";
import { isTentWorkspacePath, materialCoverageContains } from "./material-coverage.js";
import type { StopMaterialIndex } from "./stop-material-index.js";

/** Compare local URI aliases in the material index's Workspace-relative address domain. */
export function indexedMaterialCovers(
  index: StopMaterialIndex,
  address: string,
  workspaceRoot: string,
): boolean {
  const filename = address.startsWith("file:") ? fileURLToPath(address) : undefined;
  let canonical = address;
  if (filename !== undefined) {
    const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/");
    const outside = relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
    canonical = outside ? pathToFileURL(filename).href : relative;
  }
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  if (isTentWorkspacePath(canonical)) return false;
  return index.nodes.some((node) =>
    node.materials.some((material) =>
      "file" in material
        ? material.file === key
        : materialCoverageContains(
            material.coverage,
            material.scope
              ? filename !== undefined
                ? path.relative(fileURLToPath(material.scope), filename).split(path.sep).join("/")
                : ""
              : canonical,
          ),
    ),
  );
}

/** Only uncovered writes require one batch lookup by a trusted ignore interpreter. */
export async function unlinkedWrittenFiles<T extends { address: string; kind: string }>(
  fs: FsAdapter,
  index: StopMaterialIndex,
  files: readonly T[],
  workspaceRoot: string,
): Promise<T[]> {
  const candidates = files.filter((file) => {
    const address = file.address.startsWith("file:")
      ? path.relative(workspaceRoot, fileURLToPath(file.address)).split(path.sep).join("/")
      : file.address;
    return (
      file.kind === "written" &&
      !isTentWorkspacePath(address) &&
      !indexedMaterialCovers(index, file.address, workspaceRoot)
    );
  });
  if (!candidates.length || !fs.nonignoredFiles) return [];
  const allowed = new Set(
    await fs.nonignoredFiles([...new Set(candidates.map((file) => file.address))]),
  );
  return candidates.filter((file) => allowed.has(file.address));
}
