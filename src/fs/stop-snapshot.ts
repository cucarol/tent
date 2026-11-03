import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { durableReplace } from "./durable-file.js";
import { repositoryCommand as git } from "./repository-command.js";

type GitSnapshot = {
  head: string | null;
  dirty: Record<string, string | null>;
  nodeProblems?: Record<string, string>;
  /** The Tent history commit this checkout's last Stop saw. */
  history?: string;
  /** Reference problems of listed Nodes already reported, one key each. */
  referenceProblems?: string[];
};
export type StopSettlement = {
  nodeProblems?: Record<string, string>;
  history?: string | null;
  referenceProblems?: readonly string[];
};
const normalized = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
const eligible = (file: string) =>
  !!file &&
  !path.isAbsolute(file) &&
  !file
    .split("/")
    .some((part) => !part || part === ".." || [".git", ".tent"].includes(normalized(part)));
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

async function stat(filename: string) {
  return fs.lstat(filename).catch((error) => {
    if (!missing(error)) throw error;
    return undefined;
  });
}

async function load(filename: string): Promise<GitSnapshot | undefined> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as GitSnapshot;
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

/** Git's stdin-paths protocol accepts C-quoted paths, including embedded newlines. */
function quotedPath(file: string) {
  return (
    '"' +
    file.replace(/[\\"\u0000-\u001f\u007f]/g, (character) =>
      character === "\\" || character === '"'
        ? "\\" + character
        : "\\" + character.charCodeAt(0).toString(8).padStart(3, "0"),
    ) +
    '"'
  );
}

/** Git applies the checkout's normal clean/process filters to each regular candidate. */
async function hashWorkingBatch(root: string, files: string[]) {
  return new Promise<string[]>((resolve, reject) => {
    const child = execFile(
      "git",
      ["--no-optional-locks", "--no-lazy-fetch", "-C", root, "hash-object", "--stdin-paths"],
      {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: Infinity,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
        ),
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(stderr.trim() || error.message))
          : resolve(stdout.trim().split("\n")),
    );
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin?.end(files.map(quotedPath).join("\n") + "\n");
  });
}

async function workingDigests(root: string, files: Set<string>, head: string | null) {
  const directories = new Map<string, Promise<boolean>>();
  const local = (directory: string): Promise<boolean> => {
    if (directory === ".") return Promise.resolve(true);
    let pending = directories.get(directory);
    if (!pending) {
      pending = (async () => {
        if (!(await local(path.posix.dirname(directory)))) return false;
        const state = await stat(path.join(root, directory));
        return (
          !!state?.isDirectory() &&
          !state.isSymbolicLink() &&
          !(await stat(path.join(root, directory, ".git")))
        );
      })();
      directories.set(directory, pending);
    }
    return pending;
  };
  const digests = new Map<string, string | null>();
  const regular = new Set<string>();
  const links = new Map<string, Buffer>();
  const candidates = [...files];
  const parentCounts = new Map<string, number>();
  for (const file of candidates) {
    const parent = path.posix.dirname(file);
    parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
  }
  const directoryEntries = new Map<string, Promise<Map<string, Dirent> | undefined>>();
  const candidateState = async (file: string) => {
    const parent = path.posix.dirname(file);
    if (parentCounts.get(parent)! > 1) {
      let observation = directoryEntries.get(parent);
      if (!observation) {
        // Optional type batching: listing errors retain the original per-path observation.
        observation = fs.readdir(path.join(root, parent), { withFileTypes: true }).then(
          (entries) => new Map(entries.map((entry) => [entry.name, entry])),
          () => undefined,
        );
        directoryEntries.set(parent, observation);
      }
      const entry = (await observation)?.get(path.posix.basename(file));
      if (entry && (entry.isFile() || entry.isSymbolicLink() || entry.isDirectory())) return entry;
    }
    return stat(path.join(root, file));
  };
  const failures: Array<{ error: unknown } | undefined> = new Array(candidates.length);
  const batchSize = Math.max(
    1,
    Math.ceil(candidates.length / Math.min(8, Math.max(1, Math.ceil(candidates.length / 64)))),
  );
  const batches = Array.from({ length: Math.ceil(candidates.length / batchSize) }, (_, index) => ({
    start: index * batchSize,
    files: candidates.slice(index * batchSize, (index + 1) * batchSize),
    remaining: Math.min(batchSize, candidates.length - index * batchSize),
  }));
  const hashing: Array<Promise<void>> = [];
  const hashFailures: Array<{ error: unknown } | undefined> = new Array(batches.length);
  const hashBatch = async (batch: (typeof batches)[number], index: number) => {
    try {
      if (batch.files.some((_, offset) => failures[batch.start + offset])) return;
      const regularFiles = batch.files.filter((file) => regular.has(file));
      if (!regularFiles.length) return;
      const values = await hashWorkingBatch(root, regularFiles);
      if (values.length !== regularFiles.length)
        throw new Error("Git did not hash every Stop candidate");
      regularFiles.forEach((file, offset) => digests.set(file, values[offset]!));
    } catch (error) {
      hashFailures[index] = { error };
    }
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, candidates.length) }, async () => {
      for (;;) {
        const index = next++;
        const file = candidates[index];
        if (file === undefined) return;
        digests.set(file, null);
        try {
          if (!(await local(path.posix.dirname(file)))) continue;
          const filename = path.join(root, file);
          const state = await candidateState(file);
          if (state?.isSymbolicLink())
            links.set(file, await fs.readlink(filename, { encoding: "buffer" }));
          else if (state?.isFile()) regular.add(file);
        } catch (error) {
          failures[index] = { error };
        } finally {
          const batchIndex = Math.floor(index / batchSize);
          const batch = batches[batchIndex]!;
          if (--batch.remaining === 0) hashing.push(hashBatch(batch, batchIndex));
        }
      }
    }),
  );
  // Each batch starts reading only after all its path checks, while later checks continue.
  // Drain every started read before preserving validation and then batch error order.
  await Promise.all(hashing);
  const failure = failures.find((value) => value !== undefined);
  if (failure) throw failure.error;
  const hashFailure = hashFailures.find((value) => value !== undefined);
  if (hashFailure) throw hashFailure.error;
  if (links.size) {
    const algorithm = head
      ? head.length === 64
        ? "sha256"
        : "sha1"
      : (await git(root, ["rev-parse", "--show-object-format"])).trim();
    for (const [file, bytes] of links)
      digests.set(
        file,
        createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      );
  }
  return digests;
}

/** Tree metadata supplies historical bytes' object identities without reading other files. */
async function treeDigests(root: string, head: string | null) {
  const result = new Map<string, string>();
  if (!head) return result;
  for (const entry of (await git(root, ["ls-tree", "-rz", "--full-tree", head])).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , digest] = entry.slice(0, tab).split(" ");
    if (mode !== "160000" && digest) result.set(entry.slice(tab + 1), digest);
  }
  return result;
}

async function observeGit(root: string, previous: GitSnapshot | undefined) {
  const [headObservation, statusObservation] = await Promise.allSettled([
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch((error) => {
      if (error.code !== 1) throw error;
      return "";
    }),
    git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=all",
    ]),
  ]);
  if (headObservation.status === "rejected") throw headObservation.reason;
  if (statusObservation.status === "rejected") throw statusObservation.reason;
  const head = headObservation.value.trim() || null;
  const status = statusObservation.value;
  const dirty = new Set(
    status
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .filter(eligible),
  );
  const candidates = new Set([...dirty, ...Object.keys(previous?.dirty ?? {})].filter(eligible));
  if (previous && previous.head !== head) {
    const empty = createHash((head ?? previous.head)!.length === 64 ? "sha256" : "sha1")
      .update("tree 0\0")
      .digest("hex");
    const changes = await git(root, [
      "diff",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "-z",
      previous.head ?? empty,
      head ?? empty,
    ]);
    for (const file of changes.split("\0")) if (eligible(file)) candidates.add(file);
  }
  const needsTree = [...candidates].some(
    (file) => !previous || !Object.prototype.hasOwnProperty.call(previous.dirty, file),
  );
  const before = needsTree
    ? await treeDigests(root, previous ? previous.head : head)
    : new Map<string, string>();
  const digests = await workingDigests(root, candidates, head);
  const current: GitSnapshot = { head, dirty: Object.create(null) };
  const files: string[] = [];
  for (const file of candidates) {
    const value = digests.get(file)!;
    const baseline =
      previous && Object.prototype.hasOwnProperty.call(previous.dirty, file)
        ? previous.dirty[file]
        : (before.get(file) ?? null);
    if (value !== baseline) files.push(file);
    if (dirty.has(file)) current.dirty[file] = value;
  }
  return { current, files };
}

/** The caller verifies Git. Checkout observations become the baseline only when Stop settles. */
export async function observeStopChanges(
  systemRoot: string,
  checkoutRoot: string,
): Promise<{
  files: string[];
  previousNodeProblems: Record<string, string>;
  previousHistory?: string;
  previousReferenceProblems: ReadonlySet<string>;
  readPreviousFile(file: string): Promise<string | undefined>;
  settle(settlement?: StopSettlement): Promise<void>;
}> {
  const root = await fs.realpath(path.resolve(checkoutRoot));
  const key = createHash("sha256").update(normalized(root)).digest("hex");
  const filename = path.join(systemRoot, "temp", "stop-snapshots", `${key}.json`);
  const previous = await load(filename);
  const observed = await observeGit(root, previous);
  const baseline = previous ?? { head: observed.current.head, dirty: {} };
  let baselineFiles: Map<string, string> | undefined;
  return {
    files: observed.files.sort(),
    previousNodeProblems: previous?.nodeProblems ?? {},
    ...(previous?.history ? { previousHistory: previous.history } : {}),
    previousReferenceProblems: new Set(previous?.referenceProblems ?? []),
    async readPreviousFile(file) {
      if (
        !eligible(file) ||
        !baseline.head ||
        Object.prototype.hasOwnProperty.call(baseline.dirty, file)
      )
        return;
      baselineFiles ??= await treeDigests(root, baseline.head);
      if (!baselineFiles.has(file)) return;
      return git(root, ["show", `${baseline.head}:${file}`]);
    },
    async settle({
      nodeProblems = previous?.nodeProblems ?? {},
      history = previous?.history ?? null,
      referenceProblems = previous?.referenceProblems ?? [],
    }: StopSettlement = {}) {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await durableReplace(
        filename,
        JSON.stringify({
          ...observed.current,
          nodeProblems,
          ...(history ? { history } : {}),
          referenceProblems: [...referenceProblems].sort(),
        }),
        "utf8",
      );
    },
  };
}
