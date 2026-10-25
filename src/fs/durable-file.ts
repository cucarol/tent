import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { renameWithRetry } from "./rename-with-retry.js";

/** POSIX directory entries need a separate sync. Windows cannot open directories this way. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Persist newly created parent entries as well as the directory containing the file. */
export async function durableMkdir(directory: string): Promise<void> {
  const first = await fs.mkdir(directory, { recursive: true });
  // Windows mkdir may return a namespaced path (\\?\...), and has no directory sync here.
  if (first === undefined || process.platform === "win32") return;
  const stop = path.dirname(path.resolve(first));
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    await syncDirectory(current);
    if (current === stop) break;
  }
}

/** Flush the prepared bytes before publishing the replacement; a sync failure is a failed save. */
export async function durableReplace(
  filename: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const temporary = `${filename}.tmp-${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(data, encoding);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
