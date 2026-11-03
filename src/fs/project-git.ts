import fs from "node:fs/promises";
import { repositoryCommand } from "./repository-command.js";

/** Initialization is the only project command allowed to create a repository. */
export async function initializeProjectGit(root: string): Promise<boolean> {
  await fs.mkdir(root, { recursive: true });
  try {
    if ((await repositoryCommand(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true")
      return false;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === "ENOENT")
      throw new Error(`Tent needs Git; install Git, then run tent new ${root}`);
    if (code !== 128) throw error;
  }
  await repositoryCommand(root, ["init", "--quiet"]);
  return true;
}
