import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fileState,
  isFileState,
  sameFileState,
  stateCacheHit,
  type FileState,
} from "./file-state-cache.js";

type Witness =
  | { filename: string; kind: "file" | "directory"; state: FileState }
  | {
      filename: string;
      kind: "missing";
    };

/** Serializable evidence only; the caller owns persistence and payload validation. */
export type PreparedRepositoryObservation<T> = {
  schema: 2;
  workspaceRoot: string;
  writtenAtNs: string;
  environment: string;
  entries: Witness[];
  value: T;
};

const entryLimit = 4096;
const gitEnvironmentKeys = new Set([
  "HOME",
  "XDG_CONFIG_HOME",
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "COMSPEC",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
]);
const environment = () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(process.env)
          .filter(([key]) => gitEnvironmentKeys.has(key.toUpperCase()) || /^LC_/i.test(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

async function sample(filename: string): Promise<Witness> {
  try {
    const stat = await fs.lstat(filename, { bigint: true });
    if (!stat.isFile() && !stat.isDirectory()) throw new Error("Unsupported repository entry");
    return { filename, kind: stat.isFile() ? "file" : "directory", state: fileState(stat) };
  } catch (error) {
    if (missing(error)) return { filename, kind: "missing" };
    throw error;
  }
}

function equal(a: Witness, b: Witness): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "missing" || (b.kind !== "missing" && sameFileState(a.state, b.state)))
  );
}

async function git(root: string, args: string[], absent = false): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      ["--no-optional-locks", "--no-lazy-fetch", "-C", root, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
        ),
      },
      (error, stdout) =>
        error && !(absent && Number(error.code) === 1) ? reject(error) : resolve(stdout),
    ),
  );
}

/**
 * Capture only ordinary repository-root checkouts. Unknown Git configuration,
 * linked worktrees, nested repositories, links and oversized trees use Git again.
 * The loader must read current checkout/index-derived JSON. History/object reads
 * and unrelated external data are outside this witness.
 */
export async function prepareRepositoryObservation<T>(
  workspaceRoot: string,
  loader: () => Promise<T>,
): Promise<PreparedRepositoryObservation<T> | undefined> {
  try {
    if (process.platform === "win32" && !process.env.PROGRAMDATA) return;
    const root = path.resolve(workspaceRoot);
    const writtenAtNs = String(BigInt(Date.now()) * 1_000_000n);
    const observedEnvironment = environment();
    if (path.resolve(await fs.realpath(root)) !== root) return;
    const marker = await sample(path.join(root, ".git"));
    if (marker.kind !== "directory") return;
    const [top, directory, system, global] = await Promise.all([
      git(root, ["rev-parse", "--show-toplevel"]),
      git(root, ["rev-parse", "--absolute-git-dir"]),
      // Git itself supplies even nonexistent compiled-in/default config paths.
      // Older versions without these vars deliberately cannot prepare a snapshot.
      git(root, ["var", "GIT_CONFIG_SYSTEM"]),
      git(root, ["var", "GIT_CONFIG_GLOBAL"]),
    ]);
    if (
      path.resolve(top.trim()) !== root ||
      path.resolve(directory.trim()) !== path.join(root, ".git")
    )
      return;
    const paths = new Set<string>();
    const addPath = (filename: string) => {
      if (!filename || filename.includes("\0") || /[\r\n]/.test(filename))
        throw new Error("Unsupported config path");
      paths.add(path.resolve(root, filename));
    };
    for (const filename of [...system.trim().split("\n"), ...global.trim().split("\n")])
      addPath(filename.replace(/\r$/, ""));
    const home = process.env.HOME || os.homedir();
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    for (const filename of [
      path.join(home, ".gitconfig"),
      path.join(xdg, "git", "config"),
      path.join(home, ".config", "git", "config"),
      ...(process.platform === "win32"
        ? [path.join(process.env.PROGRAMDATA!, "Git", "config")]
        : []),
      path.join(root, ".git", "config"),
      path.join(root, ".git", "config.worktree"),
    ])
      addPath(filename);

    const entries = new Map<string, Witness>();
    async function observe(filename: string): Promise<Witness> {
      const previous = entries.get(filename);
      if (previous) return previous;
      if (entries.size >= entryLimit) throw new Error("Repository witness exceeds limit");
      const entry = await sample(filename);
      entries.set(filename, entry);
      return entry;
    }
    // Parent metadata only guards the preparation interval against a transient
    // create/remove of a missing configuration file. It is not a reuse witness:
    // unrelated home-directory writes do not change Git's configuration inputs.
    const preparationParents = new Map<string, Witness>();
    async function preparationParent(filename: string) {
      let entry = preparationParents.get(filename);
      if (!entry) {
        entry = await sample(filename);
        preparationParents.set(filename, entry);
      }
      return entry;
    }
    async function observeParent(filename: string) {
      let parent = path.dirname(filename);
      let entry = await preparationParent(parent);
      while (entry.kind === "missing") {
        const next = path.dirname(parent);
        if (next === parent) throw new Error("Missing filesystem root");
        parent = next;
        entry = await preparationParent(parent);
      }
      if (entry.kind !== "directory") throw new Error("Invalid config ancestry");
    }
    // Config and index states precede Git's interpretation. Sampling them only
    // afterwards could bind an old excludesFile path to a newly edited config.
    for (const filename of [...paths, path.join(root, ".git", "index")]) {
      await observe(filename);
      await observeParent(filename);
    }
    const [config, stage, excludes] = await Promise.all([
      git(root, ["config", "--null", "--list", "--show-origin"]),
      git(root, ["ls-files", "--stage", "-z"]),
      git(root, ["config", "--null", "--path", "--get-all", "core.excludesfile"], true),
    ]);
    for (const entry of stage.split("\0").filter(Boolean))
      if (!/^(100644|100755) [a-f0-9]+ [0-3]\t/.test(entry)) return;
    const origins = new Set<string>();
    const fields = config.split("\0");
    if (fields.pop() !== "" || fields.length % 2) return;
    for (let i = 0; i < fields.length; i += 2) {
      const origin = fields[i]!,
        setting = fields[i + 1]!;
      if (!origin.startsWith("file:")) return;
      if (!paths.has(path.resolve(root, origin.slice(5)))) return;
      addPath(origin.slice(5));
      origins.add(path.resolve(root, origin.slice(5)));
      const key = setting.split("\n", 1)[0]!.toLowerCase();
      if (
        /^(include|includeif|extensions)\./.test(key) ||
        /^(core\.(worktree|sparsecheckout|sparsecheckoutcone)|index\.sparse)$/.test(key) ||
        (key === "core.bare" && !/\n(false|no|off|0)$/.test(setting))
      )
        return;
    }
    for (const filename of [
      path.join(home, ".gitconfig"),
      path.join(xdg, "git", "config"),
      path.join(home, ".config", "git", "config"),
      path.join(home, ".config", "git", "ignore"),
      path.join(xdg, "git", "ignore"),
      ...(process.platform === "win32"
        ? [path.join(process.env.PROGRAMDATA!, "Git", "config")]
        : []),
      ...excludes.split("\0").filter(Boolean),
    ])
      addPath(filename);

    async function walk(folder: string, metadata = false) {
      if ((await observe(folder)).kind !== "directory")
        throw new Error("Repository directory disappeared");
      if (!metadata) {
        await observe(path.join(folder, ".gitignore"));
        if (folder !== root && (await observe(path.join(folder, ".git"))).kind !== "missing")
          throw new Error("Nested repository");
      }
      const children = await fs.readdir(folder, { withFileTypes: true });
      if (children.length + entries.size > entryLimit)
        throw new Error("Repository witness exceeds limit");
      for (const child of children) {
        const name = process.platform === "win32" ? child.name.toLowerCase() : child.name;
        if (!metadata && folder === root && [".git", ".tent"].includes(name)) continue;
        if (
          metadata &&
          folder === path.join(root, ".git") &&
          ["objects", "logs", "hooks"].includes(child.name)
        )
          // Current membership and source bytes do not depend on object storage,
          // reflogs or executable hooks. Read commands never execute those hooks.
          continue;
        if (
          metadata &&
          (child.name.endsWith(".lock") ||
            ["commondir", "gitdir", "modules", "worktrees", "reftable"].includes(child.name))
        )
          throw new Error("Unsupported Git metadata");
        const filename = path.join(folder, child.name);
        const observed = await observe(filename);
        if (observed.kind === "directory") await walk(filename, metadata);
        else if (observed.kind !== "file") throw new Error("Repository entry disappeared");
      }
    }
    await walk(root);
    await walk(path.join(root, ".git"), true);
    for (const name of [
      "index",
      "config",
      "config.worktree",
      "commondir",
      "gitdir",
      "info/exclude",
      "packed-refs",
    ])
      await observe(path.join(root, ".git", name));
    for (const filename of paths) {
      const entry = await observe(filename);
      if (entry.kind === "directory" || (origins.has(filename) && entry.kind !== "file")) return;
      await observeParent(filename);
    }
    const before = [...entries.values()];
    // Bind the loader's bytes and Git results to one stable filesystem interval.
    const value = await loader();
    for (const entry of [...before, ...preparationParents.values()])
      if (!equal(entry, await sample(entry.filename))) return;
    if (environment() !== observedEnvironment) return;
    return {
      schema: 2,
      workspaceRoot: root,
      writtenAtNs,
      environment: observedEnvironment,
      entries: before,
      value,
    };
  } catch {
    return;
  }
}

/** No Git process or content reads are allowed on the reuse path. */
export async function validateRepositoryObservation<T>(
  workspaceRoot: string,
  snapshot: PreparedRepositoryObservation<T>,
): Promise<T | undefined> {
  try {
    if (
      !snapshot ||
      snapshot.schema !== 2 ||
      snapshot.workspaceRoot !== path.resolve(workspaceRoot) ||
      typeof snapshot.writtenAtNs !== "string" ||
      !/^\d+$/.test(snapshot.writtenAtNs) ||
      snapshot.environment !== environment() ||
      !Array.isArray(snapshot.entries) ||
      !snapshot.entries.length ||
      snapshot.entries.length > entryLimit
    )
      return;
    for (let start = 0; start < snapshot.entries.length; start += 32) {
      const matches = await Promise.all(
        snapshot.entries.slice(start, start + 32).map(async (entry) => {
          if (!entry || typeof entry.filename !== "string" || !path.isAbsolute(entry.filename))
            return false;
          if (
            entry.kind !== "missing" &&
            ((entry.kind !== "file" && entry.kind !== "directory") || !isFileState(entry.state))
          )
            return false;
          const current = await sample(entry.filename);
          return (
            equal(entry, current) &&
            (entry.kind === "missing" ||
              (current.kind !== "missing" &&
                stateCacheHit(current.state, entry.state, snapshot.writtenAtNs)))
          );
        }),
      );
      if (matches.some((match) => !match)) return;
    }
    return snapshot.value;
  } catch {
    return;
  }
}
