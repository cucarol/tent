import { assertNodeFields } from "../base/node-fields.js";
import { isDeepStrictEqual } from "node:util";
import { parseFrontmatter } from "../base/frontmatter.js";
import { MaterialAddressError, validateMaterialAddresses } from "../base/material.js";
import { normalizeOptionalNodeType } from "../base/node-type.js";
import { normalizeTagList } from "../base/tags.js";
import { nodeNotePath } from "../base/paths.js";
import { assertStatusEdit } from "../base/document-status.js";

export class NodeWriteError extends Error {
  constructor(
    readonly code: "INVALID_EDIT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "NodeWriteError";
  }
}

/** Reject a Node file Tent should not save over the previous bytes. */
export function assertNodeEdit(nodePath: string, previousRaw: string, raw: string): void {
  const previous = parseFrontmatter(previousRaw);
  const next = parseFrontmatter(raw);
  // The Node id is the document identity and cannot be changed here.
  if (!isDeepStrictEqual(next.data.id, previous.data.id))
    throw new NodeWriteError("INVALID_EDIT", "A Node's id cannot change.");
  validateNodeMetadata(next.data);
  assertStatusEdit(previous.data, next.data);
  normalizeOptionalNodeType(next.data.type);
  if (next.data.tags !== undefined) normalizeTagList(next.data.tags);
  validateNodeMaterials(next.data, nodePath, previous.data);
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
