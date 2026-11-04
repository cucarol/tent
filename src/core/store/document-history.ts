import type { FsAdapter } from "./adapter.js";
import type { CaptureMetadata, DocumentVersion } from "./history-port.js";
import { isNodeNotePath } from "../base/paths.js";

/** Identity documents participate; operational caches do not. */
export function isHistoryDocument(file: string): boolean {
  if (/^roles\/role-[^/]+\.md$/.test(file)) return true;
  if (/^cards\/card-[^/]+\.md$/.test(file)) return true;
  return isNodeNotePath(file);
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
  if (!(await fs.history.available())) return undefined;
  return (await fs.history.captureUnlocked([{ path, raw }], metadata)).versions[0];
}
