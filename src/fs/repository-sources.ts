import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isProductManifest } from "../core/base/repository-products.js";
import {
  isImportConfig,
  isImportSource,
  isTestSource,
  type RepositorySource,
} from "../core/base/repository-imports.js";

/** Read tracked source/config bytes only; no symlinks, package loading, commands or writes. */
export async function readRepositorySources(
  root: string,
  trackedFiles: readonly string[],
  options: { includeTests?: boolean; includeProductManifests?: boolean } = {},
) {
  const files: RepositorySource[] = [...new Set(trackedFiles)].sort().map((path) => ({ path }));
  const errors: Array<{ file: string; reason: string } | undefined> = new Array(files.length);
  const directories = new Map<string, Promise<boolean>>();
  async function plainDirectories(relative: string): Promise<boolean> {
    if (relative === ".") return true;
    let check = directories.get(relative);
    if (!check) {
      check = (async () => {
        if (!(await plainDirectories(path.posix.dirname(relative)))) return false;
        return (await lstat(path.join(root, relative))).isDirectory();
      })();
      directories.set(relative, check);
    }
    return check;
  }
  let next = 0;
  const read = async () => {
    for (;;) {
      const index = next++;
      const source = files[index];
      if (!source) return;
      const file = source.path;
      if (!(
        isImportConfig(file) ||
        (options.includeProductManifests && isProductManifest(file)) ||
        (isImportSource(file) && (options.includeTests || !isTestSource(file)))
      ))
        continue;
      try {
        if (!(await plainDirectories(path.posix.dirname(file))))
          throw new Error("Source parent is not a plain directory");
        const info = await lstat(path.join(root, file));
        if (!info.isFile()) throw new Error("Source is not a regular file");
        source.content = await readFile(path.join(root, file), "utf8");
      } catch (error) {
        errors[index] = { file, reason: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  // Bound open files while independent reads overlap; completion order never
  // changes the source/error ordering consumed by fingerprints and revisions.
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, read));
  return {
    files,
    errors: errors.filter(
      (error): error is { file: string; reason: string } => error !== undefined,
    ),
  };
}
