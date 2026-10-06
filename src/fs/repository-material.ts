import { execFile } from "node:child_process";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { repositoryMaterialSchema, type RepositoryMaterial } from "../core/repository-material.js";
import { checkedSourceFile } from "./checked-source-file.js";

type Repository = { root: string; commonDir: string; gitDir: string; format: string };
/** Cheap filesystem signatures keep a reused adapter's Git discovery honest. */
export class RepositoryMaterialCache {
  repositories = new Map<string, { repository: Promise<Repository>; signature?: string }>();
  tracked = new Map<string, { signature: string; files: Promise<Set<string>> }>();
  worktrees = new Map<string, { signature: string; roots: Promise<string[]> }>();
}
async function signature(filename: string) {
  const stat = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return stat
    ? JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
    : "missing";
}
async function gitBoundary(root: string): Promise<string | undefined> {
  for (let current = path.resolve(root); ;) {
    if (
      await lstat(path.join(current, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
async function boundarySignature(repo: Repository) {
  return JSON.stringify(
    await Promise.all([
      signature(path.join(repo.root, ".git")),
      signature(path.join(repo.commonDir, "config")),
    ]),
  );
}
async function discoverySignature(root: string, repo: Repository) {
  return JSON.stringify([await signature(path.join(root, ".git")), await boundarySignature(repo)]);
}
async function git(args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      { env, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  return stdout.trim();
}
async function discoverRepository(root: string): Promise<Repository> {
  const top = await git(["-C", root, "rev-parse", "--show-toplevel"]);
  const [common, gitDir, format] = await Promise.all([
    git(["-C", top, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(["-C", top, "rev-parse", "--absolute-git-dir"]),
    git(["-C", top, "rev-parse", "--show-object-format"]),
  ]);
  return {
    root: await realpath(top),
    commonDir: await realpath(common),
    gitDir: await realpath(gitDir),
    format,
  };
}
async function repository(root: string, cache: RepositoryMaterialCache) {
  const boundary = await gitBoundary(root);
  if (!boundary) throw new Error("No local repository owns this checkout");
  root = boundary;
  const known = cache.repositories.get(root);
  if (known) {
    const repo = await known.repository;
    if (known.signature === undefined || known.signature === (await discoverySignature(root, repo)))
      return repo;
  }
  const entry: { repository: Promise<Repository>; signature?: string } = {
    repository: discoverRepository(root),
  };
  cache.repositories.set(root, entry);
  try {
    const repo = await entry.repository;
    entry.signature = await discoverySignature(root, repo);
    cache.repositories.set(repo.root, {
      repository: entry.repository,
      signature: await discoverySignature(repo.root, repo),
    });
    return repo;
  } catch (error) {
    cache.repositories.delete(root);
    throw error;
  }
}
async function trackedFiles(repo: Repository, cache: RepositoryMaterialCache) {
  const token = await signature(path.join(repo.gitDir, "index"));
  const known = cache.tracked.get(repo.gitDir);
  if (known?.signature === token) return known.files;
  const files = git(["-C", repo.root, "ls-files", "-z"])
    .then((value) => new Set(value.split("\0")))
    .catch((error) => {
      cache.tracked.delete(repo.gitDir);
      throw error;
    });
  cache.tracked.set(repo.gitDir, { signature: token, files });
  return files;
}
function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Metadata names the safely observed raw bytes, including uncommitted edits. */
export async function observedRepositoryMaterial(
  filename: string,
  blobs: { sha1: string; sha256: string },
  cache = new RepositoryMaterialCache(),
): Promise<RepositoryMaterial | undefined> {
  try {
    const repo = await repository(path.dirname(filename), cache);
    const relative = path.relative(repo.root, filename).split(path.sep).join("/");
    if (!(await trackedFiles(repo, cache)).has(relative)) return undefined;
    const blob = repo.format === "sha256" ? blobs.sha256 : blobs.sha1;
    return repositoryMaterialSchema.parse({ commonDir: repo.commonDir, path: relative, blob });
  } catch {
    // Ordinary local files and untracked outputs still have their observed SHA basis.
    return undefined;
  }
}

/** Locate live bytes only. Stored Git blobs never substitute for a surviving file. */
export async function relocatedRepositoryMaterial(
  workspaceRoot: string,
  basis: RepositoryMaterial,
  cache = new RepositoryMaterialCache(),
) {
  repositoryMaterialSchema.parse(basis);
  const commonDir = await realpath(basis.commonDir);
  const token = JSON.stringify(
    await Promise.all([
      signature(path.join(commonDir, "worktrees")),
      signature(path.join(commonDir, "config")),
    ]),
  );
  let listing = cache.worktrees.get(commonDir);
  if (!listing || listing.signature !== token) {
    listing = {
      signature: token,
      roots: git([`--git-dir=${commonDir}`, "worktree", "list", "--porcelain", "-z"])
        .then((output) =>
          output
            .split("\0")
            .filter((field) => field.startsWith("worktree "))
            .map((field) => field.slice(9)),
        )
        .catch((error) => {
          cache.worktrees.delete(commonDir);
          throw error;
        }),
    };
    cache.worktrees.set(commonDir, listing);
  }
  const checkouts = [...(await listing.roots)];
  // Git lists the main checkout first. Its committed deletions must not be
  // hidden by a live copy left in an older worktree.
  const main = checkouts[0];
  if (main) {
    let missing = false;
    try {
      await checkedSourceFile(main, path.join(main, ...basis.path.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
    }
    if (
      missing &&
      (await git([
        "-C",
        main,
        "log",
        "--full-history",
        "-1",
        "--format=%H",
        "--diff-filter=D",
        "--no-renames",
        "--",
        `:(literal)${basis.path}`,
      ]))
    )
      throw Object.assign(
        new Error(`Repository material was deleted in the main checkout: ${basis.path}`),
        { code: "ENOENT" },
      );
  }
  const current = await repository(workspaceRoot, cache).catch(() => undefined);
  if (current && samePath(current.commonDir, commonDir)) checkouts.unshift(current.root);
  for (const checkout of new Set(checkouts)) {
    if (
      !(await realpath(checkout).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }))
    )
      continue;
    const repo = await repository(checkout, cache).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!repo || !samePath(repo.commonDir, commonDir)) continue;
    const filename = path.join(repo.root, ...basis.path.split("/"));
    try {
      await checkedSourceFile(repo.root, filename);
      if (!(await trackedFiles(repo, cache)).has(basis.path)) continue;
      return { root: repo.root, filename };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw Object.assign(new Error(`Repository material has no surviving local file: ${basis.path}`), {
    code: "ENOENT",
  });
}
