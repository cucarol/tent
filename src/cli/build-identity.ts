import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export interface BuildIdentity {
  version: string;
  commit: string | null;
  builtAt: string | null;
  dirty: boolean | null;
}

declare const __TENT_BUILD_IDENTITY_JSON__: string | undefined;
const run = promisify(execFile);

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    await fs.access(path.join(root, ".git"));
    const { stdout } = await run("git", ["-C", root, ...args], {
      windowsHide: true,
      timeout: 2000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function readBuildIdentity(packageRoot: string): Promise<BuildIdentity> {
  if (typeof __TENT_BUILD_IDENTITY_JSON__ !== "undefined")
    return JSON.parse(__TENT_BUILD_IDENTITY_JSON__) as BuildIdentity;
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const [commit, status] = await Promise.all([
    git(packageRoot, ["rev-parse", "HEAD"]),
    git(packageRoot, ["status", "--porcelain"]),
  ]);
  return {
    version: String(pkg.version),
    commit,
    builtAt: null,
    dirty: status === null ? null : status.length > 0,
  };
}

export function formatBuildIdentity(identity: BuildIdentity): string {
  return `Tent ${identity.version} (commit ${identity.commit?.slice(0, 12) ?? "unknown"}; ${
    identity.builtAt ? `built ${identity.builtAt}` : "source"
  }${identity.dirty === true ? "; dirty" : identity.dirty === null ? "; dirty unknown" : ""})`;
}

/** Only compare a positively identified source root, never an arbitrary Workspace Git. */
export async function sourceBuildMismatch(
  workspaceRoot: string,
  identity: BuildIdentity,
): Promise<string | undefined> {
  if (!identity.commit) return;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"));
    if (pkg.name !== "vibe-tent") return;
    await Promise.all([
      fs.access(path.join(workspaceRoot, "src/cli/tent.ts")),
      fs.access(path.join(workspaceRoot, "esbuild.config.mjs")),
      fs.access(path.join(workspaceRoot, ".git")),
    ]);
    const commit = await git(workspaceRoot, ["rev-parse", "HEAD"]);
    if (!commit || commit === identity.commit) return;
    return `Tent runtime build differs from Workspace source: runtime ${identity.commit.slice(0, 12)}, source ${commit.slice(0, 12)}. Rebuild or reinstall from the intended source; different commits do not establish which is older.`;
  } catch {
    return;
  }
}
