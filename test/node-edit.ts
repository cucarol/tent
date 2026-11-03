import type { FsAdapter } from "../src/core/store/adapter.js";
import { documentLifecycle } from "../src/core/base/document-status.js";
import { contentEtag } from "../src/core/base/etag.js";
import { parseFrontmatter } from "../src/core/base/frontmatter.js";
import { nodeNotePath } from "../src/core/base/paths.js";
import { loadNodeCatalog, readCatalogDocument } from "../src/core/graph/node-catalog.js";
import {
  prepareNodeDocumentWrite,
  type NodeDocumentEdit,
} from "../src/core/graph/node-document-write.js";
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
  const { raw } = await readCatalogDocument(fs, node);
  const { data, body } = parseFrontmatter(raw);
  const path = nodeNotePath(node.path);
  return {
    nodeId,
    directory: node.path,
    path,
    raw,
    etag: contentEtag(raw),
    body,
    frontmatter: data,
    ...documentLifecycle(data),
    ...(options.capture ? await latestVersion(fs, path) : {}),
  };
}

/** Edits a Node as an Agent does: rewrite the file, then capture it as the next Tent command would. */
export async function editNode(fs: FsAdapter, nodeId: string, edit: NodeDocumentEdit) {
  const current = await readNodeFile(fs, nodeId);
  const raw = prepareNodeDocumentWrite({ id: nodeId, path: current.directory }, current.raw, edit);
  if (raw !== current.raw) await fs.writeFile(current.path, raw);
  const { invalidNodes } = await captureNativeNodeEdits(fs);
  if (invalidNodes.length) throw new Error(invalidNodes.map(({ reason }) => reason).join("; "));
  return {
    ...current,
    raw,
    etag: contentEtag(raw),
    changed: raw !== current.raw,
    ...(await latestVersion(fs, current.path)),
  };
}
