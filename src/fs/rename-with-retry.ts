import * as fs from "node:fs/promises";

/** Publish prepared files or directories despite brief Windows sharing violations. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = process.platform === "win32" ? 10 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt === attempts - 1) throw error;
      // Nine delays total 650 ms; publication still fails promptly if access stays denied.
      const delayMs = Math.min(10 * 2 ** attempt, 100);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
