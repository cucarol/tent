import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { Stats, BigIntStats } from "node:fs";
import { scopedPendingRead } from "./file-state-cache.js";

// Only overlapping work in this request shares ancestry probes. Final identity is independent.
const currentStat = (name: string) => scopedPendingRead(`lstat:${name}`, () => lstat(name));
const currentPath = (name: string) => scopedPendingRead(`realpath:${name}`, () => realpath(name));

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
