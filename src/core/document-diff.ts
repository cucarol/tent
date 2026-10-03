import * as z from "zod/v4";
import type { FsAdapter } from "./adapter.js";
import { documentVersionSchema } from "./git-history.js";
import { isHistoryDocument } from "./document-history.js";

export const documentDiffSchema = z.strictObject({
  from: documentVersionSchema,
  to: documentVersionSchema,
});

/** Read retained bytes for a Node, Role, Card or workspace annotation document. */
export async function readDocumentVersion(fs: FsAdapter, input: unknown) {
  const version = documentVersionSchema.parse(input);
  if (!fs.history || !isHistoryDocument(version.path))
    throw new Error("Not a Tent history document");
  return { version, raw: await fs.history.read(version) };
}

export async function readDocumentDiff(fs: FsAdapter, input: unknown) {
  const { from, to } = documentDiffSchema.parse(input);
  if (!fs.history || ![from, to].every((version) => isHistoryDocument(version.path)))
    throw new Error("Not a Tent history document");
  const text = await fs.history.diff(from, to);
  return {
    from,
    to,
    pathChanged: from.path !== to.path,
    text,
    range: { unit: "utf16" as const, start: 0, end: text.length },
    length: text.length,
  };
}
