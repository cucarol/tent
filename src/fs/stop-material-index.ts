import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";
import { NodeFs } from "./node-fs.js";
import { loadNodeCatalog } from "../core/node-catalog.js";
import { buildStopMaterialIndex, type StopMaterialIndex } from "../core/stop-material-index.js";
import {
  isOperationalPath,
  isSystemNoteName,
  nodeNotePath,
  OPERATIONAL_TOP_LEVEL,
} from "../core/paths.js";
import type { FsAdapter } from "../core/adapter.js";

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
      materials: z.array(
        z.union([
          z.strictObject({ coverage: coverageSchema, scope: z.string().optional() }),
          z.strictObject({ file: z.string() }),
        ]),
      ),
      moduleCoverage: z.array(coverageSchema),
    }),
  ),
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Every lookup validates all live header bytes and topology; mtime/HEAD never grant a hit. */
export async function loadStopMaterialIndex(
  systemRoot: string,
  workspaceRoot: string,
): Promise<StopMaterialIndex> {
  const adapter = new NodeFs(systemRoot);
  const directories = new Map<string, Awaited<ReturnType<FsAdapter["listDir"]>>>();
  const headers = new Map<string, string>();
  const filenames: string[] = [];
  const rootEntries = await adapter.listDir("");
  directories.set("", rootEntries);
  const pending = rootEntries
    .filter(
      (entry) => entry.isDir && !isOperationalPath(entry.name) && !isSystemNoteName(entry.name),
    )
    .map((entry) => entry.name);
  while (pending.length) {
    await Promise.all(
      pending.splice(0, 64).map(async (directory) => {
        const entries = await adapter.listDir(directory);
        directories.set(directory, entries);
        const filename = nodeNotePath(directory);
        if (entries.some((entry) => !entry.isDir && entry.name === path.posix.basename(filename)))
          filenames.push(filename);
        for (const entry of entries)
          if (
            entry.isDir &&
            !OPERATIONAL_TOP_LEVEL.has(entry.name) &&
            !isOperationalPath(`${directory}/${entry.name}`)
          )
            pending.push(`${directory}/${entry.name}`);
      }),
    );
  }
  // Complete topology discovery before reading headers so slow document reads
  // cannot hold back the next directory batch. Body size never affects valid headers.
  for (let start = 0; start < filenames.length; start += 64)
    await Promise.all(
      filenames.slice(start, start + 64).map(async (filename) => {
        headers.set(filename, await adapter.readFrontmatter(filename));
      }),
    );
  // Ignore order in this projection: module ordering is by path, ancestry is structural.
  const sourceDigest = hash(
    JSON.stringify([
      [...directories]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([directory, entries]) => [
          directory,
          [...entries].sort((a, b) => a.name.localeCompare(b.name)),
        ]),
      [...headers].sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
  const cacheDir = path.join(systemRoot, ".git", "tent-material-cache");
  const cacheFile = path.join(cacheDir, "stop-material-index.json");
  const hasGit = await fs
    .stat(path.join(systemRoot, ".git"))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (hasGit) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      if (
        cached.schema === 2 &&
        cached.workspaceRoot === workspaceRoot &&
        cached.sourceDigest === sourceDigest &&
        cached.indexDigest === hash(JSON.stringify(cached.index))
      )
        return indexSchema.parse(cached.index);
    } catch {
      /* Disposable cache; a fresh authority scan already succeeded. */
    }
  }
  const snapshot = new Proxy(adapter, {
    get(target, key) {
      if (key === "listDir") return async (directory: string) => directories.get(directory) ?? [];
      if (key === "exists")
        return async (filename: string) => headers.has(filename) || directories.has(filename);
      if (key === "readFile" || key === "readFrontmatter")
        return async (filename: string) => {
          if (!headers.has(filename)) throw new Error(`Stop metadata snapshot lacks ${filename}`);
          return headers.get(filename)!;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const index = buildStopMaterialIndex(await loadNodeCatalog(snapshot), workspaceRoot);
  if (hasGit) {
    const temp = `${cacheFile}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        temp,
        JSON.stringify({
          schema: 2,
          workspaceRoot,
          sourceDigest,
          indexDigest: hash(JSON.stringify(index)),
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
