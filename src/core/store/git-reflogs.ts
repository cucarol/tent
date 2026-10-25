import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { durableMkdir, syncDirectory } from "../../fs/durable-file.js";
import { renameWithRetry } from "../../fs/rename-with-retry.js";

/** Caller holds mutation.lock. Git still appends existing logs when creation is disabled. */
export async function archiveExistingReflogs(root: string): Promise<string | undefined> {
  const source = path.join(root, ".git/logs");
  const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory())
    throw new Error("Tent Git logs is not a directory; inspect .tent/.git/logs before saving");
  const flush = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await flush(filename);
      else if (entry.isFile()) {
        const handle = await fs.open(filename, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else throw new Error(`Tent Git reflog is not a regular file: ${filename}`);
    }
    await syncDirectory(directory);
  };
  await flush(source);
  const parent = path.join(root, ".git/tent-reflogs");
  await durableMkdir(parent);
  const destination = path.join(
    parent,
    `${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID()}`,
  );
  await renameWithRetry(source, destination);
  await syncDirectory(parent);
  await syncDirectory(path.dirname(source));
  return path.relative(path.dirname(root), destination).replaceAll("\\", "/");
}
