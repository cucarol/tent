import fs, { type FSWatcher } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { directoryRepository } from "./repository-material.js";

const normalized = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file);
const directoryIdentity = (info: fs.BigIntStats) => `${info.dev}:${info.ino}:${info.birthtimeNs}`;
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const absent = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
  throw error;
};

async function git(
  root: string,
  args: string[],
  environment: Record<string, string> = {},
  input?: string,
) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
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
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
          ),
          ...environment,
        },
      },
      (error, stdout, stderr) =>
        error && !(error.code === 1 && args.includes("check-ignore"))
          ? reject(new Error(stderr.trim() || error.message))
          : resolve(stdout),
    );
    child.stdin?.end(input);
  });
}

function configFiles(raw: string, root: string) {
  const files = new Set<string>();
  const home = process.env.HOME || homedir();
  const expand = (value: string, origin: string) => {
    if (/^~[\\/]/.test(value)) return path.join(home, value.slice(2));
    if (value.startsWith("~")) throw new Error("Unsupported Git configuration home path");
    return path.resolve(path.dirname(origin), value);
  };
  const fields = raw.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Invalid Git configuration origin listing");
  for (let i = 0; i < fields.length; i += 2) {
    const origin = fields[i]!;
    if (!origin.startsWith("file:")) continue;
    const filename = path.resolve(root, origin.slice(5));
    files.add(filename);
    const item = fields[i + 1]!;
    const separator = item.indexOf("\n");
    const key = (separator < 0 ? item : item.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? "" : item.slice(separator + 1);
    if (
      (/^include(?:if\..+)?\.path$/.test(key) ||
        key === "core.excludesfile" ||
        key === "core.attributesfile") &&
      value
    )
      files.add(expand(value, key.startsWith("core.") ? path.join(root, "config") : filename));
  }
  files.add(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "ignore"));
  files.add(
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "attributes"),
  );
  return files;
}

function defaultConfigFiles(raw: string) {
  const files: string[] = [];
  let selected = false;
  for (const line of raw.split(/\r?\n/)) {
    const variable = /^([A-Z_]+)=(.*)$/.exec(line);
    if (variable) {
      selected = [
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_ATTR_SYSTEM",
        "GIT_ATTR_GLOBAL",
      ].includes(variable[1]!);
      if (selected && variable[2]) files.push(path.resolve(variable[2]));
    } else if (selected && line) files.push(path.resolve(line));
  }
  if (!files.length) throw new Error("Git cannot identify default configuration inputs");
  return files;
}

async function gitDirectories(root: string) {
  const marker = path.join(root, ".git");
  const info = await lstat(marker);
  let directory = marker;
  if (!info.isDirectory()) {
    const match = /^gitdir: ([^\r\n]+)\s*$/.exec(await readFile(marker, "utf8"));
    if (!match) throw new Error("Invalid Git checkout marker");
    directory = path.resolve(root, match[1]!);
  }
  directory = await realpath(directory);
  const common = await readFile(path.join(directory, "commondir"), "utf8").catch(absent);
  return [
    ...new Set([
      directory,
      common ? await realpath(path.resolve(directory, common.trim())) : directory,
    ]),
  ];
}

/** Notifications are an optimization only: any loss of coverage disables this watch. */
export async function createModuleDependencyWatch(
  workspaceRoot: string,
  onChange: () => void,
  onUnavailable: (error: Error) => void,
): Promise<{ close(): void }> {
  const root = await realpath(workspaceRoot);
  let closed = false;
  let ready = false;
  let rebuilding = false;
  let rebuildAgain = false;
  let dependencyFiles = new Set<string>();
  let gitRoots: string[] = [];
  let ignoredDirectories: string[] = [];
  const handles = new Map<string, FSWatcher>();
  const watchedFolders = new Map<string, { folder: string; identity: string }>();
  const memberFolders = new Set<string>();
  const close = () => {
    closed = true;
    for (const handle of handles.values()) handle.close();
    handles.clear();
    watchedFolders.clear();
    memberFolders.clear();
  };
  const unavailable = (error: unknown) => {
    if (closed) return;
    close();
    onUnavailable(error instanceof Error ? error : new Error(String(error)));
  };
  const change = (rebuild: boolean) => {
    if (closed) return;
    onChange();
    if (rebuild) {
      rebuildAgain = true;
      if (ready && !rebuilding) void refresh().catch(unavailable);
    }
  };
  const event = (folder: string, kind: string, filename: string | Buffer | null) => {
    if (closed) return;
    if (filename === null)
      return unavailable(new Error(`Module dependency watch lost event path: ${folder}`));
    const file = path.resolve(folder, filename.toString());
    const key = normalized(file);
    const controls = [...watchedFolders.values()].filter(
      ({ folder }) => key === normalized(folder) || (kind === "rename" && inside(file, folder)),
    );
    if (controls.length) {
      void Promise.all(
        controls.map(async ({ folder, identity }) => {
          const info = await lstat(folder, { bigint: true }).catch(absent);
          if (!info || directoryIdentity(info) !== identity) {
            if (memberFolders.has(normalized(folder))) {
              for (const [key, record] of watchedFolders)
                if (normalized(record.folder) === normalized(folder)) {
                  const handle = handles.get(key);
                  handles.delete(key);
                  watchedFolders.delete(key);
                  handle?.close();
                }
              memberFolders.delete(normalized(folder));
              change(true);
            } else
              unavailable(new Error(`Module dependency watch directory was replaced: ${folder}`));
          }
        }),
      ).catch(unavailable);
      return;
    }
    // Directory last-write notifications for Git lock/object activity do not
    // change the checkout marker; actual marker replacement is a rename event.
    if (kind === "change" && gitRoots.some((directory) => key === normalized(directory))) return;
    if (
      key === normalized(root) ||
      [...dependencyFiles].some((input) => key === input || inside(file, input))
    ) {
      change(true);
      return;
    }
    const enclosing = gitRoots.filter((directory) => inside(directory, file));
    if (enclosing.length) {
      const relevant = enclosing.some((directory) => {
        const relative = path.relative(directory, file).split(path.sep).join("/");
        return (
          /^(?:HEAD|index|config|config\.worktree|commondir|gitdir|packed-refs|info\/(?:exclude|attributes)|refs(?:\/.*)?)$/.test(
            relative,
          ) && !relative.endsWith(".lock")
        );
      });
      if (relevant) change(true);
      return;
    }
    if (!inside(root, file)) return;
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (
      relative.startsWith(".tent/.git/") &&
      !/(?:^|\/)(?:HEAD|config|config\.worktree|commondir|info\/exclude)$/.test(relative)
    )
      return;
    if (
      relative !== ".tent" &&
      !relative.startsWith(".tent/") &&
      ignoredDirectories.some((ignored) => key === ignored || inside(ignored, file))
    )
      return;
    if (/^\.tent\/[^/]+$/.test(path.relative(root, folder).split(path.sep).join("/"))) {
      change(false);
      return;
    }
    change(
      kind === "rename" ||
        path.basename(file) === ".gitignore" ||
        path.basename(file) === ".git" ||
        relative === ".tent/.git" ||
        relative === ".tent" ||
        [".scratch", ".worktrees", "node_modules"].includes(relative),
    );
  };
  const add = (folder: string, recursive: boolean, member = false) => {
    if (closed) throw new Error("Module dependency watch is closed");
    const key = `${normalized(folder)}:${recursive}`;
    if (handles.has(key)) return key;
    if (handles.size >= 1024) throw new Error("Module dependency watch input limit exceeded");
    const identity = directoryIdentity(fs.lstatSync(folder, { bigint: true }));
    const handle = fs.watch(folder, { recursive, persistent: false }, (kind, filename) => {
      if (handles.get(key) === handle) event(folder, kind, filename);
    });
    handle.on("error", unavailable);
    handle.on("close", () => {
      if (!closed && handles.get(key) === handle) {
        if (member)
          void lstat(folder)
            .catch(absent)
            .then((info) => {
              if (closed || handles.get(key) !== handle) return;
              if (info)
                unavailable(new Error(`Module dependency watch closed unexpectedly: ${folder}`));
              else {
                handles.delete(key);
                watchedFolders.delete(key);
                memberFolders.delete(normalized(folder));
                change(true);
              }
            })
            .catch(unavailable);
        else unavailable(new Error(`Module dependency watch closed unexpectedly: ${folder}`));
      }
    });
    handles.set(key, handle);
    watchedFolders.set(key, { folder, identity });
    if (member) memberFolders.add(normalized(folder));
    return key;
  };
  const rootHandle = add(root, false);

  async function refresh() {
    rebuilding = true;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        rebuildAgain = false;
        const owner = await directoryRepository(root);
        const tentGit = path.join(root, ".tent", ".git");
        const tentExists = await lstat(path.join(tentGit, "HEAD")).catch(absent);
        const roots = owner ? await gitDirectories(owner.root) : [];
        if (tentExists) roots.push(tentGit);
        gitRoots = roots;
        for (const directory of roots) {
          add(directory, false);
          for (const [child, recursive] of [
            ["info", false],
            ["refs", true],
          ] as const) {
            const folder = path.join(directory, child);
            if ((await lstat(folder).catch(absent))?.isDirectory()) add(folder, recursive);
          }
        }
        const dependencies = new Set<string>();
        const top = owner?.root;
        for (let directory = root; ;) {
          dependencies.add(path.join(directory, ".git"));
          dependencies.add(path.join(directory, ".gitignore"));
          dependencies.add(path.join(directory, ".gitattributes"));
          if (directory === top || path.dirname(directory) === directory) break;
          directory = path.dirname(directory);
        }
        for (const directory of roots)
          for (const file of [
            "HEAD",
            "index",
            "config",
            "config.worktree",
            "commondir",
            "gitdir",
            "packed-refs",
            "info/exclude",
            "info/attributes",
          ])
            dependencies.add(path.join(directory, file));
        const configArgs = ["config", "--null", "--show-origin", "--list"];
        const [configuration, defaults] = owner
          ? await Promise.all([git(owner.root, configArgs), git(owner.root, ["var", "-l"])])
          : ["", ""];
        if (owner) {
          for (const file of configFiles(configuration, owner.root)) dependencies.add(file);
          for (const file of defaultConfigFiles(defaults)) dependencies.add(file);
        }
        // Also watch resolved targets when configuration itself is a symlink.
        for (const file of [...dependencies]) {
          const actual = await realpath(file).catch(absent);
          if (actual) dependencies.add(actual);
        }
        if (closed) return;
        dependencyFiles = new Set([...dependencies].map(normalized));
        gitRoots = roots;
        const needed = new Set([rootHandle]);
        const requireWatch = (folder: string, recursive: boolean) => {
          needed.add(add(folder, recursive));
          for (
            let parent = path.dirname(folder);
            parent !== folder;
            parent = path.dirname(folder)
          ) {
            needed.add(add(parent, false));
            folder = parent;
          }
        };
        requireWatch(root, false);
        for (const directory of roots) {
          requireWatch(directory, false);
          for (const [child, recursive] of [
            ["info", false],
            ["refs", true],
          ] as const) {
            const folder = path.join(directory, child);
            if ((await lstat(folder).catch(absent))?.isDirectory()) requireWatch(folder, recursive);
          }
        }
        for (const file of dependencies) {
          // Workspace membership does not establish watch coverage: ignored trees
          // and Git storage subdirectories are deliberately omitted below. Every
          // effective control input needs its own live parent (or setup fails).
          let directory = path.dirname(file);
          while (!(await lstat(directory).catch(absent))?.isDirectory()) {
            const parent = path.dirname(directory);
            if (parent === directory)
              throw new Error("Module dependency watch input has no live parent");
            directory = parent;
          }
          // Missing intermediate directories are covered by their live parent;
          // creation events rebuild coverage before the next cached result.
          requireWatch(directory, false);
        }
        const ignoreArgs = [
          "ls-files",
          "--cached",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "-z",
        ];
        const probes =
          [".scratch/", ".worktrees/", "node_modules/"]
            .map(
              (name) =>
                path
                  .relative(owner?.root || root, path.join(root, name))
                  .split(path.sep)
                  .join("/") + "/",
            )
            .join("\0") + "\0";
        const [verified, ignored, ignoredProbes] = owner
          ? await Promise.all([
              git(owner.root, configArgs),
              git(owner.root, ignoreArgs),
              git(owner.root, ["check-ignore", "--no-index", "-z", "--stdin"], {}, probes),
            ])
          : tentExists
            ? [
                "",
                await git(
                  root,
                  [
                    "--git-dir",
                    tentGit,
                    "--work-tree",
                    root,
                    "ls-files",
                    "--others",
                    "--ignored",
                    "--exclude-per-directory=.gitignore",
                    "--directory",
                    "-z",
                  ],
                  {
                    GIT_INDEX_FILE: path.join(tentGit, `tent-watch-read-${process.pid}.index`),
                    GIT_OPTIONAL_LOCKS: "0",
                  },
                ),
                "",
              ]
            : ["", "", ""];
        if (closed) return;
        if (configuration !== verified || rebuildAgain) continue;
        const names = ignored.split("\0").filter(Boolean);
        const tracked = names
          .filter((name) => !name.endsWith("/"))
          .map((name) => path.resolve(owner?.root || root, name));
        ignoredDirectories = names
          .filter((name) => name.endsWith("/"))
          .map((name) => path.resolve(owner?.root || root, name))
          .filter((directory) => !tracked.some((file) => inside(directory, file)))
          .map(normalized);
        for (const name of ignoredProbes.split("\0").filter(Boolean)) {
          const directory = path.resolve(owner?.root || root, name);
          if (!tracked.some((file) => inside(directory, file)))
            ignoredDirectories.push(normalized(directory));
        }
        // Never recursively watch the Workspace's ignored operation trees or
        // Git object stores. Small Tent declaration subtrees may use native
        // recursion after the control repository has been separated out.
        const folders: Array<{ folder: string; nodeSubtree: boolean }> = [];
        const blocked = [...ignoredDirectories, ...roots];
        let pending = [root];
        while (pending.length) {
          const batch = pending.splice(0, 32);
          const children = await Promise.all(
            batch.map(async (folder) => {
              const relative = path.relative(root, folder).split(path.sep).join("/");
              const nodeSubtree = /^\.tent\/[^/]+$/.test(relative);
              if (
                folder !== root &&
                !relative.startsWith(".tent") &&
                (await lstat(path.join(folder, ".git")).catch(absent))
              ) {
                blocked.push(folder);
                return [];
              }
              folders.push({ folder, nodeSubtree });
              if (nodeSubtree) return [];
              const entries = await readdir(folder, { withFileTypes: true });
              for (const entry of entries)
                if (entry.isSymbolicLink()) blocked.push(path.join(folder, entry.name));
              return entries
                .filter(
                  (entry) =>
                    entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".git",
                )
                .map((entry) => path.join(folder, entry.name))
                .filter((child) => {
                  const candidate = path.relative(root, child).split(path.sep).join("/");
                  return (
                    candidate === ".tent" ||
                    candidate.startsWith(".tent/") ||
                    !ignoredDirectories.some(
                      (ignored) => normalized(child) === ignored || inside(ignored, child),
                    )
                  );
                });
            }),
          );
          pending.push(...children.flat());
        }
        const recursiveTrees: string[] = [];
        const plan: Array<{ folder: string; recursive: boolean }> = [];
        for (const { folder, nodeSubtree } of folders) {
          if (recursiveTrees.some((tree) => inside(tree, folder))) continue;
          const recursive =
            nodeSubtree ||
            (folder !== root &&
              folder !== path.join(root, ".tent") &&
              !blocked.some((excluded) => inside(folder, excluded)));
          plan.push({ folder, recursive });
          if (recursive) recursiveTrees.push(folder);
        }
        if (process.platform === "win32") {
          const obstructed = plan.find(
            ({ folder }) =>
              folder !== root &&
              !inside(path.join(root, ".tent"), folder) &&
              !roots.some((control) => inside(control, folder)) &&
              plan.some((child) => child.folder !== folder && inside(folder, child.folder)),
          );
          if (obstructed)
            throw new Error(
              `Windows source directory requires nested watch roots that obstruct rename: ${obstructed.folder}`,
            );
        }
        for (const { folder, recursive } of plan)
          needed.add(add(folder, recursive, folder !== root));
        if (closed) return;
        if (rebuildAgain) continue;
        for (const [key, handle] of handles) {
          if (!needed.has(key)) {
            const removedFolder = watchedFolders.get(key)?.folder;
            handles.delete(key);
            watchedFolders.delete(key);
            if (
              removedFolder &&
              ![...watchedFolders.values()].some(
                (record) => normalized(record.folder) === normalized(removedFolder),
              )
            )
              memberFolders.delete(normalized(removedFolder));
            handle.close();
          }
        }
        if (ready) onChange();
        return;
      }
      throw new Error("Module dependency watch inputs changed during setup");
    } finally {
      rebuilding = false;
    }
  }
  try {
    await refresh();
    if (closed) throw new Error("Module dependency watch became unavailable during setup");
    ready = true;
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
