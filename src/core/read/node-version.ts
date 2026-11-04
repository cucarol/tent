import type { FsAdapter } from "../store/adapter.js";
import { isHistoryDocument } from "../store/document-history.js";
import { documentVersionSchema } from "../store/history-port.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { isNodeId } from "../base/id.js";
import { normalizeOptionalNodeType } from "../base/node-type.js";

/** A retained Node document's raw bytes, after checking it belongs to the requested Node. */
export async function readNodeVersion(fs: FsAdapter, nodeId: string, input: unknown) {
  const version = documentVersionSchema.parse(input);
  if (!isHistoryDocument(version.path)) throw new Error("Not a Tent history document");
  const text = await fs.history.read(version);
  const data = parseFrontmatter(text).data;
  if (typeof data.id !== "string" || !isNodeId(data.id))
    throw new Error("Historical document must have a canonical Node id");
  normalizeOptionalNodeType(data.type);
  if (data.id !== nodeId) throw new Error("Historical version belongs to another Node");
  return { nodeId, path: version.path.slice(0, version.path.lastIndexOf("/")), version, text };
}
