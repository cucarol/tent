import { realpath, lstat } from "node:fs/promises";
import path from "node:path";

async function gitBoundary(root: string): Promise<string | undefined> {
  for (let current = path.resolve(root); ;) {
    if (
      await lstat(path.join(current, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
/** Directory listing only needs the owning checkout, not blob relocation metadata. */
export async function directoryRepository(root: string) {
  const boundary = await gitBoundary(root);
  return boundary ? { root: await realpath(boundary) } : undefined;
}
