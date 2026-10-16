import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  structureMaterialCoverage,
  materialCoverageContains,
} from "../core/base/material-coverage.js";
import {
  externalStructureDependencies,
  structureFingerprint,
} from "../core/base/structure-material.js";
import {
  extractRepositoryImports,
  isImportSource,
  isImportConfig,
  isTestSource,
  type RepositorySource,
} from "../core/base/repository-imports.js";
import { sourceDirectoryPaths } from "./directory-observation.js";
import { observeSourceFile } from "./source-observation.js";
import { checkedSourceFile } from "./checked-source-file.js";
import { directoryRepository } from "./repository-material.js";

/**
 * One inspection observes the Workspace listing and each structure source once.
 * Every structure material in that inspection shares this snapshot; a later
 * inspection always starts empty, so no observation outlives its inspection.
 */
type StructureSnapshot = {
  repository?: ReturnType<typeof directoryRepository>;
  listings: Map<string, Promise<string[]>>;
  sources: Map<string, Promise<string>>;
  directories: Map<string, Promise<boolean>>;
};
const structureSnapshot = new AsyncLocalStorage<StructureSnapshot>();

export function withStructureSnapshot<T>(action: () => Promise<T>): Promise<T> {
  if (structureSnapshot.getStore()) return action();
  return structureSnapshot.run(
    { listings: new Map(), sources: new Map(), directories: new Map() },
    action,
  );
}

function shared<T>(map: Map<string, Promise<T>> | undefined, key: string, read: () => Promise<T>) {
  if (!map) return read();
  let pending = map.get(key);
  if (!pending) {
    pending = read();
    map.set(key, pending);
  }
  return pending;
}

function aggregateBlobs(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    sha1: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    sha256: createHash("sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  };
}

/** Safely parse the same repository sources as module-map; never run filters or parsers with writes. */
export async function observeStructureMaterial(
  workspaceRoot: string,
  documentPath: string,
  resource: string,
  cacheDir?: string,
  structureResources: readonly string[] = [resource],
) {
  const coverage = structureMaterialCoverage(resource, documentPath, workspaceRoot);
  if (!coverage)
    throw new Error("Structure observation requires a Workspace directory or prefix material");
  const nodeCoverage = structureResources
    .map((address) => structureMaterialCoverage(address, documentPath, workspaceRoot))
    .filter((item) => item !== undefined);
  const physical = path.resolve(
    workspaceRoot,
    coverage.prefix + (coverage.kind === "prefix" ? "*" : ""),
  );
  const directory = coverage.kind === "directory" ? physical : path.dirname(physical);
  await checkedSourceFile(workspaceRoot, directory, true);
  const canonicalDirectory = await realpath(directory);
  const canonicalPath =
    coverage.kind === "directory"
      ? canonicalDirectory
      : path.join(canonicalDirectory, path.basename(physical));
  // Both aggregate kinds use nonignored live members. Tracked paths additionally
  // let the resolver identify ignored targets without making them members.
  const snapshot = structureSnapshot.getStore();
  const repository = snapshot
    ? await (snapshot.repository ??= directoryRepository(workspaceRoot))
    : await directoryRepository(workspaceRoot);
  const listing = (trackedOnly: boolean) =>
    shared(snapshot?.listings, JSON.stringify([workspaceRoot, cacheDir ?? null, trackedOnly]), () =>
      sourceDirectoryPaths(workspaceRoot, workspaceRoot, cacheDir, trackedOnly),
    );
  const livePaths = await listing(false);
  const trackedPaths = repository ? await listing(true) : undefined;
  const memberPaths = livePaths;
  const paths = [...new Set([...livePaths, ...(trackedPaths ?? [])])].sort();
  const memberSources = memberPaths
    .map((filename) => path.relative(workspaceRoot, filename).split(path.sep).join("/"))
    .filter(
      (file) =>
        materialCoverageContains(coverage, file) && isImportSource(file) && !isTestSource(file),
    );
  const members = new Set(memberSources);
  const neededConfig = (file: string) => {
    if (!isImportConfig(file)) return false;
    const configDirectory = path.posix.dirname(file);
    return memberSources.some(
      (member) =>
        (/go\.mod$/.test(file) ? member.endsWith(".go") : /\.[cm]?[jt]sx?$/.test(member)) &&
        (configDirectory === "." || member.startsWith(configDirectory + "/")),
    );
  };
  const files: RepositorySource[] = [];
  for (const filename of paths) {
    const workspacePath = path.relative(workspaceRoot, filename).split(path.sep).join("/");
    const file: RepositorySource = { path: workspacePath };
    if (members.has(workspacePath) || neededConfig(workspacePath)) {
      file.content = await shared(snapshot?.sources, filename, async () => {
        let content: string | undefined;
        await observeSourceFile(workspaceRoot, filename, undefined, {
          key: "structure-source-v1",
          content: (bytes) => {
            content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            if (content.includes("\0"))
              throw new Error(`Structure source is not valid text: ${workspacePath}`);
            return bytes;
          },
        });
        return content!;
      });
    } else if (
      await shared(snapshot?.directories, filename, async () =>
        (await lstat(filename)).isDirectory(),
      )
    )
      continue;
    files.push(file);
  }
  const imports = extractRepositoryImports(files);
  const issue = imports.issues.find(
    (issue) => isImportConfig(issue.file) || materialCoverageContains(coverage, issue.file),
  );
  if (issue)
    throw new Error(
      `Structure unavailable: ${issue.file}: ${issue.reason}${issue.specifier ? ` (${issue.specifier})` : ""}`,
    );
  const structureDependencies = externalStructureDependencies(
    coverage,
    imports.edges,
    files.map((file) => file.path),
    new Set(
      memberPaths
        .map((filename) => path.relative(workspaceRoot, filename).split(path.sep).join("/"))
        .filter((file) => nodeCoverage.some((item) => materialCoverageContains(item, file))),
    ),
  );
  await checkedSourceFile(workspaceRoot, directory, true);
  return {
    canonicalPath,
    observedVersion: structureFingerprint(structureDependencies),
    structureDependencies,
    cacheHit: false,
    blobs: aggregateBlobs(structureDependencies),
  };
}
