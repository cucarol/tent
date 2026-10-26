import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { scaffoldTent } from "../core/store/scaffold.js";
import { TENT_SYSTEM_DIR } from "../core/base/paths.js";
import { NodeFs } from "./node-fs.js";
import { renameWithRetry } from "./rename-with-retry.js";
import { SqliteDocumentHistory } from "../core/store/sqlite-history.js";
import { initializeGitIgnoreContext } from "./git-ignore-context.js";

const execute = promisify(execFile);

/** Initialize an empty Tent and its independent SQLite history. */
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
  await fs.mkdir(root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, ".tent-init-"));
  try {
    const adapter = new NodeFs(staging);
    try {
      await scaffoldTent(adapter, { name: path.basename(root) });
      await (adapter.history as SqliteDocumentHistory).initialize();
      await initializeGitIgnoreContext(staging);
    } finally {
      await adapter.close();
    }
    await ensureWorkspaceGitExclude(root, git);
    // Publish a complete, verified Tent. Failed preparation never creates a ready marker.
    await renameWithRetry(staging, systemRoot);
  } catch (error) {
    if (path.dirname(staging) !== root || !path.basename(staging).startsWith(".tent-init-"))
      throw error;
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Keep local Tent state out of the project repository without changing project files. */
export async function ensureWorkspaceGitExclude(
  root: string,
  git: (args: string[]) => Promise<{ stdout: string }>,
): Promise<void> {
  let excludePath: string;
  try {
    const { stdout } = await git(["-C", root, "rev-parse", "--git-path", "info/exclude"]);
    excludePath = path.resolve(root, stdout.trim());
  } catch (error) {
    // Git is optional for SQLite initialization; no project repository is created.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (
      (error as { code?: number }).code === 128 &&
      /not a git repository/i.test((error as { stderr?: string }).stderr ?? "")
    )
      return;
    throw error;
  }
  const raw = await fs.readFile(excludePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  const entry = `${TENT_SYSTEM_DIR}/`;
  if (
    raw
      .toString("utf8")
      .split(/\r?\n/)
      .some((line) =>
        [entry, TENT_SYSTEM_DIR, `/${entry}`, `/${TENT_SYSTEM_DIR}`].includes(line.trim()),
      )
  )
    return;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const separator = raw.length && raw[raw.length - 1] !== 10 ? "\n" : "";
  await fs.writeFile(excludePath, Buffer.concat([raw, Buffer.from(`${separator}${entry}\n`)]));
}
