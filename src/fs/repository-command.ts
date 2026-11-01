import { execFile } from "node:child_process";

/** Read-only Git invocation shared by current facts and historical analysis. */
export async function repositoryCommand(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      [
        "--no-optional-locks",
        "--no-lazy-fetch",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        root,
        ...args,
      ],
      { env, windowsHide: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(new Error(stderr.trim() || error.message), { code: error.code }))
          : resolve(stdout),
    ),
  );
}
