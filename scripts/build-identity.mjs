import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** Capture a build session's checkout and start time; watch rebuilds share the session. */
export function buildIdentity(root) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const git = (args) => {
    if (!existsSync(path.join(root, ".git"))) return null;
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  return {
    version,
    commit,
    builtAt: new Date().toISOString(),
    dirty: status === null ? null : status.length > 0,
  };
}
