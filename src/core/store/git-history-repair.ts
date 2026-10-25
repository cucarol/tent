import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { GitDocumentHistory, runGit } from "./git-history.js";
import { HistoryDamageError, indexDamage } from "./history-damage.js";
import { isHistoryFile } from "./document-history.js";
import { checkedSourceFile } from "../../fs/checked-source-file.js";
import { durableMkdir, durableReplace } from "../../fs/durable-file.js";
import { archiveExistingReflogs } from "./git-reflogs.js";

type Commit = { commit: string; parents: string[]; time: string; subject: string };
export type HistoryRepairResult = {
  intact: boolean;
  head?: string;
  subject?: string;
  time?: string;
  backup?: string;
  repaired: string[];
  restored: string[];
  kept: string[];
  reflogArchive?: string;
  fsck: "clean";
};
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

async function readIfPresent(filename: string) {
  return fs.readFile(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function referenceName(raw: Buffer): string {
  const head = raw.toString("utf8").trim();
  if (objectId.test(head)) return "HEAD";
  const ref = head.startsWith("ref: ") ? head.slice(5) : "";
  if (
    !ref.startsWith("refs/") ||
    /[\\\x00-\x20\x7f:]/.test(ref) ||
    ref.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new HistoryDamageError(
      "HEAD has no readable branch declaration; restore its symbolic branch declaration before repairing.",
    );
  return ref;
}

async function commitGraph(root: string): Promise<Map<string, Commit>> {
  const objects = (
    await runGit(root, [
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype)",
    ])
  ).toString("ascii");
  const commits = objects.split("\n").flatMap((line) => {
    const [id, type] = line.split(" ");
    return type === "commit" && id && objectId.test(id) ? [id] : [];
  });
  if (!commits.length) return new Map();
  const fields = (
    await runGit(
      root,
      [
        "log",
        "--no-walk",
        "--no-color",
        "--no-show-signature",
        "--format=%H%x00%P%x00%cI%x00%s%x00",
        "--stdin",
      ],
      { input: Buffer.from(commits.join("\n") + "\n") },
    )
  )
    .toString("utf8")
    .split("\0");
  const graph = new Map<string, Commit>();
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const commit = fields[i]!.trim();
    if (!objectId.test(commit)) throw new HistoryDamageError("cannot read the commit graph.");
    graph.set(commit, {
      commit,
      parents: fields[i + 1]!.split(" ").filter(Boolean),
      time: fields[i + 2]!,
      subject: fields[i + 3]!,
    });
  }
  return graph;
}

function recoveryPoint(graph: Map<string, Commit>, explicit?: string): Commit {
  if (explicit !== undefined) {
    if (!/^[a-f0-9]{7,64}$/.test(explicit))
      throw new HistoryDamageError("--head must name an intact commit object.", true);
    const matches = [...graph.values()].filter((value) => value.commit.startsWith(explicit));
    if (matches.length !== 1)
      throw new HistoryDamageError("--head does not identify exactly one intact commit.", true);
    return matches[0]!;
  }
  const parents = new Set([...graph.values()].flatMap((record) => record.parents));
  const tips = [...graph.keys()].filter((id) => !parents.has(id));
  if (tips.length === 1) return graph.get(tips[0]!)!;
  const rows = tips.sort().map((id) => {
    const record = graph.get(id)!;
    return `  ${id}  ${record.time}  ${record.subject}`;
  });
  throw new HistoryDamageError(
    `cannot choose a recovery point. ${tips.length} commits could be the latest:\n${rows.join("\n")}\nThe commit you do not pick stays in the object store.`,
    true,
  );
}

/** Caller holds mutation.lock. Git's locks also exclude manual ref/index writers during repair. */
export async function repairHistoryUnlocked(
  root: string,
  options: { head?: string } = {},
): Promise<HistoryRepairResult> {
  const gitDir = path.join(root, ".git");
  if (!(await fs.lstat(gitDir).catch(() => undefined))?.isDirectory())
    throw new Error(
      "Tent Git history is unavailable: requires an independent .tent/.git repository",
    );
  const headBefore = await fs.readFile(path.join(gitDir, "HEAD"));
  const ref = referenceName(headBefore);
  const locks: Array<{ filename: string; handle: fs.FileHandle }> = [];
  let temporary: string | undefined;
  try {
    for (const file of new Set(["HEAD", ref, "index"])) {
      const filename = path.join(gitDir, file + ".lock");
      await fs.mkdir(path.dirname(filename), { recursive: true });
      locks.push({ filename, handle: await fs.open(filename, "wx") });
    }
    if (!(await fs.readFile(path.join(gitDir, "HEAD"))).equals(headBefore))
      throw new Error("Tent Git HEAD changed before repair; reread before retrying");
    const graph = await commitGraph(root);
    const format = graph.keys().next().value?.length === 64 ? "sha256" : "sha1";
    // Validate objects without consulting the damaged live refs, index or reflogs.
    temporary = await fs.mkdtemp(path.join(gitDir, "tent-repair-validate-"));
    await runGit(temporary, ["init", "--quiet", `--object-format=${format}`]);
    await fs.writeFile(
      path.join(temporary, ".git/objects/info/alternates"),
      path.join(gitDir, "objects").replaceAll("\\", "/") + "\n",
    );
    await runGit(temporary, ["fsck", "--full", "--no-reflogs", "--no-dangling"]);
    const before = new Map<string, Buffer | undefined>([[".git/HEAD", headBefore]]);
    const refPath = `.git/${ref}`;
    const refBytes = await readIfPresent(path.join(root, refPath));
    before.set(refPath, refBytes);
    let live: string | null = null;
    try {
      live = await new GitDocumentHistory(root).currentCommit();
    } catch (error) {
      if (!(error instanceof HistoryDamageError)) throw error;
    }
    const liveCommit = live && objectId.test(live) ? graph.get(live) : undefined;
    if (!graph.size && !live && options.head === undefined) {
      const damage = await indexDamage(root, format === "sha256" ? 64 : 40);
      if (!damage)
        return {
          intact: true,
          repaired: [],
          restored: [],
          kept: [],
          fsck: "clean",
        };
    }
    const selected =
      options.head !== undefined
        ? recoveryPoint(graph, options.head)
        : (liveCommit ?? recoveryPoint(graph));
    const indexFile = path.join(gitDir, "index");
    before.set(".git/index", await readIfPresent(indexFile));
    let badIndex = !before.get(".git/index") || !!(await indexDamage(root, selected.commit.length));
    if (!badIndex) {
      try {
        await runGit(root, ["ls-files", "--stage", "-z"]);
      } catch {
        badIndex = true;
      }
    }
    const restored: string[] = [],
      kept: string[] = [];
    const replacements = new Map<string, Buffer>();
    const tree = (await runGit(root, ["ls-tree", "-r", "-z", selected.commit]))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const row of tree) {
      const match = /^100644 blob ([a-f0-9]+)\t(.+)$/.exec(row);
      if (!match) continue;
      const file = match[2]!;
      if (
        file.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
        /[\\\x00-\x1f]/.test(file)
      )
        throw new HistoryDamageError(`unsafe tracked file path: ${file}`);
      if (!isHistoryFile(file)) continue;
      const filename = path.join(root, file);
      const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return;
        throw error;
      });
      if (!stat || !stat.isFile()) {
        kept.push(file);
        continue;
      }
      await checkedSourceFile(root, filename);
      const current = await fs.readFile(filename);
      const hash = createHash(selected.commit.length === 64 ? "sha256" : "sha1")
        .update(`blob ${current.length}\0`)
        .update(current)
        .digest("hex");
      if (hash === match[1]) continue;
      if (current.length && current.every((byte) => byte === 0)) {
        before.set(file, current);
        replacements.set(file, await runGit(root, ["cat-file", "blob", match[1]!]));
        restored.push(file);
      } else kept.push(file);
    }
    const badRef = live !== selected.commit;
    if (!badRef && !badIndex && !restored.length)
      return {
        intact: true,
        head: selected.commit,
        repaired: [],
        restored,
        kept,
        fsck: "clean",
      };
    if (badRef) replacements.set(refPath, Buffer.from(selected.commit + "\n"));
    if (badIndex || badRef) {
      const index = path.join(temporary, "prepared-index");
      await runGit(root, ["read-tree", selected.commit], { index });
      replacements.set(".git/index", await fs.readFile(index));
    }
    const backup = path.join(
      gitDir,
      "tent-repair",
      new Date().toISOString().replaceAll(/[-:.]/g, ""),
    );
    await durableMkdir(path.dirname(backup));
    await fs.mkdir(backup);
    for (const file of replacements.keys()) {
      const bytes = before.get(file);
      if (!bytes) continue;
      const destination = path.join(backup, file);
      await durableMkdir(path.dirname(destination));
      await durableReplace(destination, bytes);
    }
    await durableReplace(
      path.join(backup, "manifest.json"),
      JSON.stringify(
        {
          head: selected.commit,
          files: [...replacements.keys()].map((file) => ({
            path: file,
            sha256: before.get(file)
              ? createHash("sha256").update(before.get(file)!).digest("hex")
              : null,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    const same = (a: Buffer | undefined, b: Buffer | undefined) =>
      a === undefined ? b === undefined : b !== undefined && a.equals(b);
    for (const [file, bytes] of before)
      if (!same(await readIfPresent(path.join(root, file)), bytes))
        throw new Error(
          `File changed during repair: ${file}; backup is ${backup}; reread before retrying`,
        );
    for (const [file, bytes] of replacements) {
      if (!same(await readIfPresent(path.join(root, file)), before.get(file)))
        throw new Error(
          `File changed during repair: ${file}; backup is ${backup}; reread before retrying`,
        );
      await durableReplace(path.join(root, file), bytes);
    }
    const reflogArchive = await archiveExistingReflogs(root);
    // fsck treats even our owned ref.lock as a malformed ref. The Tent mutation
    // lock remains held; release native Git locks before its final reference scan.
    while (locks.length) {
      const lock = locks.pop()!;
      await lock.handle.close();
      await fs.unlink(lock.filename);
    }
    try {
      await runGit(root, ["fsck", "--full", "--no-dangling"]);
      if ((await new GitDocumentHistory(root).currentCommit()) !== selected.commit)
        throw new Error("Tent Git HEAD changed during repair validation; reread before retrying");
    } catch (error) {
      throw new HistoryDamageError(
        `repair needs further attention; backup is ${backup}. ${String(error)}`,
      );
    }
    return {
      intact: false,
      head: selected.commit,
      subject: selected.subject,
      time: selected.time,
      backup: path.relative(path.dirname(root), backup).replaceAll("\\", "/"),
      repaired: [
        ...(badRef ? ["branch ref rewritten"] : []),
        ...(badIndex || badRef ? ["index rebuilt"] : []),
      ],
      restored,
      kept,
      ...(reflogArchive ? { reflogArchive } : {}),
      fsck: "clean",
    };
  } finally {
    for (const lock of locks.reverse()) {
      await lock.handle.close();
      await fs.unlink(lock.filename);
    }
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}

export function formatHistoryRepair(result: HistoryRepairResult): string {
  if (result.intact) return "Tent history is intact.";
  return [
    `Repaired Tent history at ${result.head!.slice(0, 8)} (${result.subject}, ${result.time}).`,
    ...(result.repaired.length ? [`  ${result.repaired.join(", ")}`] : []),
    ...(result.restored.length ? [`  restored from Git: ${result.restored.join(", ")}`] : []),
    ...(result.kept.length ? [`  kept as edited: ${result.kept.join(", ")}`] : []),
    `Backup: ${result.backup}/`,
    ...(result.reflogArchive ? [`Previous reflogs: ${result.reflogArchive}/`] : []),
    "git fsck: clean",
  ].join("\n");
}
