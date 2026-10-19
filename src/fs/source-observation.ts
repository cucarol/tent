import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { checkedSourceFile } from "./checked-source-file.js";
import {
  materialLocator,
  localMaterialPath,
  isDirectoryMaterial,
  isPrefixMaterial,
} from "../core/base/material.js";
import { observeStructureMaterial } from "./structure-observation.js";
import { markdownMaterialHeading, materialContent } from "../core/base/material-section.js";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import { isNodeId } from "../core/base/id.js";
import { nodeSemanticContent } from "../core/graph/node-sync-record.js";
import { systemMaterialPath } from "../core/graph/material-target.js";
import {
  cachedFileValue,
  fileState,
  sameFileState,
  withFileReadScope,
  scopedRead,
  peekScopedRead,
  rememberFileValue,
  type FileState,
} from "./file-state-cache.js";

type Selection = { key: string; content: (bytes: Buffer) => string | Buffer };
type Fingerprint = { version: string; blobs: { sha1: string; sha256: string } };
function isFingerprint(value: unknown): value is Fingerprint {
  const record = value as Fingerprint | undefined;
  return (
    !!record &&
    typeof record.version === "string" &&
    /^[a-f0-9]{64}$/.test(record.version) &&
    typeof record.blobs?.sha1 === "string" &&
    /^[a-f0-9]{40}$/.test(record.blobs.sha1) &&
    typeof record.blobs?.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.blobs.sha256)
  );
}

/** Safely read and hash bytes; the Core caller supplies any content selection. */
export async function observeSourceFile(
  root: string,
  filename: string,
  cacheDir?: string,
  selection?: Selection,
) {
  return withFileReadScope(() => observeSourceFileInScope(root, filename, cacheDir, selection));
}

async function observeSourceFileInScope(
  root: string,
  filename: string,
  cacheDir?: string,
  selection?: Selection,
) {
  const initial = fileState(await checkedSourceFile(root, filename, false, true));
  const canonicalPath = await realpath(filename);
  const cachePath = cacheDir ? path.join(cacheDir, "file-state.json") : undefined;
  const cacheKey = `material:${JSON.stringify([canonicalPath, selection?.key])}`;
  const cached = await cachedFileValue(cachePath, cacheKey, initial, isFingerprint);
  if (cached) {
    const final = await checkedSourceFile(root, filename, false, true);
    if (!sameFileState(fileState(final), initial))
      throw new Error("Material changed during cache lookup");
    return { canonicalPath, observedVersion: cached.version, cacheHit: true, blobs: cached.blobs };
  }
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
    const bytes = observed.bytes;
    const observedVersion = createHash("sha256")
      .update(selection ? selection.content(bytes) : bytes)
      .digest("hex");
    const blobs = {
      sha1: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      sha256: createHash("sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    };
    await rememberFileValue(cachePath, cacheKey, signature, { version: observedVersion, blobs });
    return {
      canonicalPath,
      observedVersion,
      cacheHit: false,
      blobs,
    };
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
  track?: "structure",
  structureResources?: readonly string[],
): Promise<{
  canonicalPath: string;
  observedVersion?: string;
  coverage?: true;
  cacheHit?: boolean;
  blobs?: { sha1: string; sha256: string };
  structureDependencies?: string[];
}> {
  const locator = materialLocator(resource, documentPath, true);
  const filename = localMaterialPath(locator, workspaceRoot);
  if (filename === undefined)
    throw new Error("Mechanical checks require an explicit local path or file: URI");
  if (track === "structure") {
    return observeStructureMaterial(
      workspaceRoot,
      documentPath,
      resource,
      cacheDir,
      structureResources,
    );
  }
  // An absolute file URI explicitly addresses another location. Check every path
  // segment from its filesystem root; relative addresses remain in this workspace.
  const root = locator.kind === "uri" ? path.parse(filename).root : workspaceRoot;
  if (isDirectoryMaterial(locator) || isPrefixMaterial(locator)) {
    const directory = isPrefixMaterial(locator) ? path.dirname(filename) : filename;
    await checkedSourceFile(root, directory, true);
    const canonicalDirectory = await realpath(directory);
    return {
      canonicalPath: isPrefixMaterial(locator)
        ? path.join(canonicalDirectory, path.basename(filename))
        : canonicalDirectory,
      coverage: true,
    };
  }
  const heading = markdownMaterialHeading(locator);
  return observeSourceFile(root, filename, cacheDir, {
    key: JSON.stringify([
      "semantic-text-v4",
      systemMaterialPath(locator, workspaceRoot) ?? "",
      heading,
    ]),
    content: (bytes) => {
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        if (heading !== undefined) throw error;
        return bytes;
      }
      if (raw.includes("\0")) return bytes;
      const normalized = raw.replace(/\r\n?/g, "\n");
      if (/\.(?:md|markdown)$/i.test(path.extname(filename))) {
        try {
          const parsed = parseFrontmatter(normalized);
          if (typeof parsed.data.id === "string" && isNodeId(parsed.data.id))
            return nodeSemanticContent(
              parsed.data,
              heading === undefined ? parsed.body : materialContent(normalized, locator),
              systemMaterialPath(locator, workspaceRoot) ?? "",
              undefined,
              workspaceRoot,
            );
        } catch {
          // Ordinary Markdown is material text even when its optional YAML is malformed.
        }
      }
      return materialContent(normalized, locator);
    },
  });
}
