import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  isImportConfig,
  isImportSource,
  isTestSource,
  type RepositorySource,
} from "../core/base/repository-imports.js";
import { sourceDirectoryPaths, sourcePathState } from "./directory-observation.js";
import { directoryRepository } from "./repository-material.js";
import { sourceDirectoryRealpath } from "./checked-source-file.js";
import {
  fileState,
  sameFileState,
  stateCacheHit,
  withFileReadScope,
  type FileState,
} from "./file-state-cache.js";

async function git(root: string, args: string[]) {
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

async function repositoryHead(root: string): Promise<string | null> {
  const oid = (
    await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(
      (error: Error & { code?: number }) => {
        if (error.code !== 1) throw error;
        return "";
      },
    )
  ).trim();
  if (!oid) return null;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error("Invalid Git branch basis");
  return oid;
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
  return () =>
    withFileReadScope(async () => {
      const root = await sourceDirectoryRealpath(workspaceRoot);
      const repository = await directoryRepository(root);
      const [head, candidates] = await Promise.all([
        repository ? repositoryHead(repository.root) : Promise.resolve(null),
        sourceDirectoryPaths(
          root,
          root,
          path.join(root, ".tent", ".git", "tent-material-cache"),
          false,
        ),
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
            const info = await sourcePathState(filename);
            if (!info || !info.isFile() || info.isSymbolicLink()) return;
            const state = fileState(info);
            const file = path.relative(root, filename).split(path.sep).join("/");
            const known = cached.get(file);
            const hit = known && stateCacheHit(state, known.state, known.writtenAtNs);
            current.set(file, {
              state,
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
                throw new Error(
                  `${file}: ${error instanceof Error ? error.message : String(error)}`,
                );
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
      for (let start = 0; changed.length && start < checkedDirectories.length; start += 32)
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
      return { basis: { head }, sources: previous! };
    });
}
