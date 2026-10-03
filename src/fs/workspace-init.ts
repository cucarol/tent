import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { scaffoldTent, ensureWorkspaceGitignore } from "../core/scaffold.js";
import { TENT_SYSTEM_DIR } from "../core/paths.js";
import { NodeFs } from "./node-fs.js";
import { renameWithRetry } from "./rename-with-retry.js";

const execute = promisify(execFile);

/** Initialize an empty Tent and its independent local history repository. */
export async function initializeTentWorkspace(workspaceRoot: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const systemRoot = path.join(root, TENT_SYSTEM_DIR);
  try {
    await fs.lstat(systemRoot);
    throw new Error(`Target already has a Tent system dir: ${TENT_SYSTEM_DIR}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Inherited Git routing must not redirect initialization into the outer project.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const git = (args: string[]) => execute("git", args, { env, windowsHide: true });
  await git(["--version"]);
  await fs.mkdir(root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, ".tent-init-"));
  try {
    await git(["-C", staging, "init", "--quiet"]);
    const { stdout } = await git(["-C", staging, "rev-parse", "--show-toplevel"]);
    if ((await fs.realpath(stdout.trim())) !== (await fs.realpath(staging))) {
      throw new Error(`Tent history must be rooted at ${staging}`);
    }
    await scaffoldTent(new NodeFs(staging), { name: path.basename(root) });
    await ensureWorkspaceGitignore(new NodeFs(root));
    // Publish a complete, verified Tent. Failed preparation never creates a ready marker.
    await renameWithRetry(staging, systemRoot);
  } catch (error) {
    if (path.dirname(staging) !== root || !path.basename(staging).startsWith(".tent-init-"))
      throw error;
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
