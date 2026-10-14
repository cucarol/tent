import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { checkedSourceFile } from "./checked-source-file.js";
import { observeSourceFile } from "./source-observation.js";
import { directoryRepository } from "./repository-material.js";
import { directoryFingerprint, type DirectoryFile } from "../core/directory-material.js";

export class DirectoryObservationCache {
  blobs = new Map<string, string>();
  working = new Map<string, { signature: string; version: string; oid?: string }>();
  loaded = new Set<string>();
  loading = new Map<string, Promise<void>>();
  listings = new Map<string, Promise<DirectoryListing>>();
}

async function loadCache(
  filename: string,
  cache: DirectoryObservationCache,
  load: (saved: unknown) => void,
) {
  if (cache.loaded.has(filename)) return;
  let pending = cache.loading.get(filename);
  if (!pending) {
    pending = readFile(filename, "utf8")
      .then(JSON.parse)
      .catch(() => undefined)
      .then((saved) => {
        load(saved);
        cache.loaded.add(filename);
      })
      .finally(() => cache.loading.delete(filename));
    cache.loading.set(filename, pending);
  }
  await pending;
}

function fileSignature(info: Awaited<ReturnType<typeof lstat>>) {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
}

function normalizedBytes(bytes: Buffer): string | Buffer {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\0") ? bytes : text.replace(/\r\n?/g, "\n");
  } catch {
    return bytes;
  }
}
function digest(bytes: Buffer) {
  return createHash("sha256").update(normalizedBytes(bytes)).digest("hex");
}

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

type IndexStat = { ctime: bigint; mtime: bigint; size: bigint; dev: bigint; ino: bigint };
function indexEntries(bytes: Buffer) {
  const output = bytes.toString("utf8");
  const entries = new Map<
    string,
    { oid: string; mode: string; unsafe: boolean; stat: IndexStat }
  >();
  const live = new Set<string>();
  for (let offset = 0; offset < output.length;) {
    const end = output.indexOf("\0", offset);
    if (end === -1) throw new Error("Invalid Git material index listing");
    const item = output.slice(offset, end);
    offset = end + 1;
    if (item.startsWith("? ")) {
      live.add(item.slice(2));
      continue;
    }
    const entry = /^(.?) (\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(item);
    const stat =
      /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: \d+\tgid: \d+\n  size: (\d+)\tflags: [a-f0-9]+\n/.exec(
        output.slice(offset),
      );
    if (!entry || !stat) throw new Error("Invalid Git material index stat listing");
    offset += stat[0].length;
    entries.set(entry[5]!, {
      mode: entry[2]!,
      oid: entry[3]!,
      unsafe: entry[1] !== "H" || entry[4] !== "0",
      stat: {
        ctime: BigInt(stat[1]!) * 1_000_000_000n + BigInt(stat[2]!),
        mtime: BigInt(stat[3]!) * 1_000_000_000n + BigInt(stat[4]!),
        dev: BigInt(stat[5]!),
        ino: BigInt(stat[6]!),
        size: BigInt(stat[7]!),
      },
    });
  }
  return { entries, live };
}

type DirectoryListing = ReturnType<typeof indexEntries> & { ignored: Set<string> };

async function listRepositoryDirectory(root: string, relative: string): Promise<DirectoryListing> {
  const scope = `:(literal)${relative || "."}`;
  const [staged, excluded] = await Promise.all([
    git(root, [
      "ls-files",
      "-v",
      "--stage",
      "--cached",
      "--others",
      "--exclude-standard",
      "--debug",
      "-z",
      "--",
      scope,
    ]),
    git(root, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z", "--", scope]),
  ]);
  return { ...indexEntries(staged), ignored: new Set(names(excluded)) };
}

async function directoryListing(root: string, relative: string, cache: DirectoryObservationCache) {
  let pending = cache.listings.get(root);
  if (!pending) {
    // Share only overlapping reads. A later observation must ask Git again for
    // new files, index changes and ignore rules, even when mtimes are unchanged.
    pending = listRepositoryDirectory(root, "").finally(() => cache.listings.delete(root));
    cache.listings.set(root, pending);
  }
  let listing: DirectoryListing;
  try {
    listing = await pending;
  } catch (error) {
    // Unrelated traversal warnings or a large whole-repository listing must not
    // make an otherwise readable scoped material unavailable.
    if (!relative) throw error;
    return listRepositoryDirectory(root, relative);
  }
  if (!relative)
    return {
      entries: new Map(listing.entries),
      live: new Set(listing.live),
      ignored: new Set(listing.ignored),
    };
  // A pathspec inside a Gitlink can expose live children that a root listing
  // omits. Keep Git itself authoritative for that special traversal.
  if (
    [...listing.entries].some(
      ([name, entry]) => entry.mode === "160000" && relative.startsWith(name + "/"),
    )
  )
    return listRepositoryDirectory(root, relative);
  const within = (name: string) => name === relative || name.startsWith(relative + "/");
  return {
    entries: new Map([...listing.entries].filter(([name]) => within(name))),
    live: new Set([...listing.live].filter(within)),
    ignored: new Set([...listing.ignored].filter(within)),
  };
}

async function matchesIndexStat(filename: string, stat: IndexStat) {
  const info = await lstat(filename, { bigint: true });
  return (
    info.isFile() &&
    info.size === stat.size &&
    (process.platform === "win32"
      ? info.birthtimeNs === stat.ctime && info.ctimeNs === info.mtimeNs
      : info.ctimeNs === stat.ctime) &&
    info.mtimeNs === stat.mtime &&
    // Git for Windows retains creation time and zero dev/ino. Require the live
    // change time to match mtime too, so restoring mtime cannot authorize a blob.
    // Unix index device/inode fields retain 32 bits.
    (process.platform === "win32" ||
      (BigInt.asUintN(32, info.dev) === stat.dev && BigInt.asUintN(32, info.ino) === stat.ino))
  );
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
      .filter((name) => !name.split("/").includes(".git"))
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
  const listed = await git(repo.root, [
    "ls-files",
    "--cached",
    ...(trackedOnly ? ["--stage"] : []),
    ...(trackedOnly ? [] : ["--others", "--exclude-standard"]),
    "-z",
    "--",
    scope,
  ]);
  const ignored = trackedOnly
    ? new Set<string>()
    : new Set(
        names(
          await git(repo.root, [
            "ls-files",
            "--cached",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
            scope,
          ]),
        ),
      );
  const files = new Set<string>();
  const candidates = trackedOnly
    ? names(listed).flatMap((entry) => {
        const match = /^(\d+) [a-f0-9]+ \d\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error("Invalid Git tracked material listing");
        // Gitlinks identify repositories rather than tracked files in this checkout.
        return match[1] === "160000" ? [] : [match[2]!];
      })
    : names(listed);
  for (const name of candidates) {
    if (ignored.has(name) || name.split("/").includes(".git")) continue;
    const filename = path.join(repo.root, name);
    const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
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
          ["ls-files", "--others", "--exclude-standard", "-z", "--", scope],
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
  await checkedSourceFile(root, directory, true);
  return [...files].sort();
}

export async function observeSourceDirectory(
  root: string,
  directory: string,
  cacheDir?: string,
  cache = new DirectoryObservationCache(),
) {
  await checkedSourceFile(root, directory, true);
  const canonicalPath = await realpath(directory);
  const repo = await directoryRepository(directory);
  const files: DirectoryFile[] = [];
  let cacheHit = true;
  let workingChanged = false;
  const workingCache = cacheDir ? path.join(cacheDir, "directory-working.json") : undefined;
  if (workingCache)
    await loadCache(workingCache, cache, (saved) => {
      if (saved && typeof saved === "object")
        for (const [filename, entry] of Object.entries(saved)) {
          const value = entry as { signature?: unknown; version?: unknown; oid?: unknown } | null;
          if (
            value &&
            typeof value.signature === "string" &&
            typeof value.version === "string" &&
            /^[a-f0-9]{64}$/.test(value.version)
          )
            cache.working.set(filename, {
              signature: value.signature,
              version: value.version,
              ...(typeof value.oid === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.oid)
                ? { oid: value.oid }
                : {}),
            });
        }
    });
  const checkedDirectories = new Map<string, ReturnType<typeof checkedSourceFile>>();
  const physicalDirectories = new Map<
    string,
    { path: string; names: Set<string>; folded: Map<string, string> }
  >();
  const physicalPaths = new Map<string, string>();
  const memberPath = (filename: string) =>
    path
      .relative(directory, physicalPaths.get(filename) ?? filename)
      .split(path.sep)
      .join("/");
  const cachedWorking = async (filename: string, oid?: string) => {
    // A deleted indexed subtree has no live parent to validate.
    const before = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (before?.isSymbolicLink())
      throw new Error("Symbolic links are not supported for source files");
    if (!before?.isFile()) return;
    const parent = path.dirname(filename);
    if (!checkedDirectories.has(parent))
      checkedDirectories.set(
        parent,
        checkedSourceFile(root, parent, true).then(async (info) => {
          const names = await readdir(parent);
          physicalDirectories.set(parent, {
            path: await realpath(parent),
            names: new Set(names),
            folded: new Map(names.map((name) => [name.toLowerCase(), name])),
          });
          return info;
        }),
      );
    await checkedDirectories.get(parent);
    const physical = physicalDirectories.get(parent),
      basename = path.basename(filename);
    if (physical)
      physicalPaths.set(
        filename,
        path.join(
          physical.path,
          physical.names.has(basename)
            ? basename
            : (physical.folded.get(basename.toLowerCase()) ?? basename),
        ),
      );
    const signature = fileSignature(before),
      cached = cache.working.get(filename);
    return {
      signature,
      version:
        cached?.signature === signature && (!cached.oid || cached.oid === oid)
          ? cached.version
          : undefined,
    };
  };
  const working = async (filename: string) => {
    const cached = await cachedWorking(filename);
    if (!cached) throw new Error("Directory member is not a readable source file");
    const { signature, version } = cached;
    if (version) {
      files.push({
        path: memberPath(filename),
        version,
      });
      return;
    }
    const observed = await observeSourceFile(root, filename, cacheDir, {
      key: "directory-text-v1",
      content: normalizedBytes,
    });
    const after = await lstat(filename);
    if (fileSignature(after) !== signature)
      throw new Error("Material changed while observing directory");
    cache.working.set(filename, { signature, version: observed.observedVersion });
    workingChanged = true;
    cacheHit &&= observed.cacheHit;
    files.push({
      path: memberPath(filename),
      version: observed.observedVersion,
    });
  };
  if (!repo) {
    const filenames = await plainFiles(root, directory, cacheDir);
    // Bound open handles and Windows filesystem contention.
    for (let index = 0; index < filenames.length; index += 32)
      await Promise.all(
        filenames.slice(index, index + 32).map(async (entry) => {
          if (!entry.directory) return working(entry.filename);
          const nested = await observeSourceDirectory(root, entry.filename, cacheDir, cache);
          cacheHit &&= nested.cacheHit;
          files.push(
            ...nested.directoryFiles.map((file) => ({
              ...file,
              path: path.posix.join(
                path.relative(directory, nested.canonicalPath).split(path.sep).join("/"),
                file.path,
              ),
            })),
          );
        }),
      );
  } else {
    const relative = path.relative(repo.root, directory).split(path.sep).join("/");
    const scope = `:(literal)${relative || "."}`;
    const {
      entries,
      live,
      ignored: ignoredFiles,
    } = await directoryListing(repo.root, relative, cache);
    if (entries.get(relative)?.mode === "160000") {
      // A gitlink whose nested Git metadata is absent still has ordinary live
      // files. List them with the owning repository's ignore rules and no index.
      const members = await git(
        repo.root,
        ["ls-files", "--others", "--exclude-standard", "-z", "--", scope],
        undefined,
        {
          GIT_INDEX_FILE: path.join(
            repo.root,
            `.tent-directory-read-${process.pid}-${Math.random().toString(36).slice(2)}.index`,
          ),
          GIT_OPTIONAL_LOCKS: "0",
        },
      );
      entries.delete(relative);
      for (const name of names(members)) live.add(name);
    }
    const blobCache = cacheDir ? path.join(cacheDir, "directory-blobs.json") : undefined;
    if (blobCache)
      await loadCache(blobCache, cache, (saved) => {
        if (saved && typeof saved === "object")
          for (const [oid, version] of Object.entries(saved))
            if (
              /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) &&
              typeof version === "string" &&
              /^[a-f0-9]{64}$/.test(version)
            )
              cache.blobs.set(oid, version);
      });
    const clean: Array<{ name: string; oid: string }> = [];
    for (const [name, entry] of entries) {
      if (ignoredFiles.has(name) || name.split("/").includes(".git")) continue;
      if (entry.mode === "120000" || entry.mode === "160000" || entry.unsafe) live.add(name);
      else clean.push({ name, oid: entry.oid });
    }
    const signatures = new Map<string, string>();
    const reusable = new Set<string>();
    for (let index = 0; index < clean.length; index += 32)
      await Promise.all(
        clean.slice(index, index + 32).map(async (entry) => {
          const filename = path.join(repo.root, entry.name);
          const cached = await cachedWorking(filename, entry.oid);
          if (!cached) {
            live.add(entry.name);
            return;
          }
          signatures.set(entry.name, cached.signature);
          if (cached.version) {
            files.push({
              path: memberPath(filename),
              version: cached.version,
            });
            reusable.add(entry.name);
          } else if (!(await matchesIndexStat(filename, entries.get(entry.name)!.stat)))
            live.add(entry.name);
        }),
      );
    for (let index = clean.length - 1; index >= 0; index--)
      if (reusable.has(clean[index]!.name) || live.has(clean[index]!.name)) clean.splice(index, 1);
    // Clean filters, ident expansion and working-tree encoding can make index
    // blobs differ from live bytes even when the index stat matches.
    // Only reuse object content where normalization really is equivalent.
    if (clean.length) {
      const attributes = names(
        await git(
          repo.root,
          ["check-attr", "--stdin", "-z", "filter", "ident", "working-tree-encoding"],
          clean.map((entry) => entry.name).join("\0") + "\0",
        ),
      );
      for (let index = 0; index < attributes.length; index += 3)
        if (!["unspecified", "unset"].includes(attributes[index + 2]!))
          live.add(attributes[index]!);
      for (let index = clean.length - 1; index >= 0; index--)
        if (live.has(clean[index]!.name)) clean.splice(index, 1);
    }
    const missing = [...new Set(clean.map((entry) => entry.oid))].filter(
      (oid) => !cache.blobs.has(oid),
    );
    for (const parent of new Set(
      clean.map((entry) => path.dirname(path.join(repo.root, entry.name))),
    ))
      await checkedSourceFile(root, parent, true);
    if (missing.length) {
      cacheHit = false;
      const output = await git(repo.root, ["cat-file", "--batch"], missing.join("\n") + "\n");
      let offset = 0;
      for (const oid of missing) {
        const end = output.indexOf(10, offset),
          header = output.subarray(offset, end).toString("utf8");
        if (header === `${oid} missing`) {
          offset = end + 1;
          continue;
        }
        const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
        if (!match || match[1] !== oid) throw new Error("Git material blob is unavailable");
        const size = Number(match[2]);
        offset = end + 1;
        if (offset + size >= output.length) throw new Error("Git material blob is truncated");
        cache.blobs.set(oid, digest(output.subarray(offset, offset + size)));
        offset += size + 1;
      }
      if (blobCache) {
        const temp = `${blobCache}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await mkdir(cacheDir!, { recursive: true });
          await writeFile(temp, JSON.stringify(Object.fromEntries(cache.blobs)));
          await rename(temp, blobCache);
        } catch {
          await rm(temp, { force: true }).catch(() => undefined);
        }
      }
    }
    for (const entry of clean) {
      if (!cache.blobs.has(entry.oid)) {
        live.add(entry.name);
        continue;
      }
      const filename = path.join(repo.root, entry.name),
        signature = signatures.get(entry.name)!;
      if (fileSignature(await lstat(filename)) !== signature)
        throw new Error("Material changed while observing directory");
      cache.working.set(filename, {
        signature,
        version: cache.blobs.get(entry.oid)!,
        oid: entry.oid,
      });
      workingChanged = true;
      files.push({
        path: memberPath(filename),
        version: cache.blobs.get(entry.oid)!,
      });
    }
    const namesToRead = [...live].filter(
      (name) => !ignoredFiles.has(name) && !name.split("/").includes(".git"),
    );
    for (let index = 0; index < namesToRead.length; index += 32)
      await Promise.all(
        namesToRead.slice(index, index + 32).map(async (name) => {
          const filename = path.join(repo.root, name);
          const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (!info) return;
          if (info.isDirectory()) {
            // A tracked file replaced by this directory still appears at the
            // scope root in Git's index. Its current children are separate names.
            if (path.relative(directory, filename) === "") return;
            const nested = await observeSourceDirectory(root, filename, cacheDir, cache);
            cacheHit &&= nested.cacheHit;
            files.push(
              ...nested.directoryFiles.map((file) => ({
                ...file,
                path: path.posix.join(
                  path.relative(directory, nested.canonicalPath).split(path.sep).join("/"),
                  file.path,
                ),
              })),
            );
          } else await working(filename);
        }),
      );
  }
  const unique = new Map<string, DirectoryFile>();
  for (const file of files) {
    if (unique.has(file.path) && unique.get(file.path)!.version !== file.version)
      throw new Error("Material changed while observing directory");
    unique.set(file.path, file);
  }
  files.length = 0;
  for (const file of unique.values()) files.push(file);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  await checkedSourceFile(root, directory, true);
  await Promise.all(
    [...checkedDirectories.keys()].map((folder) => checkedSourceFile(root, folder, true)),
  );
  if (workingCache && workingChanged) {
    const temp = `${workingCache}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(cacheDir!, { recursive: true });
      await writeFile(temp, JSON.stringify(Object.fromEntries(cache.working)));
      await rename(temp, workingCache);
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
  const bytes = Buffer.from(JSON.stringify(files));
  const blobs = {
    sha1: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    sha256: createHash("sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  };
  return {
    canonicalPath,
    observedVersion: directoryFingerprint(files),
    directoryFiles: files,
    cacheHit,
    blobs,
  };
}
