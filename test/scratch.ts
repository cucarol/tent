import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isHistoryDocument } from "../src/core/store/document-history.js";
import { execFileSync } from "node:child_process";
import { initializeTentWorkspace } from "../src/fs/workspace-init.js";
import { fileURLToPath } from "node:url";
import { SqliteDocumentHistory } from "../src/fs/sqlite-history.js";
import type { DocumentVersion } from "../src/core/store/history-port.js";

export async function historyHead(root: string): Promise<string> {
  const history = new SqliteDocumentHistory(root);
  try {
    const head = await history.currentCommit();
    if (!head) throw new Error("The fixture has no retained event");
    return head;
  } finally {
    await history.close();
  }
}
export async function historyRead(root: string, version: DocumentVersion): Promise<string> {
  const history = new SqliteDocumentHistory(root);
  try {
    return await history.read(version);
  } finally {
    await history.close();
  }
}
export async function historyPaths(root: string): Promise<string[]> {
  const history = new SqliteDocumentHistory(root);
  try {
    return await history.retainedPaths();
  } finally {
    await history.close();
  }
}

/** Seed retained fixture bytes through the same history port as Core capture. */
export async function captureFixtureDocuments(root: string): Promise<void> {
  const history = new SqliteDocumentHistory(root),
    changes: Array<{ path: string; raw: string | null }> = [];
  async function walk(directory: string) {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, entry.name);
      if (file === ".git" || file === "temp") continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && isHistoryDocument(file))
        changes.push({ path: file, raw: await fs.readFile(path.join(root, file), "utf8") });
    }
  }
  try {
    await walk("");
    const current = new Set(changes.map((c) => c.path));
    for (const file of await history.retainedPaths())
      if (!current.has(file)) changes.push({ path: file, raw: null });
    await history.captureUnlocked(changes, { operation: "document.external-capture" });
  } finally {
    await history.close();
  }
}

/** Keep every disposable test fixture inside this checkout. */
export function testScratchRoot(): string {
  const root = fileURLToPath(new URL("../.scratch/", import.meta.url));
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

export async function initializeFixtureHistory(root: string): Promise<void> {
  const history = new SqliteDocumentHistory(root);
  try {
    await history.initialize();
  } finally {
    await history.close();
  }
  const workspace = path.basename(root) === ".tent" ? path.dirname(root) : root;
  initializeFixtureRepository(workspace);
}

/** Fixture initialization must never modify the checkout's shared Git exclude file. */
export function initializeFixtureRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  const marker = lstatSync(path.join(root, ".git"), { throwIfNoEntry: false });
  if (marker?.isFile() || (marker?.isDirectory() && existsSync(path.join(root, ".git/HEAD"))))
    return;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch=main", "--template="], {
    env,
    windowsHide: true,
  });
}

export async function initializeFixtureWorkspace(root: string): Promise<void> {
  initializeFixtureRepository(root);
  await initializeTentWorkspace(root);
}
