import { resolvedMaterialOccurrences, sourcesSchema } from "../core/material.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import * as z from "zod/v4";
import { NodeFs } from "../fs/node-fs.js";
import {
  MUTATION_LOCK_PATH,
  NODE_MOVE_PENDING_PATH,
  DELETE_PENDING_PATH,
  TEMP_DIR,
} from "../core/paths.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { extractAttachmentReferences } from "../markdown/attachment-refs.js";
import { liveContextReader } from "../core/context-reader-factory.js";
import type { FsAdapter } from "../core/adapter.js";
import { verifyCardSourceVersion } from "../core/card-document.js";
import { renameWithRetry } from "./rename-with-retry.js";

export type GraphExportSource = {
  workspaceRoot: string;
  systemRoot: string;
  workspaceId: string;
  env: { fs: FsAdapter };
};

export const graphExportInput = z.strictObject({ outputDir: z.string().min(1) });
type FileEntry =
  | { kind: "file"; path: string; sha256: string; bytes: number }
  | { kind: "directory"; path: string };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const excluded = (relative: string) =>
  /^\.git\/tent-(?:history-index|derived-[a-z0-9-]+)\.json(?:\.[^/]+\.tmp)?$/.test(relative) ||
  relative === ".git/tent-material-cache" ||
  relative.startsWith(".git/tent-material-cache/") ||
  relative === MUTATION_LOCK_PATH ||
  relative.startsWith(`${MUTATION_LOCK_PATH}.`) ||
  relative === TEMP_DIR ||
  relative.startsWith(`${TEMP_DIR}/`);

async function inventory(root: string) {
  const files: FileEntry[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (excluded(relative)) continue;
      if (entry.isSymbolicLink())
        throw new Error(`Graph export cannot follow a symbolic link: ${relative}`);
      if (entry.isDirectory()) {
        files.push({ kind: "directory", path: relative });
        await walk(relative);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(root, relative));
        files.push({ kind: "file", path: relative, sha256: digest(bytes), bytes: bytes.length });
      } else throw new Error(`Unsupported graph entry: ${relative}`);
    }
  };
  await walk("");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function validateMaterial(root: string, workspaceId: string, files: FileEntry[]) {
  const adapter = new NodeFs(root);
  await liveContextReader(adapter, { kind: "live", workspaceId });
  const owned = new Set<string>();
  const directories = new Set<string>();
  type Origin = { kind: "live" };
  const externalMaterials: Array<{
    origin: Origin;
    documentPath: string;
    field: string;
    index?: number;
    resource: string;
  }> = [];
  const unresolvedMaterials: Array<{
    origin: Origin;
    documentPath: string;
    field?: string;
    index?: number;
    resource?: string;
    error?: string;
  }> = [];
  const packed = new Map(files.map((file) => [file.path, file.kind]));
  const collectLinks = (body: string, sourcePath: string) => {
    const visit = (node: Nodes) => {
      if (
        (node.type === "link" || node.type === "image" || node.type === "definition") &&
        /^https?:\/\//i.test(node.url)
      ) {
        externalMaterials.push({
          origin: { kind: "live" },
          documentPath: sourcePath,
          field: "body",
          resource: node.url,
        });
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(fromMarkdown(body));
  };
  const collect = (
    raw: string,
    sourcePath: string,
    origin: Origin,
    gitSources = new Set<number>(),
  ) => {
    const parsed = parseFrontmatter(raw);
    let occurrences: ReturnType<typeof resolvedMaterialOccurrences> = [];
    try {
      occurrences = resolvedMaterialOccurrences(parsed.data, sourcePath);
    } catch {
      unresolvedMaterials.push({
        origin,
        documentPath: sourcePath,
        error: "Nonstandard material metadata preserved as raw bytes",
      });
    }
    for (const { locator, error, ...occurrence } of occurrences) {
      if (
        occurrence.field === "sources" &&
        occurrence.index !== undefined &&
        gitSources.has(occurrence.index)
      )
        continue;
      const declaration = { origin, documentPath: sourcePath, ...occurrence };
      if (!locator || locator.kind === "unresolved") {
        unresolvedMaterials.push({ ...declaration, ...(error ? { error } : {}) });
        continue;
      }
      if (locator.kind === "uri" || locator.target === ".." || locator.target.startsWith("../")) {
        externalMaterials.push(declaration);
        continue;
      }
      const kind = packed.get(locator.target);
      if (kind === "directory" || locator.target === ".") directories.add(locator.target);
      else owned.add(locator.target); // Missing declared bundle files fail the same inventory check.
    }
    for (const ref of extractAttachmentReferences(parsed.body, sourcePath)) owned.add(ref.path);
    collectLinks(parsed.body, sourcePath);
  };
  for (const file of files) {
    if (file.kind !== "file" || !file.path.endsWith(".md") || file.path.startsWith("attachments/"))
      continue;
    const raw = await adapter.readFile(file.path),
      data = parseFrontmatter(raw).data,
      gitSources = new Set<number>();
    if (/^cards\/[^/]+\.md$/.test(file.path)) {
      if (data.type === "card" && data.schemaVersion === 3) {
        const sources = sourcesSchema.parse(data.sources);
        for (let index = 0; index < sources.length; index++) {
          const source = sources[index]!;
          if (source.version === undefined) continue;
          await verifyCardSourceVersion(adapter, file.path, source);
          gitSources.add(index);
        }
      } else throw new Error(`Unsupported Card document: ${file.path}`);
    }
    collect(raw, file.path, { kind: "live" }, gitSources);
  }
  for (const target of owned)
    if (packed.get(target) !== "file")
      throw new Error(`Owned material missing from export: ${target}`);
  for (const target of directories)
    if (!(await fs.stat(path.join(root, target))).isDirectory())
      throw new Error(`Owned material directory missing: ${target}`);
  return { externalNotPacked: externalMaterials, unresolvedMaterials };
}

/** 普通目录包保留所有持久原文；不携带机器状态，也不改写源图谱。 */
export async function exportGraph(mount: GraphExportSource, input: unknown) {
  const { outputDir } = graphExportInput.parse(input);
  const destination = path.resolve(mount.workspaceRoot, outputDir);
  const relative = path.relative(mount.workspaceRoot, destination).replaceAll("\\", "/");
  if (!/^(output|\.scratch)\/.+/.test(relative) || relative.split("/").includes(".."))
    throw new Error(
      "Graph export must target a new directory under this Workspace's output/ or .scratch/",
    );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const parent = await fs.realpath(path.dirname(destination));
  const realRelative = path.relative(mount.workspaceRoot, parent);
  if (
    realRelative === ".." ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  )
    throw new Error("Export parent escapes Workspace");
  try {
    await fs.lstat(destination);
    throw new Error("Export destination already exists; use a new directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const capture = async () => {
    const unportableRecords = (await mount.env.fs.exists(".git/HEAD"))
      ? await mount.env.fs.history?.unportableNodeRecordIds()
      : [];
    if (unportableRecords?.length)
      throw new Error(
        `Workspace export stopped: versioned Node records contain local machine paths (${unportableRecords.join(", ")})`,
      );
    if (await mount.env.fs.exists(NODE_MOVE_PENDING_PATH))
      throw new Error("Finish the pending Node move before exporting");
    if (await mount.env.fs.exists(DELETE_PENDING_PATH))
      throw new Error("Finish the pending deletion before exporting");
    return inventory(mount.systemRoot);
  };
  const locked = <T>(action: () => Promise<T>) =>
    mount.env.fs.withLock!(MUTATION_LOCK_PATH, action);
  const files = await locked(capture);
  const candidate = path.join(parent, `.tent-export-${randomUUID()}`);
  await fs.mkdir(path.join(candidate, ".tent"), { recursive: true });
  try {
    for (const file of files) {
      const output = path.join(candidate, ".tent", file.path);
      if (file.kind === "directory") {
        await fs.mkdir(output, { recursive: true });
        continue;
      }
      const bytes = await fs.readFile(path.join(mount.systemRoot, file.path));
      if (digest(bytes) !== file.sha256)
        throw new Error(`Source changed during export: ${file.path}`);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, bytes);
    }
    const copied = await inventory(path.join(candidate, ".tent"));
    if (JSON.stringify(copied) !== JSON.stringify(files))
      throw new Error("Export byte inventory mismatch");
    const material = await validateMaterial(
      path.join(candidate, ".tent"),
      mount.workspaceId,
      files,
    );
    // Validating retained Card sources may build disposable indexes in the copy.
    const copiedGit = path.join(candidate, ".tent", ".git");
    const gitEntries = await fs.readdir(copiedGit).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of gitEntries)
      if (excluded(`.git/${name}`))
        await fs.rm(path.join(copiedGit, name), { recursive: true, force: true });
    const manifest = {
      schemaVersion: 1,
      workspaceId: mount.workspaceId,
      createdAt: new Date().toISOString(),
      files,
      ...material,
      excluded: [
        "machine state, credentials, launch settings, running sessions",
        "locks and temporary files",
        "disposable .tent/.git/tent-material-cache",
        "disposable Git history indexes",
        "external project/URL bytes",
      ],
      restore: "Use this directory as the same Workspace; external material bytes are not included",
    };
    await fs.writeFile(
      path.join(candidate, "tent-export.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await locked(async () => {
      if (JSON.stringify(await capture()) !== JSON.stringify(files))
        throw new Error("Graph changed before export publication; retry");
      await renameWithRetry(candidate, destination);
    });
    return {
      workspaceId: mount.workspaceId,
      outputDir: destination,
      manifestPath: path.join(destination, "tent-export.json"),
      fileCount: files.filter((file) => file.kind === "file").length,
      externalNotPackedCount: material.externalNotPacked.length,
    };
  } catch (error) {
    // 候选目录由本次调用创建且成果未发布，失败后清除副本。
    if (path.dirname(candidate) !== parent || !path.basename(candidate).startsWith(".tent-export-"))
      throw new Error("Invalid export cleanup path");
    await fs.rm(candidate, { recursive: true, force: true });
    throw error;
  }
}
