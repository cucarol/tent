import * as z from "zod/v4";
import type { FsAdapter } from "../store/adapter.js";
import { documentVersionSchema } from "../store/git-history.js";
import { isHistoryFile } from "../store/document-history.js";

export const documentDiffSchema = z.strictObject({
  from: documentVersionSchema,
  to: documentVersionSchema,
});

/** Read retained bytes for a Node, Role, Card, or canvas file. */
export async function readDocumentVersion(fs: FsAdapter, input: unknown) {
  const version = documentVersionSchema.parse(input);
  if (!fs.history || !isHistoryFile(version.path)) throw new Error("Not a Tent history document");
  return { version, raw: await fs.history.read(version) };
}

export async function readDocumentDiff(fs: FsAdapter, input: unknown) {
  const { from, to } = documentDiffSchema.parse(input);
  if (!fs.history || ![from, to].every((version) => isHistoryFile(version.path)))
    throw new Error("Not a Tent history document");
  const text = await fs.history.diff(from, to);
  return {
    from,
    to,
    pathChanged: from.path !== to.path,
    text,
  };
}
