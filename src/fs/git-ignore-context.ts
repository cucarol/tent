import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { durableMkdir } from "./durable-file.js";

export const GIT_IGNORE_CONTEXT = "ignore-context";
const execute = promisify(execFile);

/** Setup only: retain Git's filesystem defaults in an unborn ignore tool context. */
export async function initializeGitIgnoreContext(systemRoot: string): Promise<void> {
  const root = path.join(systemRoot, ".git", GIT_IGNORE_CONTEXT);
  if (
    await fs.access(path.join(root, ".git", "HEAD")).then(
      () => true,
      () => false,
    )
  )
    return;
  await durableMkdir(root);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  try {
    await execute("git", ["init", "--quiet", "--initial-branch=tent-ignore", "--template=", root], {
      env,
      windowsHide: true,
    });
  } catch (error) {
    // Git is optional for SQLite storage. Reads keep their existing unknown result
    // when neither a project Git interpreter nor this tool context is available.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
