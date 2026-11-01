import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";
import {
  isOperationalPath,
  isSystemNoteName,
  nodeNotePath,
  OPERATIONAL_TOP_LEVEL,
  MUTATION_LOCK_PATH,
} from "../core/base/paths.js";
import { rootMarkerDigest, hookIndexDigest } from "./hook-index-identity.js";
import { fileState, stateCacheHit } from "./file-state-cache.js";
import {
  validateRepositoryObservation,
  type PreparedRepositoryObservation,
} from "./prepared-repository.js";
import { isPreparedWorkspace, type PreparedWorkspace } from "./prepared-workspace.js";

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
      ruleNodeIds: z.array(z.string()),
      headerDigest: z.string().regex(/^[a-f0-9]{64}$/),
      moduleCoverage: z.array(coverageSchema),
      materialFiles: z.array(z.strictObject({ path: z.string(), heading: z.string().optional() })),
      moduleMaterials: z.array(coverageSchema),
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
const headerSchema = z.strictObject({
  state: stateSchema,
  content: z.string(),
  raw: z.string().optional(),
});
const cacheSchema = z.strictObject({
  // Schema 12's derived membership treated draft Nodes as inactive.
  schema: z.literal(13),
  rootMarkerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rejectedRootMarkers: z.array(
    z.strictObject({ root: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
  workspaceRoot: z.string(),
  writtenAtNs: z.string().regex(/^\d+$/),
  directories: z.array(z.tuple([relativePath, directorySchema])),
  headers: z.array(z.tuple([relativePath, headerSchema])),
  repository: z.unknown().optional(),
  sourceDigest: z.string(),
  indexDigest: z.string(),
  index: indexSchema,
});
export type DirectoryRecord = z.infer<typeof directorySchema>;
export type HeaderRecord = z.infer<typeof headerSchema>;
type Cache = z.infer<typeof cacheSchema>;
export type PreparedGraphSnapshot = {
  writtenAtNs: string;
  directories: Map<string, DirectoryRecord>;
  headers: Map<string, HeaderRecord>;
  repository?: PreparedRepositoryObservation<PreparedWorkspace>;
};
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sorted = <T>(records: Map<string, T>) =>
  [...records].sort(([a], [b]) => a.localeCompare(b));

export function childDirectories(directory: string, entries: DirectoryRecord["entries"]): string[] {
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

export async function readCache(
  cacheFile: string,
  workspaceRoot: string,
): Promise<Cache | undefined> {
  try {
    const cached = cacheSchema.parse(JSON.parse(await fs.readFile(cacheFile, "utf8")));
    if (
      cached.workspaceRoot !== workspaceRoot ||
      cached.sourceDigest !==
        hash([
          cached.writtenAtNs,
          cached.directories,
          cached.headers,
          cached.rootMarkerDigest,
          cached.rejectedRootMarkers,
          cached.repository ?? null,
        ]) ||
      cached.indexDigest !==
        hookIndexDigest(cached.index, cached.rootMarkerDigest, cached.rejectedRootMarkers)
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

/** Reuse the Hook's graph observations only under its existing state/age rule. */
export async function preparedGraphSnapshot(
  systemRoot: string,
  workspaceRoot: string,
): Promise<PreparedGraphSnapshot | undefined> {
  const cached = await readCache(
    path.join(systemRoot, ".git/tent-material-cache/stop-material-index.json"),
    workspaceRoot,
  );
  if (!cached) return;
  try {
    const marker = await fs.readFile(path.join(systemRoot, "index.md"));
    if (rootMarkerDigest(marker) !== cached.rootMarkerDigest) return;
    const records = [
      ...cached.directories.map(([file, record]) => ({
        file,
        state: record.state,
        directory: true,
      })),
      // Each header/body hit rechecks its own leaf state in NodeFs. Topology
      // validation here must not replace that later current-path check.
    ];
    for (let offset = 0; offset < records.length; offset += 64) {
      const valid = await Promise.all(
        records.slice(offset, offset + 64).map(async (record) => {
          const stat = await fs.lstat(path.join(systemRoot, record.file), { bigint: true });
          if (!(record.directory ? stat.isDirectory() : stat.isFile())) return false;
          if (stateCacheHit(fileState(stat), record.state, cached.writtenAtNs)) return true;
          if (!record.directory) return false;
          // Acquiring/releasing the writer lock changes the root directory's
          // metadata. Reobserve its entries rather than trusting that metadata
          // or invalidating an otherwise unchanged Node topology forever.
          const entries = (
            await fs.readdir(path.join(systemRoot, record.file), { withFileTypes: true })
          )
            .filter((entry) => !entry.name.startsWith(".git"))
            .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }));
          const relevant = (items: DirectoryRecord["entries"]) =>
            items
              .filter((entry) => record.file !== "" || entry.name !== MUTATION_LOCK_PATH)
              .sort((a, b) => a.name.localeCompare(b.name));
          return (
            hash(relevant(entries)) ===
            hash(relevant(new Map(cached.directories).get(record.file)!.entries))
          );
        }),
      );
      if (valid.some((ok) => !ok)) return;
    }
    const repository = cached.repository as
      PreparedRepositoryObservation<PreparedWorkspace> | undefined;
    const reusable =
      repository &&
      isPreparedWorkspace(repository.value) &&
      (await validateRepositoryObservation(workspaceRoot, repository));
    return {
      writtenAtNs: cached.writtenAtNs,
      directories: new Map(cached.directories),
      headers: new Map(cached.headers),
      ...(reusable ? { repository } : {}),
    };
  } catch {
    return;
  }
}
