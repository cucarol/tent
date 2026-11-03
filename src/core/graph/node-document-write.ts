import { assertNodeFields } from "../base/node-fields.js";
export { assertNodeFields } from "../base/node-fields.js";
import { isDeepStrictEqual } from "node:util";
import { parseFrontmatter, serializeFrontmatter, syncNodeTitle } from "../base/frontmatter.js";
import { MaterialAddressError, validateMaterialAddresses } from "../base/material.js";
import { normalizeOptionalNodeType } from "../base/node-type.js";
import { normalizeTagList } from "../base/tags.js";
import type { Node } from "../base/types.js";
import { nodeNotePath } from "../base/paths.js";
import { assertStatusEdit } from "../base/document-status.js";

export class NodeWriteError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "INVALID_EDIT" | "NOT_FOUND",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NodeWriteError";
  }
}

export type NodeDocumentEdit = {
  raw?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
};

/** Prepare an edit of the observed bytes; the caller holds the mutation lock through saving. */
export function prepareNodeDocumentWrite(
  node: Pick<Node, "id" | "path">,
  diskRaw: string,
  input: NodeDocumentEdit,
): string {
  const { raw: rawInput, body, frontmatter } = input;

  let nextRaw: string;
  if (rawInput !== undefined) {
    const diskParsed = parseFrontmatter(diskRaw);
    const nextParsed = parseFrontmatter(rawInput);
    // The Node id is the document identity and cannot be changed here.
    assertRawDocsWriteReserved(diskParsed.data, nextParsed.data);
    validateNodeMetadata(nextParsed.data);
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

    if (body === undefined && (!frontmatter || Object.keys(frontmatter).length === 0)) {
      throw new NodeWriteError(
        "INVALID_INPUT",
        "node.write requires raw, body, and/or frontmatter",
      );
    }
    const current = parseFrontmatter(diskRaw);
    const merged = { ...current.data, ...frontmatter };
    validateNodeMetadata(merged);
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

function validateNodeMetadata(next: Record<string, unknown>) {
  try {
    assertNodeFields(next);
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
  throw new NodeWriteError("INVALID_EDIT", "A Node's id cannot change.", {
    fields: ["id"],
  });
}

/** Raw write may keep the existing id but cannot change it. */
function assertRawDocsWriteReserved(
  disk: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  if (isDeepStrictEqual(next.id, disk.id)) return;
  throw new NodeWriteError("INVALID_EDIT", "A Node's id cannot change.", {
    fields: ["id"],
  });
}
