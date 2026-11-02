import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  checkedSourceFile,
  checkedSourceDirectory,
  initialSourceFile,
} from "./checked-source-file.js";
import {
  materialLocator,
  localMaterialPath,
  isDirectoryMaterial,
  isPrefixMaterial,
} from "../core/base/material.js";
import { markdownMaterialHeading, materialContent } from "../core/base/material-section.js";
import {
  fileState,
  sameFileState,
  withFileReadScope,
  scopedRead,
  peekScopedRead,
  type FileState,
} from "./file-state-cache.js";

export async function readSourceFile(root: string, filename: string) {
  return withFileReadScope(() => readSourceFileInScope(root, filename));
}

/** Validated local UTF-8 text, without a material comparison cache. */
export async function readStructureSource(root: string, filename: string) {
  const observed = await readSourceFile(root, filename);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.bytes);
  if (text.includes("\0")) throw new Error(`Structure source is not valid text: ${filename}`);
  return text;
}

async function readSourceFileInScope(root: string, filename: string) {
  const { canonicalPath } = await initialSourceFile(root, filename);
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true }),
      current = await checkedSourceFile(root, filename, false, true);
    if (!before.isFile() || before.dev !== current.dev || before.ino !== current.ino)
      throw new Error("Material changed while opening");
    const signature = fileState(before);
    let acquired = false;
    const observed = await scopedRead(`bytes:${filename}`, async () => {
      acquired = true;
      const buffer = Buffer.alloc(64 * 1024);
      const chunks: Buffer[] = [];
      let position = 0;
      const prefix = await peekScopedRead<{ bytes?: Buffer; state: FileState }>(
        `prefix-bytes:${filename}`,
      );
      if (prefix?.bytes && sameFileState(prefix.state, signature)) {
        chunks.push(prefix.bytes);
        position = prefix.bytes.length;
      }
      while (position < Number(before.size)) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - position),
          position,
        );
        if (!bytesRead) throw new Error("Material truncated while observing");
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        position += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const final = await checkedSourceFile(root, filename, false, true);
      if (
        !sameFileState(fileState(after), signature) ||
        !sameFileState(fileState(final), signature)
      )
        throw new Error("Material changed while observing");
      return { bytes: Buffer.concat(chunks), state: signature };
    });
    const final = acquired ? before : await checkedSourceFile(root, filename, false, true);
    if (!sameFileState(fileState(final), signature) || !sameFileState(observed.state, signature)) {
      throw new Error("Material changed while observing");
    }
    return { canonicalPath, bytes: observed.bytes };
  } finally {
    await handle.close();
  }
}

/** Explicit addresses only: a check must not guess whether source prose is a file. */
export async function observeMaterialResource(
  workspaceRoot: string,
  documentPath: string,
  resource: string,
): Promise<{
  canonicalPath: string;
  coverage?: true;
}> {
  const locator = materialLocator(resource, documentPath, true);
  const filename = localMaterialPath(locator, workspaceRoot);
  if (filename === undefined)
    throw new Error("Mechanical checks require an explicit local path or file: URI");
  // An absolute file URI explicitly addresses another location. Check every path
  // segment from its filesystem root; relative addresses remain in this workspace.
  const root = locator.kind === "uri" ? path.parse(filename).root : workspaceRoot;
  if (isDirectoryMaterial(locator) || isPrefixMaterial(locator)) {
    const directory = isPrefixMaterial(locator) ? path.dirname(filename) : filename;
    const canonicalDirectory = await checkedSourceDirectory(root, directory);
    return {
      canonicalPath: isPrefixMaterial(locator)
        ? path.join(canonicalDirectory, path.basename(filename))
        : canonicalDirectory,
      coverage: true,
    };
  }
  const heading = markdownMaterialHeading(locator);
  const { canonicalPath } = await initialSourceFile(root, filename);
  if (heading !== undefined) materialContent(await readStructureSource(root, filename), locator);
  return { canonicalPath };
}
