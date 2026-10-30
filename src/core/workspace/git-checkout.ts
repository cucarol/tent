import * as fs from "node:fs/promises";
import * as path from "node:path";

type GitCheckout = { root: string; gitDir: string; commonDir: string; linked: boolean };
// node:path follows the host's path comparison semantics (including Windows case).
const samePath = (left: string, right: string) => path.relative(left, right) === "";

/** Read Git's checkout pointers without starting Git or reading working files. */
export async function readGitCheckout(root: string): Promise<GitCheckout | undefined> {
  const marker = path.join(root, ".git");
  const stat = await fs.stat(marker).catch(() => undefined);
  if (stat?.isDirectory()) return { root, gitDir: marker, commonDir: marker, linked: false };
  if (!stat?.isFile()) return undefined;
  const pointer = await fs.readFile(marker, "utf8").catch(() => "");
  const match = /^gitdir: (.+)\r?$/m.exec(pointer);
  if (!match) return undefined;
  const gitDir = path.resolve(root, match[1]!.trim());
  const common = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "");
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
        // A malformed marker still owns the repository boundary.
        if (await fs.lstat(path.join(dir, ".git")).catch(() => undefined)) return undefined;
        const parent = path.dirname(dir);
        return parent === dir ? undefined : find(parent);
      })();
      directories.set(dir, pending);
    }
    return pending;
  };
  const workspace = workspaceRoot ? await readGitCheckout(path.resolve(workspaceRoot)) : undefined;
  const session = cwd ? await find(path.resolve(cwd)) : undefined;
  return {
    checkoutRoot:
      session && workspace && samePath(session.commonDir, workspace.commonDir)
        ? session.root
        : (cwd ?? workspaceRoot),
    async relative(filename: string): Promise<string | undefined> {
      if (!workspaceRoot) return undefined;
      const local = path.relative(workspaceRoot, filename).split(path.sep).join("/");
      // Tent owns this operational directory; these writes still identify Node/Card edits.
      if (local.startsWith(".tent/")) return local;
      const owner = await find(path.dirname(filename));
      if (owner && workspace && !samePath(owner.commonDir, workspace.commonDir)) return undefined;
      if (owner && !workspace) {
        const ownerPath = path.relative(workspaceRoot, owner.root);
        if (
          ownerPath &&
          ownerPath !== ".." &&
          !ownerPath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(ownerPath)
        )
          return undefined;
      }
      const root =
        owner && workspace && samePath(owner.commonDir, workspace.commonDir)
          ? owner.root
          : workspaceRoot;
      const relative = path.relative(root, filename).split(path.sep).join("/");
      return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)
        ? relative
        : undefined;
    },
  };
}
