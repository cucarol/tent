import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";
import { NodeFs } from "./node-fs.js";
import { fileState, stateCacheHit, withFileReadScope } from "./file-state-cache.js";
import { loadNodeCatalog } from "../core/graph/node-catalog.js";
import {
  buildStopMaterialIndex,
  sameStopMaterialHeader,
  type StopMaterialIndex,
} from "../core/return/stop-material-index.js";
import {
  isOperationalPath,
  isSystemNoteName,
  nodeNotePath,
  OPERATIONAL_TOP_LEVEL,
} from "../core/base/paths.js";

const coverageSchema = z.strictObject({
  kind: z.enum(["directory", "prefix"]),
  prefix: z.string(),
});
const indexSchema = z.strictObject({
  nodes: z.array(
    z.strictObject({
      nodeId: z.string(),
      path: z.string(),
      names: z.array(z.string()),
      type: z.string().optional(),
      moduleCoverage: z.array(coverageSchema),
    }),
  ),
});
const integer = z.string().regex(/^-?\d+$/);
const stateSchema = z.strictObject({
  size: integer,
  mtimeNs: integer,
  ctimeNs: integer,
  dev: integer,
  ino: integer,
});
const validSegment = (value: string) =>
  value.length > 0 && !/[\\/]/.test(value) && value !== "." && value !== "..";
const segment = z.string().refine(validSegment);
const relativePath = z
  .string()
  .refine((value) => value === "" || value.split("/").every(validSegment));
const directorySchema = z.strictObject({
  state: stateSchema,
  entries: z.array(z.strictObject({ name: segment, isDir: z.boolean() })),
});
const headerSchema = z.strictObject({ state: stateSchema, content: z.string() });
const cacheSchema = z.strictObject({
  schema: z.literal(6),
  workspaceRoot: z.string(),
  writtenAtNs: z.string().regex(/^\d+$/),
  directories: z.array(z.tuple([relativePath, directorySchema])),
  headers: z.array(z.tuple([relativePath, headerSchema])),
  sourceDigest: z.string(),
  indexDigest: z.string(),
  index: indexSchema,
});
type DirectoryRecord = z.infer<typeof directorySchema>;
type HeaderRecord = z.infer<typeof headerSchema>;
type Cache = z.infer<typeof cacheSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sorted = <T>(records: Map<string, T>) => [...records].sort(([a], [b]) => a.localeCompare(b));

function childDirectories(directory: string, entries: DirectoryRecord["entries"]): string[] {
  return entries
    .filter(
      (entry) =>
        entry.isDir &&
        !OPERATIONAL_TOP_LEVEL.has(entry.name) &&
        !isOperationalPath(directory ? `${directory}/${entry.name}` : entry.name) &&
        (directory !== "" || !isSystemNoteName(entry.name)),
    )
    .map((entry) => (directory ? `${directory}/${entry.name}` : entry.name));
}

async function readCache(cacheFile: string, workspaceRoot: string): Promise<Cache | undefined> {
  try {
    const cached = cacheSchema.parse(JSON.parse(await fs.readFile(cacheFile, "utf8")));
    if (
      cached.workspaceRoot !== workspaceRoot ||
      cached.sourceDigest !== hash([cached.writtenAtNs, cached.directories, cached.headers]) ||
      cached.indexDigest !== hash(cached.index)
    )
      return undefined;
    const directories = new Map(cached.directories),
      headers = new Map(cached.headers);
    if (directories.size !== cached.directories.length || headers.size !== cached.headers.length)
      return undefined;
    // A partial cache must never turn an omitted subtree or header into an authority hit.
    const pending = [""],
      seen = new Set<string>(),
      filenames = new Set<string>();
    while (pending.length) {
      const directory = pending.pop()!;
      const record = directories.get(directory);
      if (
        !record ||
        seen.has(directory) ||
        new Set(record.entries.map((entry) => entry.name)).size !== record.entries.length
      )
        return undefined;
      seen.add(directory);
      if (directory) {
        const filename = nodeNotePath(directory);
        if (
          record.entries.some(
            (entry) => !entry.isDir && entry.name === path.posix.basename(filename),
          )
        )
          filenames.add(filename);
      }
      pending.push(...childDirectories(directory, record.entries));
    }
    if (
      seen.size !== directories.size ||
      filenames.size !== headers.size ||
      [...filenames].some((filename) => !headers.has(filename))
    )
      return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

/** Directory topology and frontmatter are reused only while their file state remains trustworthy. */
export async function loadStopMaterialIndex(
  systemRoot: string,
  workspaceRoot: string,
): Promise<StopMaterialIndex> {
  const adapter = new NodeFs(systemRoot);
  const cacheDir = path.join(systemRoot, ".git", "tent-material-cache");
  const cacheFile = path.join(cacheDir, "stop-material-index.json");
  const hasGit = await fs
    .stat(path.join(systemRoot, ".git"))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  const cached = hasGit ? await readCache(cacheFile, workspaceRoot) : undefined;
  const oldDirectories = new Map(cached?.directories),
    oldHeaders = new Map(cached?.headers);
  const directories = new Map<string, DirectoryRecord>();
  const headers = new Map<string, HeaderRecord>();
  const filenames: string[] = [];
  const pending = [""];
  // Record the beginning of observation, so concurrent writes cannot become old enough
  // to grant a cache hit merely because building the index took a long time.
  const writtenAtNs = String(BigInt(Date.now()) * 1_000_000n);
  let changed = !cached,
    refreshed = !cached;
  while (pending.length) {
    await Promise.all(
      pending.splice(0, 64).map(async (directory) => {
        const stat = await (directory ? fs.lstat : fs.stat)(path.join(systemRoot, directory), {
          bigint: true,
        });
        const state = fileState(stat),
          previous = oldDirectories.get(directory);
        const hit =
          previous &&
          cached &&
          stat.isDirectory() &&
          stateCacheHit(state, previous.state, cached.writtenAtNs);
        // readdir never follows child directory symlinks. Recheck the kind before
        // reusing a directory discovered in an earlier request as well.
        const entries = hit
          ? previous.entries
          : stat.isDirectory()
            ? await adapter.listDir(directory)
            : [];
        if (!hit) {
          refreshed = true;
          if (!previous || hash(entries) !== hash(previous.entries)) changed = true;
        }
        directories.set(directory, { state, entries });
        if (directory) {
          const filename = nodeNotePath(directory);
          if (entries.some((entry) => !entry.isDir && entry.name === path.posix.basename(filename)))
            filenames.push(filename);
        }
        pending.push(...childDirectories(directory, entries));
      }),
    );
  }
  // Finish topology discovery before reading headers so document I/O cannot hold
  // back enumeration. Valid frontmatter reads are independent of body size.
  await withFileReadScope(async () => {
    for (let start = 0; start < filenames.length; start += 64) {
      await Promise.all(
        filenames.slice(start, start + 64).map(async (filename) => {
          const state = fileState(await fs.stat(path.join(systemRoot, filename), { bigint: true }));
          const previous = oldHeaders.get(filename);
          const hit =
            previous && cached && stateCacheHit(state, previous.state, cached.writtenAtNs);
          const observed = hit
            ? { state, content: previous.content }
            : await adapter.readFrontmatterObservation(filename);
          if (!hit) {
            refreshed = true;
            if (!previous || !sameStopMaterialHeader(previous.content, observed.content))
              changed = true;
          }
          headers.set(filename, { state: observed.state, content: observed.content });
        }),
      );
    }
  }, true);
  if (directories.size !== oldDirectories.size || headers.size !== oldHeaders.size) changed = true;
  let index = cached?.index;
  if (changed || !index) {
    const snapshot = new Proxy(adapter, {
      get(target, key) {
        if (key === "listDir")
          return async (directory: string) => directories.get(directory)?.entries ?? [];
        if (key === "exists")
          return async (filename: string) => headers.has(filename) || directories.has(filename);
        if (key === "readFile" || key === "readFrontmatter")
          return async (filename: string) => {
            if (!headers.has(filename)) throw new Error(`Stop metadata snapshot lacks ${filename}`);
            return headers.get(filename)!.content;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    index = buildStopMaterialIndex(await loadNodeCatalog(snapshot), workspaceRoot);
  }
  if (hasGit && refreshed) {
    const temp = `${cacheFile}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    const directoryRecords = sorted(directories),
      headerRecords = sorted(headers);
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        temp,
        JSON.stringify({
          schema: 6,
          workspaceRoot,
          writtenAtNs,
          directories: directoryRecords,
          headers: headerRecords,
          sourceDigest: hash([writtenAtNs, directoryRecords, headerRecords]),
          indexDigest: hash(index),
          index,
        }),
      );
      await fs.rename(temp, cacheFile);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return index;
}
