import type { FsAdapter } from "./adapter.js";
import { contentEtag } from "./etag.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isRoleId } from "./id.js";
import { roleDocumentPath } from "./paths.js";

export type RoleDocument = {
  version?: import("./git-history.js").DocumentVersion;
  path: string;
  roleId: string;
  title?: string;
  raw: string;
  body: string;
  etag: string;
};

export class RoleDocumentError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_ROLE_ID" | "INVALID_DOCUMENT",
  ) {
    super(message);
    this.name = "RoleDocumentError";
  }
}

/** Read a current Role document without manufacturing missing context. */
export async function readRoleDocument(fs: FsAdapter, roleId: string): Promise<RoleDocument> {
  assertRoleId(roleId);
  const path = roleDocumentPath(roleId);
  if (!(await fs.exists(path))) throw new Error(`Role not found: ${roleId}`);
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    await fs.readBinary(path),
  );
  return parseRoleDocument(roleId, raw);
}

/** Parse the exact observed document bytes. */
export function parseRoleDocument(roleId: string, raw: string): RoleDocument {
  assertRoleId(roleId);
  const path = roleDocumentPath(roleId);
  const body = validateRaw(roleId, path, raw);
  const data = parseFrontmatter(raw).data;
  return {
    path,
    roleId,
    title: typeof data.title === "string" ? data.title : roleId,
    raw,
    body,
    etag: contentEtag(raw),
  };
}

function assertRoleId(roleId: string): void {
  if (typeof roleId !== "string" || !isRoleId(roleId)) {
    throw new RoleDocumentError(`Invalid Role id: ${String(roleId)}.`, "INVALID_ROLE_ID");
  }
}

function validateRaw(roleId: string, path: string, raw: string): string {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    throw new RoleDocumentError(
      `Invalid Role document: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_DOCUMENT",
    );
  }
  if (new Set(parsed.keyOrder).size !== parsed.keyOrder.length) {
    throw new RoleDocumentError(
      `Role document contains duplicate fields: ${path}.`,
      "INVALID_DOCUMENT",
    );
  }
  if (parsed.data.type !== "role") {
    throw new RoleDocumentError(`Role document type must be 'role': ${path}.`, "INVALID_DOCUMENT");
  }
  if (parsed.data.id !== roleId) {
    throw new RoleDocumentError(
      `Role document identity/path mismatch: ${path}.`,
      "INVALID_DOCUMENT",
    );
  }
  return parsed.body;
}
