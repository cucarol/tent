import { isDeepStrictEqual } from "node:util";
import { contentEtag } from "./etag.js";
import { parseFrontmatter, serializeFrontmatter, syncNodeTitle } from "./frontmatter.js";
import { MaterialAddressError, validateMaterialAddresses } from "./material.js";
import { normalizeOptionalNodeType } from "./node-type.js";
import { normalizeTagList } from "./tags.js";
import type { Node } from "./types.js";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { loadNodeCatalog, readCatalogDocument } from "./node-catalog.js";
import { captureDocumentUnlocked } from "./document-history.js";
import { nodeNotePath } from "./paths.js";
import { isNodeId } from "./id.js";
import { assertStatusEdit } from "./document-status.js";
import { ReaderError } from "./context-reader.js";
import { canonicalDocumentReferences } from "./document-links.js";
import { isIncompleteNodeReadEtag, nodeReadRevisionEtag } from "./node-read-basis.js";
import { assertNodeRecordFields, isOutputNode, prepareNodeSyncSave } from "./node-sync-record.js";
import { prepareNodeProvenanceSave, assertNodeProvenanceEdit } from "./node-provenance.js";

export class NodeWriteError extends Error {
  constructor(
    readonly code:
      | "ETAG_REQUIRED"
      | "ETAG_CONFLICT"
      | "INCOMPLETE_READ"
      | "INVALID_INPUT"
      | "INVALID_EDIT"
      | "NOT_FOUND",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NodeWriteError";
  }
}

export type NodeDocumentEdit = {
  baseEtag?: string;
  raw?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  confirm?: boolean;
  by?: string;
};

/** Shared Core entry for direct CLI and other hosts. */
export function writeNodeDocument(fs: FsAdapter, nodeId: string, input: NodeDocumentEdit) {
  return withTentMutation(fs, () => writeNodeDocumentUnlocked(fs, nodeId, input), {
    operation: "node.write",
  });
}

/** Caller holds the mutation lock through any additional work using the returned bytes. */
export async function writeNodeDocumentUnlocked(
  fs: FsAdapter,
  nodeId: string,
  input: NodeDocumentEdit,
) {
  if (!isNodeId(nodeId))
    throw new NodeWriteError(
      "INVALID_INPUT",
      `nodeId must be a canonical node-* Node id: ${nodeId}`,
    );
  const node = (await loadNodeCatalog(fs)).byId.get(nodeId);
  if (!node) throw new NodeWriteError("NOT_FOUND", `Node not found: ${nodeId}`);
  const document = await readCatalogDocument(fs, node).catch((error) => {
    if (error instanceof ReaderError && error.code === "SOURCE_CHANGED") {
      throw new NodeWriteError("ETAG_CONFLICT", "etag conflict: Node changed during lookup", {
        code: "etag_conflict",
        path: node.path,
        nodeId,
        baseEtag: input.baseEtag,
      });
    }
    throw error;
  });
  const raw = prepareNodeDocumentWrite({ id: nodeId, path: node.path }, document.raw, input);
  const parsed = parseFrontmatter(raw);
  const canonicalBody = await canonicalDocumentReferences(
    fs,
    nodeNotePath(node.path),
    parsed.data,
    parsed.body,
  );
  return savePreparedNodeDocumentUnlocked(
    fs,
    { id: nodeId, name: node.name, path: node.path },
    document.raw,
    serializeFrontmatter(parsed.data, canonicalBody, parsed.keyOrder),
    input,
    "node.write",
  );
}

/** Persist validated, reference-resolved bytes under the caller's mutation lock. */
export async function savePreparedNodeDocumentUnlocked(
  fs: FsAdapter,
  node: Pick<Node, "id" | "name" | "path">,
  diskRaw: string,
  preparedRaw: string,
  input: NodeDocumentEdit,
  operation: string,
) {
  const nodeId = node.id;
  const now = new Date().toISOString();
  const { raw, record } = await prepareNodeSyncSave(
    fs,
    nodeNotePath(node.path),
    prepareNodeProvenanceSave(preparedRaw, diskRaw, input.by, now),
    {
      now,
      confirm: input.confirm,
      by: input.by,
      acknowledge:
        operation === "node.write" &&
        isOutputNode(parseFrontmatter(preparedRaw).data) &&
        parseFrontmatter(preparedRaw).body.replace(/\r\n?/g, "\n") !==
          parseFrontmatter(diskRaw).body.replace(/\r\n?/g, "\n"),
    },
  );
  const changed = raw !== diskRaw;
  const path = nodeNotePath(node.path);
  const currentRaw = await fs.readFile(path);
  if (currentRaw !== diskRaw)
    throw new NodeWriteError(
      "ETAG_CONFLICT",
      "etag conflict: Node changed while resolving references",
      {
        code: "etag_conflict",
        path: node.path,
        nodeId,
        baseEtag: input.baseEtag,
        currentEtag: contentEtag(currentRaw),
      },
    );
  if (changed) await fs.writeFile(path, raw);
  let version;
  try {
    version = await captureDocumentUnlocked(fs, path, raw, {
      operation,
      nodeRecords: { [nodeId]: record },
    });
  } catch (error) {
    if (changed && (await fs.readFile(path)) === raw) await fs.writeFile(path, diskRaw);
    throw error;
  }
  return {
    nodeId,
    name: node.name,
    path: node.path,
    raw,
    etag: contentEtag(raw),
    changed,
    version,
  };
}

/** Prepare an edit against exact observed bytes; the caller holds the mutation lock through saving. */
export function prepareNodeDocumentWrite(
  node: Pick<Node, "id" | "path">,
  diskRaw: string,
  input: NodeDocumentEdit,
): string {
  const { baseEtag, raw: rawInput, body, frontmatter } = input;
  const currentEtag = contentEtag(diskRaw);
  // Existing documents require the caller's observed revision.
  if (!baseEtag) {
    throw new NodeWriteError("ETAG_REQUIRED", "node.write requires baseEtag for existing nodes", {
      code: "etag_required",
      currentEtag,
      path: node.path,
      nodeId: node.id,
    });
  }
  if (
    isIncompleteNodeReadEtag(baseEtag) &&
    (rawInput !== undefined || body !== undefined || input.confirm === true)
  ) {
    throw new NodeWriteError(
      "INCOMPLETE_READ",
      "Incomplete Node read cannot replace or confirm content; use tent node get <nodeId> --full before writing",
      { code: "incomplete_read", nodeId: node.id, path: node.path },
    );
  }
  if (nodeReadRevisionEtag(baseEtag) !== currentEtag) {
    throw new NodeWriteError("ETAG_CONFLICT", "etag conflict", {
      code: "etag_conflict",
      currentEtag,
      baseEtag,
      path: node.path,
      nodeId: node.id,
    });
  }

  let nextRaw: string;
  if (rawInput !== undefined) {
    const diskParsed = parseFrontmatter(diskRaw);
    const nextParsed = parseFrontmatter(rawInput);
    // The Node id is the document identity and cannot be changed here.
    assertRawDocsWriteReserved(diskParsed.data, nextParsed.data);
    validateSyncMetadata(diskParsed.data, nextParsed.data);
    assertNodeProvenanceEdit(diskParsed.data, nextParsed.data);
    assertStatusEdit(diskParsed.data, nextParsed.data);
    normalizeOptionalNodeType(nextParsed.data.type);
    if (nextParsed.data.tags !== undefined) normalizeTagList(nextParsed.data.tags);
    validateNodeMaterials(nextParsed.data, node.path, diskParsed.data);
    const previousTitle = nextParsed.data.title;
    syncNodeTitle(nextParsed.data, node.path);
    nextRaw =
      nextParsed.data.title === previousTitle
        ? rawInput
        : serializeFrontmatter(nextParsed.data, nextParsed.body, nextParsed.keyOrder);
  } else {
    if (frontmatter) {
      assertReservedDocsWriteFields(frontmatter);
    }

    if (
      body === undefined &&
      input.confirm !== true &&
      (!frontmatter || Object.keys(frontmatter).length === 0)
    ) {
      throw new NodeWriteError(
        "INVALID_INPUT",
        "node.write requires raw, body, and/or frontmatter",
      );
    }
    const current = parseFrontmatter(diskRaw);
    const merged = { ...current.data, ...frontmatter };
    validateSyncMetadata(current.data, merged);
    assertNodeProvenanceEdit(current.data, merged);
    assertStatusEdit(current.data, merged);
    if (frontmatter && "type" in frontmatter)
      merged.type = normalizeOptionalNodeType(frontmatter.type);
    if (frontmatter && "tags" in frontmatter) {
      const tags = normalizeTagList(frontmatter.tags);
      if (tags.length) merged.tags = tags;
      else delete merged.tags;
    }
    validateNodeMaterials(merged, node.path, current.data);
    syncNodeTitle(merged, node.path);
    const nextBody = body ?? current.body;
    nextRaw =
      nextBody === current.body && isDeepStrictEqual(merged, current.data)
        ? diskRaw
        : serializeFrontmatter(merged, nextBody, current.keyOrder);
  }

  return nextRaw;
}

function validateSyncMetadata(previous: Record<string, unknown>, next: Record<string, unknown>) {
  try {
    assertNodeRecordFields(next);
  } catch (error) {
    throw new NodeWriteError("INVALID_EDIT", String(error));
  }
}

function validateNodeMaterials(
  data: Record<string, unknown>,
  nodePath: string,
  previous: Record<string, unknown>,
): void {
  try {
    validateMaterialAddresses(data, nodeNotePath(nodePath), previous);
  } catch (error) {
    if (error instanceof MaterialAddressError)
      throw new NodeWriteError("INVALID_EDIT", error.message);
    throw error;
  }
}

/** The Node id is fixed by the selected document. */
function assertReservedDocsWriteFields(frontmatter: Record<string, unknown>): void {
  if (!("id" in frontmatter)) return;
  throw new NodeWriteError("INVALID_EDIT", "node.write cannot set the Node id.", {
    fields: ["id"],
  });
}

/** Raw write may keep the existing id but cannot change it. */
function assertRawDocsWriteReserved(
  disk: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  if (isDeepStrictEqual(next.id, disk.id)) return;
  throw new NodeWriteError("INVALID_EDIT", "node.write cannot change the Node id.", {
    fields: ["id"],
  });
}
