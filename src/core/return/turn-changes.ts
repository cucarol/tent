import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readGitCheckout } from "../workspace/git-checkout.js";

export type TurnStart = { startedAt: number; head: string | null };
export type DirtyPath = { address: string; directory: boolean };
export type TurnDirtyPaths = { paths: DirtyPath[]; ignored: string[] };

const eligible = (file: string) =>
  !!file &&
  !path.isAbsolute(file) &&
  !/[\u0000-\u001f]/.test(file) &&
  !file
    .split("/")
    .some(
      (part) =>
        part === ".." ||
        [".git", ".tent"].includes(process.platform === "win32" ? part.toLowerCase() : part),
    );

async function readMetadata(filename: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

/** Direct Git pointer/ref files only: no child process or project-file observation. */
export async function readTurnHead(root: string): Promise<string | null> {
  const checkout = await readGitCheckout(root);
  if (!checkout) throw new Error("Not a Git checkout");
  let value = await readMetadata(path.join(checkout.gitDir, "HEAD"));
  const visited = new Set<string>();
  for (;;) {
    if (value && /^[a-f0-9]{40}(?:[a-f0-9]{24})?\s*$/.test(value)) return value.trim();
    const ref = /^ref: (refs\/[^\s]+)\s*$/.exec(value ?? "")?.[1];
    if (
      !ref ||
      /[\u0000-\u0020\u007f~^:?*\[\\]/.test(ref) ||
      ref.includes("..") ||
      ref.includes("@{") ||
      ref.endsWith(".") ||
      ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")) ||
      visited.has(ref)
    )
      throw new Error("Git HEAD is unavailable");
    visited.add(ref);
    value = await readMetadata(path.join(checkout.gitDir, ref));
    if (value === undefined && checkout.gitDir !== checkout.commonDir)
      value = await readMetadata(path.join(checkout.commonDir, ref));
    if (value !== undefined) continue;
    const packed = await readMetadata(path.join(checkout.commonDir, "packed-refs"));
    const match = packed?.split(/\r?\n/).find((line) => line.endsWith(" " + ref));
    if (match && /^[a-f0-9]{40}(?:[a-f0-9]{24})? /.test(match)) return match.split(" ")[0]!;
    if (await fs.stat(path.join(checkout.commonDir, "reftable")).catch(() => undefined))
      throw new Error("Git reftable HEAD is unavailable");
    return null;
  }
}

export async function startTurnObservation(
  root: string,
  startedAt = Date.now(),
): Promise<TurnStart> {
  return { startedAt, head: await readTurnHead(root) };
}

async function git(root: string, args: string[]): Promise<string> {
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
      {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
          ),
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

/** NUL-delimited porcelain v2, with rename detection disabled by the caller. */
export function parseTurnStatus(raw: string): TurnDirtyPaths {
  const paths = new Map<string, DirtyPath>();
  const ignored: string[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    const parts = entry.split(" ");
    if (entry.startsWith("! ")) {
      ignored.push(entry.slice(2));
      continue;
    }
    let address: string;
    if (entry.startsWith("? ")) address = entry.slice(2);
    else if (["1", "2", "u"].includes(parts[0] ?? "")) {
      if (parts[2]?.startsWith("S") || parts.slice(3, 7).includes("160000")) {
        if (parts[0] === "2") i++;
        continue;
      }
      address = parts.slice(parts[0] === "u" ? 10 : parts[0] === "2" ? 9 : 8).join(" ");
      if (parts[0] === "2") i++;
    } else continue;
    if (eligible(address))
      paths.set(address, { address, directory: entry.startsWith("? ") && address.endsWith("/") });
  }
  return { paths: [...paths.values()], ignored };
}

export async function turnDirtyPaths(root: string): Promise<TurnDirtyPaths> {
  return parseTurnStatus(
    await git(root, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=normal",
      "--ignored=matching",
      "--ignore-submodules=all",
      "--no-renames",
    ]),
  );
}

/** Status supplies candidates; timestamp is intentionally the accepted change heuristic. */
export async function changedTurnFiles(
  root: string,
  before: TurnStart,
  previousDirty?: readonly string[],
  observed?: TurnDirtyPaths,
): Promise<string[]> {
  const status = observed ?? (await turnDirtyPaths(root));
  const candidates = status.paths.map((item) => ({ ...item, fromStatus: true }));
  const current = await readTurnHead(root);
  if (current !== before.head && current) {
    const emptyTree = createHash(current.length === 64 ? "sha256" : "sha1")
      .update("tree 0\0")
      .digest("hex");
    const committed = await git(root, [
      "diff",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "-z",
      before.head ?? emptyTree,
      current,
    ]);
    for (const address of committed.split("\0"))
      if (eligible(address)) candidates.push({ address, directory: false, fromStatus: false });
  }
  const files = new Set<string>();
  const seen = new Set<string>();
  const previouslyDirty = previousDirty ? new Set(previousDirty) : undefined;
  const directories = new Map<string, Promise<boolean>>();
  const stat = async (address: string) => {
    try {
      return await fs.lstat(path.join(root, address));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
  };
  const local = (directory: string): Promise<boolean> => {
    if (directory === ".") return Promise.resolve(true);
    const known = directories.get(directory);
    if (known !== undefined) return known;
    const pending = (async () => {
      if (!(await local(path.posix.dirname(directory)))) return false;
      const [state, marker] = await Promise.all([
        stat(directory),
        stat(path.posix.join(directory, ".git")),
      ]);
      return !state?.isSymbolicLink() && !marker;
    })();
    directories.set(directory, pending);
    return pending;
  };
  const inspect = async (item: (typeof candidates)[number]): Promise<void> => {
    const { directory, fromStatus } = item;
    const address = item.address.replace(/\/$/, "");
    const compare = process.platform === "win32" ? address.toLowerCase() : address;
    if (
      !fromStatus &&
      status.ignored.some((value) => {
        const ignored = process.platform === "win32" ? value.toLowerCase() : value;
        return (
          compare === ignored.replace(/\/$/, "") ||
          (ignored.endsWith("/") && compare.startsWith(ignored))
        );
      })
    )
      return;
    if (!eligible(address) || seen.has(address)) return;
    seen.add(address);
    if (!fromStatus && !(await local(path.posix.dirname(address)))) return;
    const state = await stat(address);
    if (!state) {
      if (previouslyDirty && !previouslyDirty.has(address)) files.add(address);
      return;
    }
    if (state.mtimeMs < before.startedAt) return;
    if (directory && state.isDirectory() && !state.isSymbolicLink()) {
      if (!fromStatus && !(await local(address))) return;
      for (const entry of await fs.readdir(path.join(root, address), { withFileTypes: true }))
        candidates.push({
          address: path.posix.join(address, entry.name),
          directory: entry.isDirectory(),
          fromStatus: false,
        });
    } else if (state.isFile() || state.isSymbolicLink()) files.add(address);
  };
  // Direct status facts need only their own metadata. Enumerated/committed paths
  // retain the shared ancestor proof. Drain each bounded concurrent batch on errors.
  for (let start = 0; start < candidates.length;) {
    const batch = candidates.slice(start, start + 64);
    start += batch.length;
    const results = await Promise.allSettled(batch.map(inspect));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  return [...files].sort();
}
