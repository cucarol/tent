import { isDeepStrictEqual } from "node:util";
import type { FsAdapter } from "../src/core/store/adapter.js";
import { documentLifecycle } from "../src/core/base/document-status.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/base/frontmatter.js";
import { nodeNotePath } from "../src/core/base/paths.js";
import { loadNodeCatalog } from "../src/core/graph/node-catalog.js";
import { assertNodeEdit } from "../src/core/graph/node-document-write.js";
import { captureNativeNodeEdits } from "../src/core/graph/node-native-capture.js";
import type { OpsEnv } from "../src/core/graph/ops-context.js";
import {
  withNodeBatchMutation,
  writeNodesBatchUnlocked,
  type NodeWriteBatchInput,
} from "../src/core/write/node-write-batch.js";

/** Saves a batch under the same lock and writer that `node create --draft` uses. */
export const saveNodesBatch = (env: OpsEnv, input: NodeWriteBatchInput) =>
  withNodeBatchMutation(env, () => writeNodesBatchUnlocked(env, input));

async function latestVersion(fs: FsAdapter, path: string) {
  if (!(await fs.history?.available())) return {};
  const version = (await fs.history!.pathVersions(path)).latest;
  return version ? { version } : {};
}

/**
 * A Node's current file, as an Agent reads it. With `capture`, Tent first records
 * pending native edits, as any Tent command does, and the result names the version.
 */
export async function readNodeFile(
  fs: FsAdapter,
  nodeId: string,
  options: { capture?: boolean } = {},
) {
  if (options.capture) await captureNativeNodeEdits(fs);
  const node = (await loadNodeCatalog(fs)).byId.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  const path = nodeNotePath(node.path);
  const raw = await fs.readFile(path);
  const { data, body } = parseFrontmatter(raw);
  return {
    nodeId,
    directory: node.path,
    path,
    raw,
    body,
    frontmatter: data,
    ...documentLifecycle(data),
    ...(options.capture ? await latestVersion(fs, path) : {}),
  };
}

type NodeEdit = { raw?: string; body?: string; frontmatter?: Record<string, unknown> };

/** The bytes an editor leaves behind: the whole new file, or these fields and body changed in place. */
function editedFile(previous: string, edit: NodeEdit) {
  if (edit.raw !== undefined) return edit.raw;
  const { data, body, keyOrder } = parseFrontmatter(previous);
  const nextData = { ...data, ...edit.frontmatter };
  const nextBody = edit.body ?? body;
  return nextBody === body && isDeepStrictEqual(nextData, data)
    ? previous
    : serializeFrontmatter(nextData, nextBody, keyOrder);
}

/** Edits a Node as an Agent does: rewrite the file, then capture it as the next Tent command would. */
export async function editNode(fs: FsAdapter, nodeId: string, edit: NodeEdit) {
  const current = await readNodeFile(fs, nodeId);
  const raw = editedFile(current.raw, edit);
  assertNodeEdit(current.directory, current.raw, raw);
  if (raw !== current.raw) await fs.writeFile(current.path, raw);
  const { invalidNodes } = await captureNativeNodeEdits(fs);
  if (invalidNodes.length) throw new Error(invalidNodes.map(({ reason }) => reason).join("; "));
  return {
    ...current,
    raw,
    changed: raw !== current.raw,
    ...(await latestVersion(fs, current.path)),
  };
}
