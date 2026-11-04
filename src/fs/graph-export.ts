import { resolvedMaterialOccurrences } from "../core/base/material.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { MUTATION_LOCK_PATH, TEMP_DIR } from "../core/base/paths.js";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import type { FsAdapter } from "../core/store/adapter.js";
import { isHistoryDocument } from "../core/store/document-history.js";
import { renameWithRetry } from "./rename-with-retry.js";

export type GraphExportSource = {
  workspaceRoot: string;
  systemRoot: string;
  workspaceId: string;
  env: { fs: FsAdapter };
};

type EntryKind = "file" | "directory";
const excluded = (relative: string) =>
  [".git/tent-material-cache", MUTATION_LOCK_PATH, TEMP_DIR].includes(relative) ||
  relative.startsWith(`${MUTATION_LOCK_PATH}.`);

async function inventory(root: string) {
  const entries = new Map<string, EntryKind>();
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (excluded(relative)) continue;
      if (entry.isDirectory()) {
        entries.set(relative, "directory");
        await walk(relative);
      } else if (entry.isFile()) entries.set(relative, "file");
      else throw new Error(`Unsupported graph entry: ${relative}`);
    }
  };
  await walk("");
  return entries;
}

/** Materials inside the graph must be there; the others are listed, never copied. */
async function declaredMaterials(adapter: FsAdapter, entries: Map<string, EntryKind>) {
  const owned = new Set<string>();
  const externalNotPacked: Array<{
    documentPath: string;
    field: string;
    index?: number;
    resource: string;
  }> = [];
  const unresolvedMaterials: Array<{
    documentPath: string;
    field?: string;
    index?: number;
    resource?: string;
    error?: string;
  }> = [];
  for (const [file, kind] of entries) {
    // Ordinary files are copied as they are, whatever their directory is called.
    if (kind !== "file" || !isHistoryDocument(file)) continue;
    const { data, body } = parseFrontmatter(await adapter.readFile(file));
    let occurrences: ReturnType<typeof resolvedMaterialOccurrences> = [];
    try {
      occurrences = resolvedMaterialOccurrences(data, file);
    } catch {
      unresolvedMaterials.push({
        documentPath: file,
        error: "Nonstandard material metadata preserved as raw bytes",
      });
    }
    for (const { locator, error, ...occurrence } of occurrences) {
      const declaration = { documentPath: file, ...occurrence };
      if (!locator || locator.kind === "unresolved")
        unresolvedMaterials.push({ ...declaration, ...(error ? { error } : {}) });
      else if (
        locator.kind === "uri" ||
        locator.target === ".." ||
        locator.target.startsWith("../")
      )
        externalNotPacked.push(declaration);
      // Card sources are addresses that take resolves; a moved target is not missing material.
      else if (!file.startsWith("cards/") && locator.target !== ".") owned.add(locator.target);
    }
    const visit = (node: Nodes) => {
      if (
        (node.type === "link" || node.type === "image" || node.type === "definition") &&
        /^https?:\/\//i.test(node.url)
      )
        externalNotPacked.push({ documentPath: file, field: "body", resource: node.url });
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(fromMarkdown(body));
  }
  for (const target of owned)
    if (!entries.has(target)) throw new Error(`Owned material missing from export: ${target}`);
  return { externalNotPacked, unresolvedMaterials };
}

/** 普通目录包保留所有持久原文；不携带机器状态，也不改写源图谱。 */
export async function exportGraph(mount: GraphExportSource, outputDir: string) {
  const destination = path.resolve(mount.workspaceRoot, outputDir);
  const relative = path.relative(mount.workspaceRoot, destination).replaceAll("\\", "/");
  if (!/^(output|\.scratch)\/.+/.test(relative) || relative.split("/").includes(".."))
    throw new Error(
      "Graph export must target a new directory under this Workspace's output/ or .scratch/",
    );
  try {
    await fs.lstat(destination);
    throw new Error("Export destination already exists; use a new directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Writers wait for the copy, so the export is one version of the graph.
  return mount.env.fs.withLock!(MUTATION_LOCK_PATH, async () => {
    const entries = await inventory(mount.systemRoot);
    const materials = await declaredMaterials(mount.env.fs, entries);
    const candidate = path.join(path.dirname(destination), `.tent-export-${randomUUID()}`);
    await fs.mkdir(path.join(candidate, ".tent"), { recursive: true });
    try {
      for (const [file, kind] of entries) {
        const output = path.join(candidate, ".tent", file);
        if (kind === "directory") await fs.mkdir(output, { recursive: true });
        else await fs.copyFile(path.join(mount.systemRoot, file), output);
      }
      await fs.writeFile(
        path.join(candidate, "tent-export.json"),
        JSON.stringify(
          {
            workspaceId: mount.workspaceId,
            createdAt: new Date().toISOString(),
            ...materials,
          },
          null,
          2,
        ) + "\n",
      );
      await renameWithRetry(candidate, destination);
    } catch (error) {
      await fs.rm(candidate, { recursive: true, force: true });
      throw error;
    }
    return {
      workspaceId: mount.workspaceId,
      outputDir: destination,
      manifestPath: path.join(destination, "tent-export.json"),
      fileCount: [...entries.values()].filter((kind) => kind === "file").length,
      externalNotPackedCount: materials.externalNotPacked.length,
    };
  });
}
