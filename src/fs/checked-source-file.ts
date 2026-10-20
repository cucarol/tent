import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { Stats, BigIntStats } from "node:fs";
import { scopedPendingRead, scopedRead, withFileReadScope } from "./file-state-cache.js";

// Only overlapping work in this request shares ancestry probes. Final identity is independent.
const currentStat = (name: string) => scopedPendingRead(`lstat:${name}`, () => lstat(name));
const currentPath = (name: string) => scopedPendingRead(`realpath:${name}`, () => realpath(name));

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Listing, link rejection and cache validation share one initial state in this request. */
export function initialSourceState(filename: string): Promise<BigIntStats> {
  return scopedRead(`source-state:${filename}`, () => lstat(filename, { bigint: true }));
}

export function sourceDirectoryRealpath(directory: string): Promise<string> {
  return scopedRead(`source-directory-path:${directory}`, () => realpath(directory));
}

/** A canonical parent covers all its ordinary children; later requests start empty. */
export function checkedSourceDirectory(root: string, directory: string): Promise<string> {
  return withFileReadScope(() =>
    scopedRead(`source-directory:${JSON.stringify([root, directory])}`, async () => {
      if (!inside(root, directory)) throw new Error("Source target escapes root");
      if (path.relative(root, directory) !== "")
        await checkedSourceDirectory(root, path.dirname(directory));
      const [info, actualRoot, actual] = await Promise.all([
        initialSourceState(directory),
        sourceDirectoryRealpath(root),
        sourceDirectoryRealpath(directory),
      ]);
      if (path.relative(actualRoot, root) !== "") throw new Error("Workspace root changed");
      if (info.isSymbolicLink())
        throw new Error("Symbolic links are not supported for source files");
      if (!info.isDirectory()) throw new Error("Source target is not a directory");
      if (
        !inside(actualRoot, actual) ||
        (path.relative(directory, actual) !== "" &&
          directory.toLowerCase() !== actual.toLowerCase())
      )
        throw new Error("Symbolic links are not supported for source directories");
      return actual;
    }),
  );
}

/** Initial metadata only. A content read must still validate its opened handle and final path. */
export function initialSourceFile(root: string, filename: string) {
  return withFileReadScope(async () => {
    if (!inside(root, filename)) throw new Error("Source target escapes root");
    const [parent, state] = await Promise.allSettled([
      checkedSourceDirectory(root, path.dirname(filename)),
      initialSourceState(filename),
    ]);
    // Missing leaves must not hide an invalid ancestor.
    if (parent.status === "rejected") throw parent.reason;
    if (state.status === "rejected") throw state.reason;
    const directory = parent.value;
    const stat = state.value;
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not supported for source files");
    if (!stat.isFile()) throw new Error("Source target is not a regular file");
    return { stat, canonicalPath: path.join(directory, path.basename(filename)) };
  });
}

/** 逐段拒绝 symlink/junction，并核对实际路径与普通文件类型。 */
export function checkedSourceFile(
  root: string,
  candidate: string,
  directory?: boolean,
): Promise<Stats>;
export function checkedSourceFile(
  root: string,
  candidate: string,
  directory: boolean,
  bigint: true,
): Promise<BigIntStats>;
export async function checkedSourceFile(
  root: string,
  candidate: string,
  directory = false,
  bigint = false,
) {
  if (!inside(root, candidate)) throw new Error("Source target escapes root");
  let current = root;
  const segmentChecks = path
    .relative(root, candidate)
    .split(path.sep)
    .map((segment) => {
      current = path.join(current, segment);
      return currentStat(current);
    });
  const [actualRoot, segments] = await Promise.all([
    currentPath(root),
    Promise.allSettled(segmentChecks),
  ]);
  if (path.relative(actualRoot, root) !== "") throw new Error("Workspace root changed");
  for (const result of segments) {
    if (result.status === "rejected") throw result.reason;
    if (result.value.isSymbolicLink())
      throw new Error("Symbolic links are not supported for source files");
  }
  const actual = await currentPath(candidate);
  // Case-insensitive filesystems may retain an older spelling in Git's index.
  // Every lexical component above must still be free of symlinks.
  if (
    !inside(actualRoot, actual) ||
    (path.relative(candidate, actual) !== "" && candidate.toLowerCase() !== actual.toLowerCase())
  )
    throw new Error("Source target escapes Workspace");
  // This identity is compared with an already-open handle. A concurrent ancestry
  // query may have sampled the path before replacement, even while still pending.
  const stat = await lstat(candidate, { bigint });
  if (!(directory ? stat.isDirectory() : stat.isFile()))
    throw new Error(
      directory ? "Source target is not a directory" : "Source target is not a regular file",
    );
  return stat;
}
