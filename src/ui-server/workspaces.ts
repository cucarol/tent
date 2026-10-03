// The workspaces `tent ui` has opened, for the switcher in the page. A per-user convenience kept
// outside every workspace: it is not Tent data, and losing it only empties the list.
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type KnownWorkspace = { root: string; name: string; id: string; openedAt: string };

const LIMIT = 12;
const writes = new Map<string, Promise<void>>();

/**
 * The per-user file that remembers opened workspaces. It must not sit in a `.tent` folder under the
 * home directory, where workspace discovery would take the home directory for a workspace.
 */
export function defaultWorkspacesFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  const dir =
    platform === "win32"
      ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "tent")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", "tent")
        : path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "tent");
  return path.join(dir, "ui-workspaces.json");
}

/** One spelling per folder: Windows paths compare without case. */
export function workspaceKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Newest first; a missing or unreadable file is an empty list. */
export async function readWorkspaces(file: string): Promise<KnownWorkspace[]> {
  try {
    const data = JSON.parse(await fsp.readFile(file, "utf8")) as { workspaces?: unknown };
    if (!Array.isArray(data.workspaces)) return [];
    return data.workspaces.filter(
      (w): w is KnownWorkspace =>
        !!w &&
        typeof w.root === "string" &&
        typeof w.name === "string" &&
        typeof w.id === "string" &&
        typeof w.openedAt === "string",
    );
  } catch {
    return [];
  }
}

/** Puts a workspace at the front of the list; the file is replaced whole, never left half written. */
export async function rememberWorkspace(
  file: string,
  workspace: Omit<KnownWorkspace, "openedAt">,
  now = new Date(),
): Promise<void> {
  const fileKey = workspaceKey(file);
  const write = async () => {
    const key = workspaceKey(workspace.root);
    const rest = (await readWorkspaces(file)).filter((w) => workspaceKey(w.root) !== key);
    const workspaces = [{ ...workspace, openedAt: now.toISOString() }, ...rest].slice(0, LIMIT);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ version: 1, workspaces }, null, 2) + "\n");
    await fsp.rename(temp, file);
  };
  const pending = (writes.get(fileKey) ?? Promise.resolve()).then(write, write);
  writes.set(fileKey, pending);
  try {
    await pending;
  } finally {
    if (writes.get(fileKey) === pending) writes.delete(fileKey);
  }
}
