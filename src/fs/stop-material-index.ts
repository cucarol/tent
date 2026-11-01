import * as fs from "node:fs/promises";
import path from "node:path";
import type { RejectedRootMarker } from "../core/workspace/root-discovery.js";
import { workspaceRootFromSystemRoot } from "../core/base/paths.js";
import { isValidTentIndexMarker } from "../core/store/scaffold.js";
import { rootMarkerDigest, hookIndexDigest } from "./hook-index-identity.js";
import { NodeFs } from "./node-fs.js";
import { fileState, stateCacheHit, withFileReadScope } from "./file-state-cache.js";
import { loadNodeCatalog } from "../core/graph/node-catalog.js";
import {
  buildStopMaterialIndex,
  sameStopMaterialHeader,
  type StopMaterialIndex,
} from "../core/return/stop-material-index.js";
import { nodeNotePath, MUTATION_LOCK_PATH } from "../core/base/paths.js";
import { TRANSACTION_PATH } from "../core/store/file-transaction.js";
import { withFileMutationLock } from "./mutation-lock.js";
import { turnReviewHeaderDigest } from "../core/return/turn-review-document.js";
import {
  prepareRepositoryObservation,
  validateRepositoryObservation,
  type PreparedRepositoryObservation,
} from "./prepared-repository.js";
import { isPreparedWorkspace, type PreparedWorkspace } from "./prepared-workspace.js";
import { readAgentContextRepository } from "./agent-context-repository.js";
import { sourceDirectoryPaths } from "./directory-observation.js";
import { readStructureSource, observeMaterialResource } from "./source-observation.js";
import { materialOccurrences, materialLocator, localMaterialPath } from "../core/base/material.js";
import { parseFrontmatter } from "../core/base/frontmatter.js";
import { isImportSource, isImportConfig } from "../core/base/repository-imports.js";
import {
  childDirectories,
  hash,
  readCache,
  sorted,
  type DirectoryRecord,
  type HeaderRecord,
} from "./prepared-graph.js";
export { preparedGraphSnapshot, type PreparedGraphSnapshot } from "./prepared-graph.js";

/** Directory topology and frontmatter are reused only while their file state remains trustworthy. */
export async function loadStopMaterialIndex(
  systemRoot: string,
  workspaceRoot: string,
  rejectedMarkers: readonly RejectedRootMarker[] = [],
  adapter = new NodeFs(systemRoot),
): Promise<StopMaterialIndex> {
  // ready/recovery belongs before acquisition. The existing observation scope
  // bypasses it while all graph reads and cache publication share the writer lock.
  return adapter.observationScope(
    () =>
      withFileMutationLock(
        path.join(systemRoot, MUTATION_LOCK_PATH),
        async () => {
          await fs.access(path.join(systemRoot, TRANSACTION_PATH)).then(
            () => {
              throw new Error("Tent transaction is pending");
            },
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
          return loadStopMaterialIndexUnlocked(systemRoot, workspaceRoot, rejectedMarkers, adapter);
        },
        {
          waitMs: 8_000,
          busyMessage:
            "Tent mutation lock is still busy after waiting 8 seconds; wait for the other write to finish, then reread before retrying.",
          acquireFailedMessage: "Cannot acquire the Tent mutation lock.",
        },
      ),
    { forceContent: true },
  );
}

async function loadStopMaterialIndexUnlocked(
  systemRoot: string,
  workspaceRoot: string,
  rejectedMarkers: readonly RejectedRootMarker[],
  adapter: NodeFs,
): Promise<StopMaterialIndex> {
  const marker = await fs.readFile(path.join(systemRoot, "index.md"));
  if (!isValidTentIndexMarker(marker.toString("utf8")))
    throw new Error("Invalid Tent index marker");
  const markerDigest = rootMarkerDigest(marker);
  const cacheDir = path.join(systemRoot, ".git", "tent-material-cache");
  const cacheFile = path.join(cacheDir, "stop-material-index.json");
  const hasGit = await fs
    .stat(path.join(systemRoot, ".git"))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  const cached = hasGit ? await readCache(cacheFile, workspaceRoot) : undefined;
  const rejectionKey = (root: string) =>
    JSON.stringify([
      process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root),
      workspaceRootFromSystemRoot(root) !== undefined,
    ]);
  const rejections = new Map<string, RejectedRootMarker>(
    cached?.rejectedRootMarkers.map((marker) => [rejectionKey(marker.root), marker]),
  );
  for (const marker of rejectedMarkers) rejections.set(rejectionKey(marker.root), marker);
  const rejectedRootMarkers = [...rejections.values()].sort((a, b) => a.root.localeCompare(b.root));
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
    refreshed =
      !cached ||
      cached.rootMarkerDigest !== markerDigest ||
      hash(cached.rejectedRootMarkers) !== hash(rejectedRootMarkers);
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
            ? { ...previous, state }
            : await (async () => {
                const raw = await adapter.readFile(filename);
                return { ...(await adapter.readFrontmatterObservation(filename)), raw };
              })();
          if (!hit) {
            refreshed = true;
            if (!previous || !sameStopMaterialHeader(previous.content, observed.content))
              changed = true;
          }
          headers.set(filename, {
            state: observed.state,
            content: observed.content,
            ...(observed.raw === undefined ? {} : { raw: observed.raw }),
          });
        }),
      );
    }
  }, true);
  if (directories.size !== oldDirectories.size || headers.size !== oldHeaders.size) changed = true;
  let index: StopMaterialIndex | undefined = cached?.index;
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
  } else if (refreshed) {
    // Provenance-only changes retain membership, but Hooks need the current header identity.
    index = {
      nodes: index.nodes.map((node) => ({
        ...node,
        headerDigest: turnReviewHeaderDigest(
          headers.get(node.path.slice(".tent/".length))!.content,
        ),
      })),
    };
  }
  let repository = cached?.repository as
    PreparedRepositoryObservation<PreparedWorkspace> | undefined;
  if (
    !repository ||
    !isPreparedWorkspace(repository.value) ||
    !(await validateRepositoryObservation(workspaceRoot, repository))
  ) {
    repository = await prepareRepositoryObservation(workspaceRoot, async () => {
      const [facts, live, tracked] = await Promise.all([
        readAgentContextRepository(workspaceRoot),
        sourceDirectoryPaths(workspaceRoot, workspaceRoot, cacheDir),
        sourceDirectoryPaths(workspaceRoot, workspaceRoot, cacheDir, true),
      ]);
      // An I/O failure can recover without changing file metadata. Incomplete
      // source facts must be reobserved through the live repository reader.
      if (facts.sources.errors.length)
        throw new Error("Cannot prepare incomplete repository facts");
      const structureTexts: PreparedWorkspace["structureTexts"] = [];
      // Keep the structure reader's strict UTF-8 and no-NUL contract. These
      // bytes may differ from the permissive repository evidence reader.
      for (const filename of live.filter(
        (filename) => isImportSource(filename) || isImportConfig(filename),
      )) {
        const text = await readStructureSource(workspaceRoot, filename, cacheDir);
        const relative = path.relative(workspaceRoot, filename).split(path.sep).join("/");
        structureTexts.push([
          filename,
          facts.sources.files.find((source) => source.path === relative)?.content === text
            ? null
            : text,
        ]);
      }
      const materials: PreparedWorkspace["materials"] = [];
      for (const [documentPath, header] of headers) {
        let declarations;
        try {
          declarations = materialOccurrences(parseFrontmatter(header.content).data);
        } catch {
          continue;
        }
        const structureResources = declarations
          .filter((entry) => entry.track === "structure")
          .map((entry) => entry.resource);
        for (const entry of declarations.filter((entry) => entry.track === "structure")) {
          const filename = localMaterialPath(
            materialLocator(entry.resource, documentPath, true),
            workspaceRoot,
          );
          if (!filename) continue;
          const relative = path.relative(workspaceRoot, filename);
          if (
            relative === ".." ||
            relative.startsWith(".." + path.sep) ||
            path.isAbsolute(relative) ||
            relative.split(path.sep)[0]?.toLowerCase() === ".tent"
          )
            continue;
          const resource = /^(?:\.{1,2}\/|\/)/.test(entry.resource.trim())
            ? entry.resource
            : `./${entry.resource.trim()}`;
          const key = JSON.stringify([documentPath, resource, entry.track, structureResources]);
          try {
            materials.push([
              key,
              {
                value: await observeMaterialResource(
                  workspaceRoot,
                  documentPath,
                  resource,
                  cacheDir,
                  entry.track,
                  structureResources,
                ),
              },
            ]);
          } catch {
            // Failed observations stay on the live path so recovery is visible
            // even when the source's filesystem identity has not changed.
          }
        }
      }
      return { repository: facts, live, tracked, structureTexts, materials };
    });
    if (repository) refreshed = true;
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
          schema: 12,
          rootMarkerDigest: markerDigest,
          rejectedRootMarkers,
          workspaceRoot,
          writtenAtNs,
          directories: directoryRecords,
          headers: headerRecords,
          ...(repository ? { repository } : {}),
          sourceDigest: hash([
            writtenAtNs,
            directoryRecords,
            headerRecords,
            markerDigest,
            rejectedRootMarkers,
            repository ?? null,
          ]),
          indexDigest: hookIndexDigest(index, markerDigest, rejectedRootMarkers),
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
