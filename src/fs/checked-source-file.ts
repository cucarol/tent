import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 逐段拒绝 symlink/junction，并核对实际路径与普通文件类型。 */
export async function checkedSourceFile(root: string, candidate: string, directory = false) {
  if (!inside(root, candidate)) throw new Error("Source target escapes root");
  const actualRoot = await realpath(root);
  if (path.relative(actualRoot, root) !== "") throw new Error("Workspace root changed");
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symbolic links are not supported for source files");
  }
  const actual = await realpath(candidate);
  if (!inside(actualRoot, actual) || path.relative(candidate, actual) !== "")
    throw new Error("Source target escapes Workspace");
  const stat = await lstat(candidate);
  if (!(directory ? stat.isDirectory() : stat.isFile()))
    throw new Error(
      directory ? "Source target is not a directory" : "Source target is not a regular file",
    );
  return stat;
}
