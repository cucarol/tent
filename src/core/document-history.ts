import type { FsAdapter } from "./adapter.js";
import type { CaptureMetadata, DocumentVersion } from "./git-history.js";
import { isOperationalPath, nodeNotePath, MUTATION_LOCK_PATH } from "./paths.js";

/** Identity documents participate; operational caches do not. */
export function isHistoryDocument(file: string): boolean {
  if (/^roles\/role-[^/]+\.md$/.test(file)) return true;
  if (/^cards\/card-[^/]+\.md$/.test(file)) return true;
  if (isOperationalPath(file)) return false;
  const end = file.lastIndexOf("/");
  return end > 0 && file === nodeNotePath(file.slice(0, end));
}

/** Caller holds the mutation lock. Captures the exact bytes delivered, not a later reread. */
export async function captureDocumentUnlocked(
  fs: FsAdapter,
  path: string,
  raw: string,
  metadata?: CaptureMetadata,
): Promise<DocumentVersion | undefined> {
  if (!isHistoryDocument(path)) throw new Error(`Not a Tent identity document: ${path}`);
  const invalid = fs.invalidNodeEdits?.get(path);
  if (invalid) throw new Error(`Invalid Node ${path}: ${invalid}`);
  if (!fs.history || !(await fs.exists(".git"))) return undefined;
  return (await fs.history.captureUnlocked([{ path, raw }], metadata)).versions[0];
}

/** Read capture may write Git only; it does not resume document mutations. */
export function captureReadDocument(
  fs: FsAdapter,
  path: string,
  raw: string,
  entry?: CaptureMetadata["entry"],
): Promise<DocumentVersion | undefined> {
  const capture = () =>
    captureDocumentUnlocked(fs, path, raw, { operation: "document.external-capture", entry });
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, capture) : capture();
}

/** One read response captures only the full documents actually represented in that response. */
export function captureReadDocuments(
  fs: FsAdapter,
  documents: readonly { path: string; raw: string }[],
  entry?: CaptureMetadata["entry"],
): Promise<DocumentVersion[]> {
  const capture = async () => {
    for (const { path } of documents)
      if (!isHistoryDocument(path)) throw new Error(`Not a Tent identity document: ${path}`);
      else if (fs.invalidNodeEdits?.has(path))
        throw new Error(`Invalid Node ${path}: ${fs.invalidNodeEdits.get(path)}`);
    if (!documents.length || !fs.history || !(await fs.exists(".git"))) return [];
    return (
      await fs.history.captureUnlocked(documents, { operation: "document.external-capture", entry })
    ).versions;
  };
  return fs.withLock ? fs.withLock(MUTATION_LOCK_PATH, capture) : capture();
}
