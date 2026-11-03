import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { formatCliTime } from "./time-text.js";

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
    identity.builtAt ? `built ${formatCliTime(identity.builtAt)}` : "source"
  }${identity.dirty === true ? "; dirty" : identity.dirty === null ? "; dirty unknown" : ""})`;
}
