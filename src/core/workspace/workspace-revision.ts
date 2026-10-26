import { hasDocumentHistory } from "../store/history-port.js";
import { createHash } from "node:crypto";
import path from "node:path";
import type { FsAdapter } from "../store/adapter.js";
import { isHistoryFile } from "../store/document-history.js";
import { completedCardPaths } from "../graph/card-document.js";
import {
  CARDS_DIR,
  ROLES_DIR,
  isOperationalPath,
  ORDER_PATH,
  WORKSPACE_SETTINGS_PATH,
} from "../base/paths.js";

/** Discover current documents; completed Cards change routine views only through Tent history. */
export async function workspaceDocumentPaths(fs: FsAdapter): Promise<string[]> {
  const files: string[] = [];
  const completed = await completedCardPaths(fs);
  const directories = [""];
  let next = 0;
  while (next < directories.length) {
    const batch = directories.slice(next, next + 16);
    next += batch.length;
    const listings = await Promise.all(batch.map((dir) => fs.listDir(dir)));
    for (const [index, dir] of batch.entries()) {
      for (const entry of listings[index]!) {
        const file = path.posix.join(dir, entry.name);
        if (dir === CARDS_DIR && completed.has(file)) continue;
        if (entry.isDir) {
          if (
            !dir &&
            isOperationalPath(entry.name) &&
            entry.name !== ROLES_DIR &&
            entry.name !== CARDS_DIR
          )
            continue;
          if (dir === ROLES_DIR || dir === CARDS_DIR) continue;
          directories.push(file);
        } else if (isHistoryFile(file)) files.push(file);
      }
    }
  }
  return files.sort();
}

/** Hash validated current identities and Tent HEAD without capture or a watcher. */
export async function readWorkspaceRevision(fs: FsAdapter): Promise<string> {
  const run = () => readRevisionInScope(fs);
  return fs.observationScope ? fs.observationScope(run) : run();
}

async function readRevisionInScope(fs: FsAdapter): Promise<string> {
  const files = new Set(await workspaceDocumentPaths(fs));
  for (const file of [ORDER_PATH, WORKSPACE_SETTINGS_PATH])
    if (await fs.exists(file)) files.add(file);
  const digest = createHash("sha256");
  const sorted = [...files].sort();
  for (let start = 0; start < sorted.length; start += 8) {
    const batch = sorted.slice(start, start + 8);
    const contents = await Promise.all(
      batch.map(async (file) => {
        if (fs.readContentDigest) return fs.readContentDigest(file);
        const bytes = await fs.readBinary(file);
        return { size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
      }),
    );
    for (const [index, file] of batch.entries()) {
      const content = contents[index]!;
      digest.update(JSON.stringify([file, content.size, content.digest]) + "\n");
    }
  }
  const head =
    fs.history && (await hasDocumentHistory(fs)) ? await fs.history.currentCommit() : null;
  digest.update(JSON.stringify({ head }));
  return digest.digest("hex");
}
