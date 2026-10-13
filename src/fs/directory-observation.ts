import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedSourceFile } from "./checked-source-file.js";
import { directoryRepository } from "./repository-material.js";
import { isTentWorkspacePath } from "../core/material-coverage.js";

/** No caller Git environment or external filters affect the observed bytes. */
async function git(
  root: string,
  args: string[],
  input?: string,
  environment: Record<string, string> = {},
  acceptedExitCodes: readonly number[] = [0],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [
        "--no-optional-locks",
        "--no-lazy-fetch",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.ignoreStat=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        root,
        ...args,
      ],
      {
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
          ),
          ...environment,
        },
      },
      (error, output, diagnostic) =>
        error && !acceptedExitCodes.includes(Number(error.code))
          ? reject(error)
          : diagnostic.length
            ? reject(new Error(diagnostic.toString("utf8").trim()))
            : resolve(output),
    );
    child.stdin?.end(input);
  });
}

/** Read only ignore rules, using one subprocess for all uncovered local writes. */
export async function nonignoredLocalFiles(
  workspaceRoot: string,
  addresses: readonly string[],
  tentGit: string,
): Promise<string[] | undefined> {
  try {
    const repository = await directoryRepository(workspaceRoot);
    if (!repository && !(await lstat(path.join(tentGit, "HEAD"))).isFile()) return undefined;
    const root = repository?.root ?? workspaceRoot;
    const candidates: Array<{ address: string; relative: string }> = [];
    for (const address of addresses) {
      const filename = address.startsWith("file:")
        ? fileURLToPath(address)
        : path.resolve(workspaceRoot, address);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (
        !isTentWorkspacePath(path.relative(workspaceRoot, filename).split(path.sep).join("/")) &&
        relative &&
        relative !== ".." &&
        !relative.startsWith("../") &&
        !path.isAbsolute(relative) &&
        (await checkedSourceFile(root, filename).then(
          () => true,
          () => false,
        ))
      )
        candidates.push({ address, relative });
    }
    if (!candidates.length) return [];
    if (!repository) {
      const present = new Set(
        (
          await borrowedFiles(
            root,
            tentGit,
            candidates.map((file) => file.relative),
          )
        ).map((filename) => (process.platform === "win32" ? filename.toLowerCase() : filename)),
      );
      return candidates.flatMap((file) =>
        present.has(process.platform === "win32" ? file.relative.toLowerCase() : file.relative)
          ? [file.address]
          : [],
      );
    }
    const output = await git(
      root,
      ["check-ignore", "--no-index", "--verbose", "--non-matching", "-z", "--stdin"],
      candidates.map((file) => file.relative).join("\0") + "\0",
      { GIT_CEILING_DIRECTORIES: path.dirname(root) },
      [0, 1],
    );
    // Unlike ls-files, verbose non-matches have three meaningful empty fields.
    const fields = output.toString("utf8").split("\0");
    if (fields.pop() !== "" || fields.length !== candidates.length * 4) return undefined;
    return candidates.flatMap((file, index) => {
      const [source, , pattern, filename] = fields.slice(index * 4, index * 4 + 4);
      if (filename !== file.relative) throw new Error("Invalid Git ignore listing");
      return !source || pattern?.startsWith("!") ? [file.address] : [];
    });
  } catch {
    return undefined;
  }
}
function names(bytes: Buffer) {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

/** Existing Tent Git supplies only the Workspace's per-directory ignore engine. */
async function borrowedFiles(root: string, gitDir: string, scopes: readonly string[]) {
  const output = await git(
    root,
    [
      "--git-dir",
      gitDir,
      "--work-tree",
      root,
      "ls-files",
      "--others",
      "--exclude-per-directory=.gitignore",
      "-z",
      "--",
      ...scopes.map((scope) => `:(literal)${scope || "."}`),
      `:(exclude,${process.platform === "win32" ? "icase," : ""}literal).tent`,
    ],
    undefined,
    {
      GIT_INDEX_FILE: path.join(
        gitDir,
        `tent-directory-read-${process.pid}-${Math.random().toString(36).slice(2)}.index`,
      ),
      GIT_OPTIONAL_LOCKS: "0",
    },
  );
  return names(output);
}

// A standalone read may traverse a rule-free tree, but cannot approximate Git's
// ignore language when neither a project repository nor Tent Git is available.
async function requireNoIgnoreRules(folder: string) {
  const text = await readFile(path.join(folder, ".gitignore"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (text.split(/\r?\n/).some((line) => line.trim() && !line.startsWith("#")))
    throw new Error("缺少可信的忽略规则解释");
}

async function plainFiles(
  root: string,
  directory: string,
  cacheDir?: string,
  candidatesOnly = false,
): Promise<Array<{ filename: string; directory?: true }>> {
  const gitDir = cacheDir ? path.dirname(cacheDir) : undefined;
  if (
    gitDir &&
    (await lstat(path.join(gitDir, "HEAD"))
      .then((info) => info.isFile())
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }))
  ) {
    const relative = path.relative(root, directory).split(path.sep).join("/");
    // The existing Tent repository supplies Git's ignore engine only. A distinct,
    // nonexistent index keeps Tent's tracked paths out of the Workspace listing.
    // --exclude-per-directory deliberately excludes Tent info/exclude and global rules.
    return (await borrowedFiles(root, gitDir, [relative]))
      .filter((name) => !name.split("/").includes(".git") && !isTentWorkspacePath(name))
      .map((name) => ({
        filename: path.join(root, name),
        ...(name.endsWith("/") ? { directory: true as const } : {}),
      }));
  }
  const files: string[] = [];
  const segments = path.relative(root, directory).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    await requireNoIgnoreRules(current);
  }
  async function walk(folder: string, load = true) {
    await checkedSourceFile(root, folder, true);
    if (load) await requireNoIgnoreRules(folder);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const filename = path.join(folder, entry.name);
      if (isTentWorkspacePath(path.relative(root, filename).split(path.sep).join("/"))) continue;
      if (entry.isSymbolicLink() && candidatesOnly) {
        files.push(filename);
        continue;
      }
      if (entry.isSymbolicLink())
        throw new Error("Symbolic links are not supported for source files");
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await walk(directory, false);
  return files.map((filename) => ({ filename }));
}

/** List candidate paths; callers validate member types after applying their coverage. */
export async function sourceDirectoryPaths(
  root: string,
  directory: string,
  cacheDir?: string,
  trackedOnly = false,
): Promise<string[]> {
  if (isTentWorkspacePath(path.relative(root, directory).split(path.sep).join("/"))) return [];
  await checkedSourceFile(root, directory, true);
  const repo = await directoryRepository(directory);
  if (!repo) {
    if (trackedOnly)
      throw new Error("Prefix material unavailable: no owning project Git repository");
    const entries = await plainFiles(root, directory, cacheDir, true);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.directory)
        files.push(...(await sourceDirectoryPaths(root, entry.filename, cacheDir)));
      else files.push(entry.filename);
    }
    return files;
  }
  const relative = path.relative(repo.root, directory).split(path.sep).join("/");
  const scope = `:(literal)${relative || "."}`;
  const workspace = path.relative(repo.root, root).split(path.sep).join("/");
  // A nested repository cannot accept a pathspec for its enclosing Workspace.
  // The per-file boundary below still excludes that Workspace's Tent state.
  const excludeTent =
    workspace === ".." || workspace.startsWith("../") || path.isAbsolute(workspace)
      ? []
      : [
          `:(exclude,${process.platform === "win32" ? "icase," : ""}literal)${workspace ? workspace + "/" : ""}.tent`,
        ];
  const [listed, excluded] = await Promise.all([
    git(repo.root, [
      "ls-files",
      "--cached",
      ...(trackedOnly ? ["--stage"] : []),
      ...(trackedOnly ? [] : ["--others", "--exclude-standard"]),
      "-z",
      "--",
      scope,
      ...excludeTent,
    ]),
    trackedOnly
      ? Promise.resolve(Buffer.alloc(0))
      : git(repo.root, [
          "ls-files",
          "--cached",
          "--ignored",
          "--exclude-standard",
          "-z",
          "--",
          scope,
          ...excludeTent,
        ]),
  ]);
  const ignored = new Set(names(excluded));
  const files = new Set<string>();
  const candidates = trackedOnly
    ? names(listed).flatMap((entry) => {
        const match = /^(\d+) [a-f0-9]+ \d\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error("Invalid Git tracked material listing");
        // Gitlinks identify repositories rather than tracked files in this checkout.
        return match[1] === "160000" ? [] : [match[2]!];
      })
    : names(listed);
  for (let start = 0; start < candidates.length; start += 32) {
    const observed = await Promise.all(
      candidates.slice(start, start + 32).map(async (name) => {
        if (ignored.has(name) || name.split("/").includes(".git")) return undefined;
        const filename = path.join(repo.root, name);
        if (isTentWorkspacePath(path.relative(root, filename).split(path.sep).join("/")))
          return undefined;
        const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        return info ? { filename, info } : undefined;
      }),
    );
    for (const entry of observed) {
      if (!entry) continue;
      const { filename, info } = entry;
      if (info.isSymbolicLink()) {
        files.add(filename);
        continue;
      }
      if (info.isDirectory()) {
        if (trackedOnly) {
          files.add(filename);
          continue;
        }
        if (path.relative(directory, filename) === "") {
          // A gitlink without nested metadata is still listed at its own scope root.
          // Use the existing ignore engine with a nonexistent index; no content read is needed.
          const children = await git(
            repo.root,
            ["ls-files", "--others", "--exclude-standard", "-z", "--", scope, ...excludeTent],
            undefined,
            {
              GIT_INDEX_FILE: path.join(
                repo.root,
                `.tent-directory-read-${process.pid}-${Math.random().toString(36).slice(2)}.index`,
              ),
              GIT_OPTIONAL_LOCKS: "0",
            },
          );
          for (const member of names(children)) {
            const child = path.join(repo.root, member);
            if (isTentWorkspacePath(path.relative(root, child).split(path.sep).join("/"))) continue;
            if (member.endsWith("/"))
              for (const nested of await sourceDirectoryPaths(root, child, cacheDir))
                files.add(nested);
            else files.add(child);
          }
        } else {
          for (const member of await sourceDirectoryPaths(root, filename, cacheDir))
            files.add(member);
        }
      } else if (info.isFile()) files.add(filename);
      else throw new Error("Directory member is not a readable source file");
    }
  }
  await checkedSourceFile(root, directory, true);
  return [...files].sort();
}
