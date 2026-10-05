import { constants } from "node:fs";
import { open, realpath, readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { checkedSourceFile } from "./checked-source-file.js";
import { materialLocator, localMaterialPath } from "../core/material.js";
import { markdownMaterialHeading, materialContent } from "../core/material-section.js";

/** Safely read and hash bytes; the Core caller supplies any content selection. */
export async function observeSourceFile(
  root: string,
  filename: string,
  cacheDir?: string,
  selection?: { key: string; content: (bytes: Buffer) => string },
) {
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
    const signature = {
      size: before.size,
      mtime: before.mtimeMs,
      ctime: before.ctimeMs,
      dev: before.dev,
      ino: before.ino,
    };
    const cachePath = cacheDir
      ? path.join(
          cacheDir,
          createHash("sha256")
            .update(selection ? JSON.stringify([canonicalPath, selection.key]) : canonicalPath)
            .digest("hex") + ".json",
        )
      : undefined;
    if (cachePath) {
      const cached = await readFile(cachePath, "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      const after = await handle.stat();
      if (
        cached &&
        JSON.stringify(cached.signature) === JSON.stringify(signature) &&
        /^[a-f0-9]{64}$/.test(cached.version) &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs
      ) {
        const final = await checkedSourceFile(root, filename);
        if (final.dev !== before.dev || final.ino !== before.ino)
          throw new Error("Material changed during cache lookup");
        return { canonicalPath, observedVersion: cached.version as string, cacheHit: true };
      }
    }
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (!bytesRead) throw new Error("Material truncated while observing");
      if (selection) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      else hash.update(buffer.subarray(0, bytesRead));
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
    if (selection) hash.update(selection.content(Buffer.concat(chunks)));
    const observedVersion = hash.digest("hex");
    if (cachePath) {
      const temp = `${cachePath}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await mkdir(cacheDir!, { recursive: true });
        await writeFile(temp, JSON.stringify({ signature, version: observedVersion }));
        await rename(temp, cachePath);
      } catch {
        await rm(temp, { force: true }).catch(() => undefined);
      }
    }
    return { canonicalPath, observedVersion, cacheHit: false };
  } finally {
    await handle.close();
  }
}

/** Explicit addresses only: a check must not guess whether source prose is a file. */
export async function observeMaterialResource(
  workspaceRoot: string,
  documentPath: string,
  resource: string,
  cacheDir?: string,
) {
  const locator = materialLocator(resource, documentPath, true);
  const filename = localMaterialPath(locator, workspaceRoot);
  if (filename === undefined)
    throw new Error("Mechanical checks require an explicit local path or file: URI");
  // An absolute file URI explicitly addresses another location. Check every path
  // segment from its filesystem root; relative addresses remain in this workspace.
  const root = locator.kind === "uri" ? path.parse(filename).root : workspaceRoot;
  const heading = markdownMaterialHeading(locator);
  return observeSourceFile(
    root,
    filename,
    cacheDir,
    heading === undefined
      ? undefined
      : {
          key: JSON.stringify(["markdown-section", heading]),
          content: (bytes) =>
            materialContent(
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
              locator,
            ),
        },
  );
}
