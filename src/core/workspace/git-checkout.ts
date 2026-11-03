import * as fs from "node:fs/promises";
import * as path from "node:path";

type GitCheckout = { root: string; gitDir: string; commonDir: string; linked: boolean };
// node:path follows the host's path comparison semantics (including Windows case).
const samePath = (left: string, right: string) => path.relative(left, right) === "";
const optional = async (filename: string) =>
  fs.readFile(filename, "utf8").catch((error) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return undefined;
  });

/** Read Git's checkout pointers without starting Git or reading working files. */
export async function readGitCheckout(root: string): Promise<GitCheckout | undefined> {
  const marker = path.join(root, ".git");
  const stat = await fs.stat(marker).catch((error) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return undefined;
  });
  if (stat?.isDirectory()) return { root, gitDir: marker, commonDir: marker, linked: false };
  if (!stat) {
    const markerExists = await fs.lstat(marker).catch((error) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      return undefined;
    });
    if (markerExists) throw new Error(`Invalid Git checkout marker: ${marker}`);
    return undefined;
  }
  if (!stat.isFile()) throw new Error(`Invalid Git checkout marker: ${marker}`);
  const pointer = await fs.readFile(marker, "utf8");
  const match = /^gitdir: (.+)\r?$/m.exec(pointer);
  if (!match) throw new Error(`Invalid Git checkout marker: ${marker}`);
  const gitDir = path.resolve(root, match[1]!.trim());
  const common = (await optional(path.join(gitDir, "commondir"))) ?? "";
  return {
    root,
    gitDir,
    commonDir: common.trim() ? path.resolve(gitDir, common.trim()) : gitDir,
    linked: !!common.trim(),
  };
}

export async function linkedMainCheckout(checkout: GitCheckout): Promise<string | undefined> {
  if (!checkout.linked) return undefined;
  const mainRoot = path.dirname(checkout.commonDir);
  const main = await readGitCheckout(mainRoot);
  return main && !main.linked && samePath(main.commonDir, checkout.commonDir)
    ? mainRoot
    : undefined;
}

/** Per-turn memoization bounds pointer reads for many files in the same directories. */
export async function createTurnPathResolver(
  workspaceRoot: string | undefined,
  cwd: string | undefined,
) {
  const directories = new Map<string, Promise<GitCheckout | undefined>>();
  const find = (dir: string): Promise<GitCheckout | undefined> => {
    let pending = directories.get(dir);
    if (!pending) {
      pending = (async () => {
        const checkout = await readGitCheckout(dir);
        if (checkout) return checkout;
        const parent = path.dirname(dir);
        return parent === dir ? undefined : find(parent);
      })();
      directories.set(dir, pending);
    }
    return pending;
  };
  const workspace = workspaceRoot ? await find(path.resolve(workspaceRoot)) : undefined;
  const session = cwd ? await find(path.resolve(cwd)) : undefined;
  const checkout =
    session && workspace && samePath(session.commonDir, workspace.commonDir) ? session : undefined;
  const workspacePrefix =
    workspace && workspaceRoot
      ? path.relative(workspace.root, workspaceRoot).split(path.sep).join("/")
      : "";
  return {
    checkoutRoot: checkout?.root,
    workspacePrefix,
    checkoutWorkspaceRoot: checkout ? path.join(checkout.root, workspacePrefix) : undefined,
  };
}
