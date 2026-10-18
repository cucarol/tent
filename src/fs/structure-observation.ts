import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
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
import {
  sourceDirectoryPaths,
  sourcePathType,
  type SourcePathTypes,
} from "./directory-observation.js";
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
  types: SourcePathTypes;
};
const structureSnapshot = new AsyncLocalStorage<StructureSnapshot>();

export function withStructureSnapshot<T>(action: () => Promise<T>): Promise<T> {
  if (structureSnapshot.getStore()) return action();
  return structureSnapshot.run(
    { listings: new Map(), sources: new Map(), types: new Map() },
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
      sourceDirectoryPaths(workspaceRoot, workspaceRoot, cacheDir, trackedOnly, snapshot?.types),
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
  const readSource = (workspacePath: string, filename: string) =>
    shared(snapshot?.sources, filename, async () => {
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
  const files: RepositorySource[] = [];
  for (const filename of paths) {
    const workspacePath = path.relative(workspaceRoot, filename).split(path.sep).join("/");
    const file: RepositorySource = { path: workspacePath };
    if (members.has(workspacePath) || neededConfig(workspacePath)) {
      file.content = await readSource(workspacePath, filename);
    } else {
      const type = await sourcePathType(filename, snapshot?.types);
      if (!type) throw new Error(`ENOENT: Structure source disappeared: ${workspacePath}`);
      if (type === "directory") continue;
    }
    files.push(file);
  }
  // Core requests only Cargo ancestry/path-dependency facts and source bytes
  // needed to establish these members' module contexts and resolve their uses.
  const byPath = new Map(files.map((file) => [file.path, file]));
  const rustSources = files.filter((file) => !isTestSource(file.path));
  let rust = extractRustImports(rustSources, rustMembers);
  while (true) {
    const required = rust.requiredFiles.filter((file) => byPath.get(file)?.content === undefined);
    if (!required.length) break;
    for (const file of required) {
      const source = byPath.get(file);
      if (!source) throw new Error(`Required Rust source is absent: ${file}`);
      source.content = await readSource(file, path.join(workspaceRoot, file));
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
      source.content = await readSource(file, path.join(workspaceRoot, file));
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
      source.content = await readSource(file, path.join(workspaceRoot, file));
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
      source.content = await readSource(file, path.join(workspaceRoot, file));
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
      source.content = await readSource(file, path.join(workspaceRoot, file));
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
