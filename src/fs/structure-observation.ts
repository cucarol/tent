import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  structureMaterialCoverage,
  materialCoverageContains,
  type MaterialCoverage,
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
import { extractRustImports } from "../core/base/rust-imports.js";
import { extractJavaImports } from "../core/base/java-imports.js";
import { isJavaConfig } from "../core/base/java-build.js";
import { extractCSharpImports } from "../core/base/csharp-imports.js";
import { extractPhpImports, isPhpConfig } from "../core/base/php-imports.js";
import { isCSharpConfig } from "../core/base/csharp-build.js";
import {
  extractCFamilyImports,
  isCFamilySource,
  isCFamilyConfig,
} from "../core/base/cfamily-imports.js";
import { sourceDirectoryPaths, sourcePathType } from "./directory-observation.js";
import { readStructureSource } from "./source-observation.js";
import { checkedSourceDirectory } from "./checked-source-file.js";
import { withFileReadScope } from "./file-state-cache.js";
import { directoryRepository } from "./repository-material.js";
import {
  loadStructureDerivedStore,
  saveStructureDerivedStore,
  type StructureDerivedStore,
} from "./structure-derived-cache.js";

/**
 * One inspection observes the Workspace listing and each structure source once.
 * Every structure material in that inspection shares this snapshot; a later
 * inspection always starts empty, so no observation outlives its inspection.
 */
type StructureSnapshot = {
  repository?: ReturnType<typeof directoryRepository>;
  listings: Map<string, Promise<string[]>>;
  sources: Map<string, Promise<string>>;
  paths: Map<
    string,
    Promise<{ live: string[]; all: Array<{ filename: string; workspacePath: string }> }>
  >;
  types: Map<string, ReturnType<typeof sourcePathType>>;
  resolvedTypes: Map<string, Awaited<ReturnType<typeof sourcePathType>>>;
  members: Map<string, string[]>;
  sourceVersions: Map<string, string>;
  derived: Map<string, Promise<StructureDerivedStore>>;
};
const structureSnapshot = new AsyncLocalStorage<StructureSnapshot>();

export function withStructureSnapshot<T>(action: () => Promise<T>, fresh = false): Promise<T> {
  if (structureSnapshot.getStore() && !fresh) return action();
  const snapshot: StructureSnapshot = {
    listings: new Map(),
    sources: new Map(),
    paths: new Map(),
    types: new Map(),
    resolvedTypes: new Map(),
    members: new Map(),
    sourceVersions: new Map(),
    derived: new Map(),
  };
  return structureSnapshot.run(snapshot, async () => {
    const result = await action();
    await Promise.all(
      [...snapshot.derived].map(async ([directory, pending]) =>
        saveStructureDerivedStore(directory, await pending),
      ),
    );
    return result;
  });
}
export function withoutStructureSnapshot<T>(action: () => Promise<T>): Promise<T> {
  return structureSnapshot.exit(action);
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
  return withFileReadScope(() =>
    withStructureSnapshot(() =>
      observeStructureMaterialInScope(
        workspaceRoot,
        documentPath,
        resource,
        cacheDir,
        structureResources,
      ),
    ),
  );
}

async function observeStructureMaterialInScope(
  workspaceRoot: string,
  documentPath: string,
  resource: string,
  cacheDir: string | undefined,
  structureResources: readonly string[],
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
  const canonicalDirectory = await checkedSourceDirectory(workspaceRoot, directory);
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
  const paths = await shared(
    snapshot?.paths,
    JSON.stringify([workspaceRoot, cacheDir ?? null]),
    async () => {
      const livePaths = await listing(false);
      const trackedPaths = repository ? await listing(true) : [];
      const relative = (filename: string) =>
        path.relative(workspaceRoot, filename).split(path.sep).join("/");
      return {
        live: livePaths.map(relative),
        all: [...new Set([...livePaths, ...trackedPaths])]
          .sort()
          .map((filename) => ({ filename, workspacePath: relative(filename) })),
      };
    },
  );
  const coverageMembers = (item: MaterialCoverage) => {
    const key = JSON.stringify([workspaceRoot, cacheDir, item]);
    let members = snapshot?.members.get(key);
    if (!members) {
      members = paths.live.filter((file) => materialCoverageContains(item, file));
      snapshot?.members.set(key, members);
    }
    return members;
  };
  const memberSources = coverageMembers(coverage).filter(
    (file) => isImportSource(file) && !isTestSource(file),
  );
  const members = new Set(memberSources);
  const rustMembers = memberSources.filter((member) => member.endsWith(".rs"));
  const neededConfig = (file: string) => {
    if (!isImportConfig(file)) return false;
    if (
      /(^|\/)Cargo\.toml$/.test(file) ||
      isJavaConfig(file) ||
      isCSharpConfig(file) ||
      isPhpConfig(file) ||
      isCFamilyConfig(file)
    )
      return false;
    const configDirectory = path.posix.dirname(file);
    return memberSources.some(
      (member) =>
        (/go\.mod$/.test(file) ? member.endsWith(".go") : /\.[cm]?[jt]sx?$/.test(member)) &&
        (configDirectory === "." || member.startsWith(configDirectory + "/")),
    );
  };
  const readSource = (filename: string) =>
    shared(snapshot?.sources, filename, () =>
      readStructureSource(workspaceRoot, filename, cacheDir),
    );
  const files: RepositorySource[] = [];
  for (const { filename, workspacePath } of paths.all) {
    const file: RepositorySource = { path: workspacePath };
    if (members.has(workspacePath) || neededConfig(workspacePath)) {
      file.content = await readSource(filename);
    } else {
      const type =
        snapshot?.resolvedTypes.get(filename) ??
        (await shared(snapshot?.types, filename, () => sourcePathType(filename)));
      if (!type) throw new Error(`ENOENT: Structure source disappeared: ${workspacePath}`);
      snapshot?.resolvedTypes.set(filename, type);
      if (type === "directory") continue;
    }
    files.push(file);
  }
  // Core requests only Cargo ancestry/path-dependency facts and source bytes
  // needed to establish these members' module contexts and resolve their uses.
  const byPath = new Map(files.map((file) => [file.path, file]));
  // Keep listing order, including when declarations overlap or are reordered.
  const coveredMembers = new Set(nodeCoverage.flatMap(coverageMembers));
  const nodeMembers = new Set(paths.live.filter((file) => coveredMembers.has(file)));
  const fingerprint = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const sourceVersion = (content: string) => {
    let version = snapshot?.sourceVersions.get(content);
    if (!version) {
      version = createHash("sha256").update(content).digest("hex");
      snapshot?.sourceVersions.set(content, version);
    }
    return version;
  };
  const derived = cacheDir
    ? await shared(snapshot?.derived, cacheDir, () => loadStructureDerivedStore(cacheDir))
    : undefined;
  const key = fingerprint([workspaceRoot, process.platform, coverage, nodeCoverage]);
  const base = derived
    ? fingerprint([
        files.map((file) => [
          file.path,
          file.content === undefined ? null : sourceVersion(file.content),
        ]),
        [...nodeMembers],
      ])
    : undefined;
  const retained = derived?.entries.get(key);
  const result = (dependencies: string[]) => ({
    canonicalPath,
    observedVersion: structureFingerprint(dependencies),
    structureDependencies: dependencies,
    cacheHit: false,
    blobs: aggregateBlobs(dependencies),
  });
  if (retained && retained.base === base) {
    let matches = true;
    for (const [file, version] of retained.additional) {
      // Cached inputs must still belong to the current validated listing.
      // A supporting config can remove earlier requirements; failures therefore
      // fall back to resolution instead of making an obsolete input authoritative.
      if (!byPath.has(file)) {
        matches = false;
        break;
      }
      try {
        if (sourceVersion(await readSource(path.join(workspaceRoot, file))) !== version) {
          matches = false;
          break;
        }
      } catch {
        matches = false;
        break;
      }
    }
    if (matches) return result(retained.dependencies.slice());
  }
  const initiallyRead = new Set(
    files.filter((file) => file.content !== undefined).map((file) => file.path),
  );
  const rustSources = files.filter((file) => !isTestSource(file.path));
  let rust = extractRustImports(rustSources, rustMembers);
  while (true) {
    const required = rust.requiredFiles.filter((file) => byPath.get(file)?.content === undefined);
    if (!required.length) break;
    for (const file of required) {
      const source = byPath.get(file);
      if (!source) throw new Error(`Required Rust source is absent: ${file}`);
      source.content = await readSource(path.join(workspaceRoot, file));
    }
    rust = extractRustImports(rustSources, rustMembers);
  }
  const javaMembers = memberSources.filter((member) => member.endsWith(".java"));
  const javaSources = files.filter((file) => !isTestSource(file.path));
  let java = extractJavaImports(javaSources, javaMembers);
  while (true) {
    const required = java.requiredFiles.filter((file) => byPath.get(file)?.content === undefined);
    if (!required.length) break;
    for (const file of required) {
      const source = byPath.get(file);
      if (!source) throw new Error(`Required Java source is absent: ${file}`);
      source.content = await readSource(path.join(workspaceRoot, file));
    }
    java = extractJavaImports(javaSources, javaMembers);
  }
  const csharpMembers = memberSources.filter((member) => member.endsWith(".cs"));
  const csharpSources = files.filter((file) => !isTestSource(file.path));
  let csharp = extractCSharpImports(csharpSources, csharpMembers);
  while (true) {
    const required = csharp.requiredFiles.filter((file) => byPath.get(file)?.content === undefined);
    if (!required.length) break;
    for (const file of required) {
      const source = byPath.get(file);
      if (!source) throw new Error(`Required C# source is absent: ${file}`);
      source.content = await readSource(path.join(workspaceRoot, file));
    }
    csharp = extractCSharpImports(csharpSources, csharpMembers);
  }
  const cfamilySources = files.filter((file) => !isTestSource(file.path));
  const cfamilyMembers = memberSources.filter(isCFamilySource);
  let cfamily = extractCFamilyImports(cfamilySources, cfamilyMembers);
  while (true) {
    const required = cfamily.requiredFiles.filter(
      (file) => byPath.get(file)?.content === undefined,
    );
    if (!required.length) break;
    for (const file of required) {
      const source = byPath.get(file);
      if (!source) throw new Error(`Required C/C++ source is absent: ${file}`);
      source.content = await readSource(path.join(workspaceRoot, file));
    }
    cfamily = extractCFamilyImports(cfamilySources, cfamilyMembers);
  }
  const phpSources = files.filter((file) => !isTestSource(file.path));
  const phpMembers = memberSources.filter((member) => member.endsWith(".php"));
  let php = extractPhpImports(phpSources, phpMembers);
  while (true) {
    const required = php.requiredFiles.filter((file) => byPath.get(file)?.content === undefined);
    if (!required.length) break;
    for (const file of required) {
      const source = byPath.get(file);
      if (!source) throw new Error(`Required PHP source is absent: ${file}`);
      source.content = await readSource(path.join(workspaceRoot, file));
    }
    php = extractPhpImports(phpSources, phpMembers);
  }
  const imports = extractRepositoryImports(files, {
    rust: false,
    java: false,
    csharp: false,
    cfamily: false,
    php: false,
  });
  imports.edges.push(...rust.edges);
  imports.issues.push(...rust.issues);
  imports.edges.push(...java.edges);
  imports.issues.push(...java.issues);
  imports.edges.push(...csharp.edges);
  imports.issues.push(...csharp.issues);
  imports.edges.push(...cfamily.edges);
  imports.issues.push(...cfamily.issues);
  imports.edges.push(...php.edges);
  imports.issues.push(...php.issues);
  const issue = imports.issues.find(
    (issue) =>
      isImportConfig(issue.file) ||
      materialCoverageContains(coverage, issue.file) ||
      java.requiredFiles.includes(issue.file) ||
      csharp.requiredFiles.includes(issue.file) ||
      cfamily.requiredFiles.includes(issue.file) ||
      php.requiredFiles.includes(issue.file),
  );
  if (issue)
    throw new Error(
      `Structure unavailable: ${issue.file}: ${issue.reason}${issue.specifier ? ` (${issue.specifier})` : ""}`,
    );
  const structureDependencies = externalStructureDependencies(
    coverage,
    imports.edges,
    files.map((file) => file.path),
    nodeMembers,
  );
  if (derived) {
    derived.entries.delete(key);
    derived.entries.set(key, {
      base: base!,
      additional: files
        .filter((file) => file.content !== undefined && !initiallyRead.has(file.path))
        .map((file) => [file.path, sourceVersion(file.content!)]),
      dependencies: structureDependencies.slice(),
    });
    derived.dirty = true;
  }
  return result(structureDependencies);
}
