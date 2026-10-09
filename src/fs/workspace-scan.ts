import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  workspaceScanCommitLimit,
  type ScanCommit,
  type WorkspaceScanRepository,
} from "../core/workspace-scan.js";
import { selectSection } from "../core/markdown-section.js";
import { parseFrontmatter } from "../core/frontmatter.js";

async function git(root: string, args: string[]): Promise<string> {
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

/** NUL-prefixed commit headers are distinct from even SHA-shaped or newline filenames. */
export function parseScanGitLog(raw: string): ScanCommit[] {
  const fields = raw.split("\0");
  const commits: ScanCommit[] = [];
  let index = 0;
  while (index < fields.length) {
    if (fields[index] !== "" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fields[index + 1] ?? "")) {
      index++;
      continue;
    }
    const commit = fields[++index]!;
    index++;
    const files: string[] = [];
    if (fields[index]?.startsWith("\n")) fields[index] = fields[index]!.slice(1);
    while (index < fields.length && fields[index] !== "") files.push(fields[index++]!);
    commits.push({ commit, files: [...new Set(files)], changedFiles: new Set(files).size });
  }
  return commits;
}

/** Git queries never refresh the index or create lock, cache, hook or model state. */
export async function readWorkspaceScanRepository(
  workspaceRoot: string,
  commitLimit?: number,
): Promise<WorkspaceScanRepository> {
  const limit = workspaceScanCommitLimit(commitLimit);
  const root = (await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim();
  const prefix = path.relative(root, workspaceRoot).split(path.sep).join("/");
  const workspacePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const workspaceFile = (file: string) => {
    if (!prefix) return file;
    const candidate = process.platform === "win32" ? file.toLowerCase() : file;
    return candidate.startsWith(`${workspacePrefix}/`) ? file.slice(prefix.length + 1) : undefined;
  };
  const list = (raw: string) =>
    raw
      .split("\0")
      .filter(Boolean)
      .flatMap((file) => {
        const relative = workspaceFile(file);
        return relative === undefined ? [] : [relative];
      });
  const heads = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(
    (error: Error & { code?: number | string }) => {
      if (error.code !== 1) throw error;
      return "";
    },
  );
  const head = heads.trim() || null;
  const [tracked, others, log] = await Promise.all([
    git(root, ["ls-files", "--cached", "-z"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    head
      ? git(root, [
          "log",
          `-${limit}`,
          "--format=%x00%H",
          "-z",
          "--name-only",
          "--root",
          "--no-renames",
          "--no-show-signature",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          "--diff-merges=first-parent",
          head,
        ])
      : Promise.resolve(""),
  ]);
  const trackedFiles = list(tracked);
  return {
    head,
    trackedFiles,
    markdownFiles: [...new Set([...trackedFiles, ...list(others)])].filter(
      (file) =>
        /\.(md|markdown)$/i.test(file) &&
        !(process.platform === "win32" ? file.toLowerCase() : file).startsWith(".tent/"),
    ),
    commits: parseScanGitLog(log).map((commit) => ({
      ...commit,
      files: commit.files.flatMap((file) => {
        const relative = workspaceFile(file);
        return relative === undefined ? [] : [relative];
      }),
    })),
  };
}

export async function scanFileKind(
  filename: string,
  heading?: string,
): Promise<"file" | "directory" | undefined> {
  try {
    const info = await lstat(filename);
    if (info.isDirectory()) return "directory";
    if (!info.isFile()) return;
    if (heading !== undefined) {
      const raw = await readFile(filename, "utf8");
      try {
        selectSection(parseFrontmatter(raw).body, heading);
      } catch {
        return;
      }
    }
    return "file";
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}
