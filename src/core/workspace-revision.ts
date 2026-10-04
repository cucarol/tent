import { createHash } from "node:crypto";
import path from "node:path";
import type { FsAdapter } from "./adapter.js";
import { isHistoryDocument } from "./document-history.js";
import {
  CARDS_DIR,
  ROLES_DIR,
  OPERATIONAL_TOP_LEVEL,
  ORDER_PATH,
  WORKSPACE_SETTINGS_PATH,
} from "./paths.js";

/** Scan filenames only, including malformed identity documents so edits remain observable. */
export async function workspaceDocumentPaths(fs: FsAdapter): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string) {
    for (const entry of await fs.listDir(dir)) {
      const file = path.posix.join(dir, entry.name);
      if (entry.isDir) {
        if (
          !dir &&
          OPERATIONAL_TOP_LEVEL.has(entry.name) &&
          entry.name !== ROLES_DIR &&
          entry.name !== CARDS_DIR
        )
          continue;
        if (dir === ROLES_DIR || dir === CARDS_DIR) continue;
        await visit(file);
      } else if (isHistoryDocument(file)) files.push(file);
    }
  }
  await visit("");
  return files.sort();
}

/** No document parsing, Git diff, capture or watcher; hash the bytes used by the UI. */
export async function readWorkspaceRevision(fs: FsAdapter): Promise<string> {
  const files = new Set(await workspaceDocumentPaths(fs));
  for (const file of [ORDER_PATH, WORKSPACE_SETTINGS_PATH])
    if (await fs.exists(file)) files.add(file);
  const digest = createHash("sha256");
  for (const file of [...files].sort()) {
    const bytes = await fs.readBinary(file);
    digest.update(JSON.stringify([file, bytes.length]) + "\n").update(bytes);
  }
  const head = fs.history && (await fs.exists(".git")) ? await fs.history.currentCommit() : null;
  digest.update(JSON.stringify({ head }));
  return digest.digest("hex");
}
