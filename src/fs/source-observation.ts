import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  materialLocator,
  localMaterialPath,
  isDirectoryMaterial,
  isPrefixMaterial,
} from "../core/base/material.js";
import { markdownMaterialHeading, materialContent } from "../core/base/material-section.js";
import { scopedRead } from "./file-state-cache.js";

/** A device or pipe would never finish reading, so a material must be a regular file. */
async function requireRegularFile(filename: string) {
  if (!(await stat(filename)).isFile()) throw new Error("Source target is not a regular file");
}

/** Local UTF-8 text of a material. */
export async function readStructureSource(filename: string) {
  await requireRegularFile(filename);
  const bytes = await scopedRead(`source-bytes:${filename}`, () => readFile(filename));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes("\0")) throw new Error(`Structure source is not valid text: ${filename}`);
  return text;
}

/** Explicit addresses only: a check must not guess whether source prose is a file. */
export async function observeMaterialResource(
  workspaceRoot: string,
  documentPath: string,
  resource: string,
): Promise<void> {
  const locator = materialLocator(resource, documentPath, true);
  const filename = localMaterialPath(locator, workspaceRoot);
  if (filename === undefined)
    throw new Error("Mechanical checks require an explicit local path or file: URI");
  if (isDirectoryMaterial(locator) || isPrefixMaterial(locator)) {
    const directory = isPrefixMaterial(locator) ? path.dirname(filename) : filename;
    if (!(await stat(directory)).isDirectory()) throw new Error("Source target is not a directory");
    return;
  }
  await requireRegularFile(filename);
  if (markdownMaterialHeading(locator) !== undefined)
    materialContent(await readStructureSource(filename), locator);
}
