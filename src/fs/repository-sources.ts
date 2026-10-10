import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  isImportConfig,
  isImportSource,
  isTestSource,
  type RepositorySource,
} from "../core/repository-imports.js";

/** Read tracked source/config bytes only; no symlinks, package loading, commands or writes. */
export async function readRepositorySources(root: string, trackedFiles: readonly string[]) {
  const files: RepositorySource[] = [];
  const errors: Array<{ file: string; reason: string }> = [];
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
  for (const file of [...new Set(trackedFiles)].sort()) {
    const source: RepositorySource = { path: file };
    files.push(source);
    if (!(isImportConfig(file) || (isImportSource(file) && !isTestSource(file)))) continue;
    try {
      if (!(await plainDirectories(path.posix.dirname(file))))
        throw new Error("Source parent is not a plain directory");
      const info = await lstat(path.join(root, file));
      if (!info.isFile()) throw new Error("Source is not a regular file");
      source.content = await readFile(path.join(root, file), "utf8");
    } catch (error) {
      errors.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { files, errors };
}
