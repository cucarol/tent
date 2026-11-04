import type { FsAdapter } from "../store/adapter.js";
import { documentVersionSchema } from "../store/history-port.js";
import { parseFrontmatter } from "../base/frontmatter.js";

/** A retained Node document's raw bytes, after checking it belongs to the requested Node. */
export async function readNodeVersion(fs: FsAdapter, nodeId: string, input: unknown) {
  const version = documentVersionSchema.parse(input);
  const text = await fs.history.read(version);
  if (parseFrontmatter(text).data.id !== nodeId)
    throw new Error("Historical version belongs to another Node");
  return { nodeId, path: version.path.slice(0, version.path.lastIndexOf("/")), version, text };
}
