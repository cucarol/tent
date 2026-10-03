import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { checkedSourceFile } from "./checked-source-file.js";
import { materialLocator, localMaterialPath } from "../core/material.js";

/** Mechanical byte identity only. Material interpretation belongs to the caller's tools. */
export async function observeSourceFile(root: string, filename: string) {
  await checkedSourceFile(root, filename);
  const canonicalPath = await realpath(filename);
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat(),
      current = await checkedSourceFile(root, filename);
    if (!before.isFile() || before.dev !== current.dev || before.ino !== current.ino)
      throw new Error("Material changed while opening");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (!bytesRead) throw new Error("Material truncated while observing");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat(),
      final = await checkedSourceFile(root, filename);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      final.dev !== before.dev ||
      final.ino !== before.ino
    ) {
      throw new Error("Material changed while observing");
    }
    return { canonicalPath, observedVersion: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** Explicit addresses only: a check must not guess whether source prose is a file. */
export async function observeMaterialResource(
  workspaceRoot: string,
  documentPath: string,
  resource: string,
) {
  const locator = materialLocator(resource, documentPath, true);
  const filename = localMaterialPath(locator, workspaceRoot);
  if (filename === undefined)
    throw new Error("Mechanical checks require an explicit local path or file: URI");
  // An absolute file URI explicitly addresses another location. Check every path
  // segment from its filesystem root; relative addresses remain in this workspace.
  const root = locator.kind === "uri" ? path.parse(filename).root : workspaceRoot;
  return observeSourceFile(root, filename);
}
