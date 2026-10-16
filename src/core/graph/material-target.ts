import path from "node:path";
import type { FsAdapter } from "../store/adapter.js";
import { isHistoryDocument } from "../store/document-history.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { nodeNotePath } from "../base/paths.js";
import { parseRoleDocument } from "../store/role-document.js";
import { parseCardDocument } from "./card-document.js";
import {
  isDirectoryMaterial,
  isPrefixMaterial,
  localMaterialPath,
  MaterialAddressError,
  materialFields,
  materialLocator,
  materialOccurrences,
  type MaterialLocator,
} from "../base/material.js";

export const SYSTEM_MATERIAL_MESSAGE =
  "Materials must point to Workspace files, or Node, Role, Card documents";

/** Resolve both address forms against the same local .tent boundary. */
export function systemMaterialPath(
  locator: MaterialLocator,
  workspaceRoot?: string,
): string | undefined {
  if (locator.kind === "path" && !workspaceRoot)
    return locator.target === ".." || locator.target.startsWith("../") ? undefined : locator.target;
  if (!workspaceRoot) return undefined;
  let filename: string | undefined;
  try {
    filename = localMaterialPath(locator, workspaceRoot);
  } catch (error) {
    // A file URI for another host has no local .tent identity.
    if (locator.kind === "uri") return undefined;
    throw error;
  }
  if (filename === undefined) return undefined;
  const relative = path.relative(path.join(workspaceRoot, ".tent"), filename);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : relative.split(path.sep).join("/") || ".";
}

/** Internal ordinary files never become material; native documents keep their own protocol. */
export async function assertSystemMaterial(
  fs: FsAdapter,
  locator: MaterialLocator,
  nodePaths?: ReadonlySet<string>,
): Promise<void> {
  const file = systemMaterialPath(locator, fs.workspaceRoot);
  if (file === undefined) return;
  if (isDirectoryMaterial(locator) || isPrefixMaterial(locator) || !isHistoryDocument(file))
    throw new MaterialAddressError(SYSTEM_MATERIAL_MESSAGE);
  if (nodePaths?.has(file)) return;
  try {
    if (file.startsWith("roles/")) {
      parseRoleDocument(path.posix.basename(file, ".md"), await fs.readFile(file));
      return;
    }
    if (file.startsWith("cards/")) {
      parseCardDocument(path.posix.basename(file, ".md"), await fs.readFile(file));
      return;
    }
    const nodes =
      nodePaths ??
      new Set(
        [...(await loadNodeCatalog(fs)).byId.values()]
          .filter((node) => !node.invalid)
          .map((node) => nodeNotePath(node.path)),
      );
    if (nodes.has(file)) return;
  } catch {
    // An unrecognized or malformed document does not grant a material exception.
  }
  throw new MaterialAddressError(SYSTEM_MATERIAL_MESSAGE);
}

/** Retained invalid declarations remain editable; only newly declared occurrences are checked. */
export async function validateSystemMaterials(
  fs: FsAdapter,
  data: Record<string, unknown>,
  documentPath: string,
  previous: Record<string, unknown> = {},
  nodePaths?: ReadonlySet<string>,
): Promise<void> {
  const retained = new Map<string, number>();
  for (const source of materialFields(previous).sources ?? [])
    retained.set(source.resource, (retained.get(source.resource) ?? 0) + 1);
  for (const occurrence of materialOccurrences(data)) {
    if (occurrence.field === "resource" && occurrence.resource === previous.resource) continue;
    if (occurrence.field === "sources") {
      const count = retained.get(occurrence.resource) ?? 0;
      if (count) {
        retained.set(occurrence.resource, count - 1);
        continue;
      }
    }
    const locator = materialLocator(
      occurrence.resource,
      documentPath,
      occurrence.field === "sources",
    );
    try {
      await assertSystemMaterial(fs, locator, nodePaths);
    } catch (error) {
      const field =
        occurrence.field === "resource" ? "resource" : `sources[${occurrence.index}].resource`;
      throw new MaterialAddressError(
        `Invalid ${field}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
