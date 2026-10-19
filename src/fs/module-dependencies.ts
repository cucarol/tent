import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  isImportConfig,
  isImportSource,
  isTestSource,
  type RepositorySource,
} from "../core/base/repository-imports.js";
import { sourceDirectoryPaths } from "./directory-observation.js";
import { directoryRepository } from "./repository-material.js";
import { fileState, sameFileState, stateCacheHit, type FileState } from "./file-state-cache.js";

async function git(root: string, args: string[], config: string[] = []) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      [
        "--no-optional-locks",
        "--no-lazy-fetch",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...config,
        "-C",
        root,
        ...args,
      ],
      { env, windowsHide: true, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(new Error(stderr.trim() || error.message), { code: error.code }))
          : resolve(stdout),
    ),
  );
}

async function repositoryBasis(root: string, workspaceRoot: string) {
  // Read every effective filter name, including includes/global/worktree config.
  // Empty commands and required=false make status use only Git's built-in conversions.
  const configured = await git(root, [
    "config",
    "--null",
    "--get-regexp",
    "^filter\\..*\\.(clean|process|required)$",
  ]).catch((error: Error & { code?: number }) => {
    if (error.code !== 1) throw error;
    return "";
  });
  const filters = new Set(
    configured
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const key = entry.slice(0, entry.indexOf("\n"));
        const filter = /^filter\.([\s\S]+)\.(?:clean|process|required)$/.exec(key);
        if (!filter) throw new Error("Invalid Git filter configuration listing");
        return filter[1]!;
      }),
  );
  const config = [...filters].flatMap((filter) => [
    "-c",
    `filter.${filter}.clean=`,
    "-c",
    `filter.${filter}.process=`,
    "-c",
    `filter.${filter}.required=false`,
  ]);
  const fields = (
    await git(
      root,
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "--ignore-submodules=all",
        "-z",
        "--",
        `:(literal)${path.relative(root, workspaceRoot).split(path.sep).join("/") || "."}`,
      ],
      config,
    )
  )
    .split("\0")
    .filter(Boolean);
  const oid = fields.find((field) => field.startsWith("# branch.oid "))?.slice(13);
  if (!oid || (oid !== "(initial)" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))
    throw new Error("Invalid Git branch basis");
  return {
    head: oid === "(initial)" ? null : oid,
    dirty: fields.some((field) => !field.startsWith("# ")),
  };
}

async function signature(filename: string) {
  const info = await lstat(filename, { bigint: true });
  return {
    info,
    state: fileState(info),
  };
}

type CachedSource = { state: FileState; writtenAtNs: string; source: RepositorySource };

/** Current nonignored Workspace files and project Git basis; only process-local content caching. */
export function createModuleDependencyRepositoryReader(workspaceRoot: string) {
  let previous: RepositorySource[] | undefined;
  let cached = new Map<string, CachedSource>();
  return async () => {
    const root = await realpath(workspaceRoot);
    const repository = await directoryRepository(root);
    const [basis, candidates] = await Promise.all([
      repository
        ? repositoryBasis(repository.root, root)
        : Promise.resolve({ head: null, dirty: true }),
      sourceDirectoryPaths(root, root, path.join(root, ".tent", ".git", "tent-material-cache")),
    ]);
    const directories = new Map<string, Promise<boolean>>();
    async function plainDirectory(directory: string): Promise<boolean> {
      if (directory === root) return true;
      let checked = directories.get(directory);
      if (!checked) {
        checked = (async () => {
          if (!(await plainDirectory(path.dirname(directory)))) return false;
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) return false;
          // A nested repository owns its own code and dirty state.
          const boundary = await lstat(path.join(directory, ".git")).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          return boundary === undefined;
        })();
        directories.set(directory, checked);
      }
      return checked;
    }
    const current = new Map<string, CachedSource>();
    const changed: string[] = [];
    const filenames = [...new Set(candidates)].filter((filename) => {
      const relative = path.relative(root, filename);
      return !relative
        .split(path.sep)
        .some((part) => [".git", ".tent"].includes(part.toLowerCase()));
    });
    for (let start = 0; start < filenames.length; start += 32)
      await Promise.all(
        filenames.slice(start, start + 32).map(async (filename) => {
          if (!(await plainDirectory(path.dirname(filename)))) return;
          const observed = await signature(filename).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (!observed || !observed.info.isFile() || observed.info.isSymbolicLink()) return;
          const file = path.relative(root, filename).split(path.sep).join("/");
          const known = cached.get(file);
          const hit = known && stateCacheHit(observed.state, known.state, known.writtenAtNs);
          current.set(file, {
            state: observed.state,
            writtenAtNs: hit ? known.writtenAtNs : String(BigInt(Date.now()) * 1_000_000n),
            source: hit ? known.source : { path: file },
          });
          if (!hit && (isImportConfig(file) || (isImportSource(file) && !isTestSource(file))))
            changed.push(file);
        }),
      );
    if (changed.length) {
      for (let start = 0; start < changed.length; start += 32)
        await Promise.all(
          changed.slice(start, start + 32).map(async (file) => {
            const entry = current.get(file)!;
            // Parent directories and regular-file signatures were checked above;
            // reuse those checks rather than repeating every ancestor per source.
            let content: string;
            try {
              content = await readFile(path.join(root, file), "utf8");
            } catch (error) {
              throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!sameFileState((await signature(path.join(root, file))).state, entry.state))
              throw new Error(`Repository source changed while reading: ${file}`);
            entry.source = { path: file, content };
            entry.writtenAtNs = String(BigInt(Date.now()) * 1_000_000n);
          }),
        );
    }
    // Reject a parent replacement while bytes were read, including symlink/junction swaps.
    const checkedDirectories = [
      root,
      ...(
        await Promise.all(
          [...directories].map(async ([directory, checked]) =>
            (await checked) ? directory : undefined,
          ),
        )
      ).filter((directory): directory is string => directory !== undefined),
    ];
    for (let start = 0; start < checkedDirectories.length; start += 32)
      await Promise.all(
        checkedDirectories.slice(start, start + 32).map(async (directory) => {
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Repository source parent changed while reading");
        }),
      );
    const sources = [...current.values()]
      .map((entry) => entry.source)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const same =
      previous?.length === sources.length &&
      sources.every(
        (source, i) =>
          source.path === previous![i]!.path && source.content === previous![i]!.content,
      );
    cached = current;
    previous = same ? previous : sources;
    return { basis, sources: previous! };
  };
}
