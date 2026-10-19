import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

const pendingStats = new Map<string, ReturnType<typeof lstat>>();
const pendingPaths = new Map<string, Promise<string>>();

/** Overlapping checks can share a syscall; a settled observation is never reused. */
function inFlight<T>(pending: Map<string, Promise<T>>, name: string, read: () => Promise<T>) {
  let value = pending.get(name);
  if (!value) {
    value = read().finally(() => {
      if (pending.get(name) === value) pending.delete(name);
    });
    pending.set(name, value);
  }
  return value;
}

const currentStat = (name: string) => inFlight(pendingStats, name, () => lstat(name));
const currentPath = (name: string) => inFlight(pendingPaths, name, () => realpath(name));

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 逐段拒绝 symlink/junction，并核对实际路径与普通文件类型。 */
export async function checkedSourceFile(root: string, candidate: string, directory = false) {
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
  const stat = await lstat(candidate);
  if (!(directory ? stat.isDirectory() : stat.isFile()))
    throw new Error(
      directory ? "Source target is not a directory" : "Source target is not a regular file",
    );
  return stat;
}
