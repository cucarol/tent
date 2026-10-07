import { isDeepStrictEqual } from "node:util";
import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { isRoleId, makeUniqueRoleId } from "./id.js";
import { ROLES_DIR, roleDocumentPath } from "./paths.js";
import { readRoleDocument, parseRoleDocument, type RoleDocument } from "./role-document.js";
import { captureDocumentUnlocked, captureReadDocument } from "./document-history.js";
import { assertStatusEdit, documentLifecycle } from "./document-status.js";
import { boundary, ReaderError, type ReaderRange } from "./context-reader.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { canonicalDocumentReferences } from "./document-links.js";

export async function requireRoleDocument(fs: FsAdapter, roleId: string): Promise<RoleDocument> {
  return readRoleDocument(fs, roleId);
}

/** Selected reads never import a Node, repair files, or resume a pending mutation. */
export async function readRoleContext(
  fs: FsAdapter,
  roleId: string,
  options: { capture?: boolean } = {},
): Promise<RoleDocument> {
  const document = await requireRoleDocument(fs, roleId);
  const version = options.capture
    ? await captureReadDocument(fs, document.path, document.raw)
    : undefined;
  return { ...document, ...(version ? { version } : {}) };
}

/** Metadata discovery reads only Role headers; malformed entries remain visible as diagnostics. */
export async function roleSummaries(fs: FsAdapter) {
  const roles: Array<{
    roleId: string;
    path: string;
    title?: string;
    status?: ReturnType<typeof documentLifecycle>["status"];
    statusDiagnostic?: string;
    diagnostic?: string;
  }> = [];
  if (!(await fs.exists(ROLES_DIR))) return roles;
  for (const entry of (await fs.listDir(ROLES_DIR)).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const roleId = entry.name.slice(0, -3);
    if (entry.isDir || !entry.name.endsWith(".md") || !isRoleId(roleId)) continue;
    const path = roleDocumentPath(roleId);
    let raw: string;
    try {
      raw = fs.readFrontmatter ? await fs.readFrontmatter(path) : await fs.readFile(path);
    } catch (error) {
      roles.push({ roleId, path, diagnostic: `Role file is unreadable: ${shortCause(error)}.` });
      continue;
    }
    try {
      const document = parseRoleDocument(roleId, raw);
      const title = document.title ?? roleId;
      roles.push({ roleId, path, title, ...documentLifecycle(parseFrontmatter(raw).data) });
    } catch (error) {
      roles.push({
        roleId,
        path,
        diagnostic: `Role header is invalid: ${shortCause(error)}; inspect the original file.`,
      });
    }
  }
  return roles;
}

function shortCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [...(message.split(/\r?\n/)[0] ?? "").replace(/\.$/, "")].slice(0, 200).join("");
}

export async function listRoleContexts(fs: FsAdapter) {
  const roles = await roleSummaries(fs),
    revision = canonicalSha256(roles);
  return { revision, items: roles };
}

/** A continuation carries an exact ETag and UTF-16 range, usable across CLI processes. */
export async function readRolePage(
  fs: FsAdapter,
  roleId: string,
  options: {
    view?: "body" | "raw";
    range?: ReaderRange;
    expectedEtag?: string;
    capture?: boolean;
  } = {},
) {
  const document = await requireRoleDocument(fs, roleId);
  const view = options.view ?? "body",
    text = view === "raw" ? document.raw : document.body;
  const lifecycle = documentLifecycle(parseFrontmatter(document.raw).data);
  const range = options.range ?? { unit: "utf16" as const, start: 0, end: text.length };
  if (
    range.unit !== "utf16" ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > text.length ||
    boundary(text, range.start) !== range.start ||
    boundary(text, range.end) !== range.end
  )
    throw new ReaderError("INVALID_RANGE", "Role range must preserve UTF-16 and CRLF boundaries");
  if (options.expectedEtag && options.expectedEtag !== document.etag)
    throw new ReaderError("SOURCE_CHANGED", "Role changed; reread before continuing");
  const result = {
    roleId,
    path: document.path,
    etag: document.etag,
    view,
    ...lifecycle,
    text: text.slice(range.start, range.end),
    range,
    total: text.length,
  };
  const version = options.capture
    ? await captureReadDocument(fs, document.path, document.raw)
    : undefined;
  return { ...result, ...(version ? { version } : {}) };
}

export function createRoleContext(
  fs: FsAdapter,
  input: { roleId?: string; title: string; body?: string },
) {
  return withTentMutation(
    fs,
    async () => {
      if (
        typeof input.title !== "string" ||
        !input.title.trim() ||
        (input.body !== undefined && typeof input.body !== "string")
      )
        throw new Error("Role requires a title and a text body");
      const used = new Set((await roleSummaries(fs)).map((role) => role.roleId));
      const roleId = input.roleId ?? makeUniqueRoleId(used);
      if (!isRoleId(roleId) || used.has(roleId))
        throw new Error("Role id is invalid or already exists");
      if (
        fs.history &&
        (await fs.history.available()) &&
        (await fs.history.pathVersions(roleDocumentPath(roleId))).first
      ) {
        throw new Error("Role id already exists in history; create a new identity");
      }
      const fields = { type: "role", id: roleId, title: input.title };
      const body = await canonicalDocumentReferences(
        fs,
        roleDocumentPath(roleId),
        fields,
        input.body ?? "",
      );
      const raw = serializeFrontmatter(fields, body, ["type", "id", "title"]);
      return saveRole(fs, roleId, raw, true, "role.create");
    },
    { operation: "role.create" },
  );
}

export type RoleEdit = {
  baseEtag: string;
  raw?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
};
export function editRoleContext(fs: FsAdapter, roleId: string, input: RoleEdit) {
  return withTentMutation(
    fs,
    async () => {
      const current = await requireRoleDocument(fs, roleId);
      if (!input.baseEtag || current.etag !== input.baseEtag)
        throw new Error(
          "Role context changed or baseEtag missing; reread and reconcile your draft",
        );
      if (input.raw !== undefined && (input.body !== undefined || input.frontmatter !== undefined))
        throw new Error("Supply raw or body/frontmatter, not both");
      if (
        (input.raw !== undefined && typeof input.raw !== "string") ||
        (input.body !== undefined && typeof input.body !== "string")
      )
        throw new Error("Role content must be text");
      const before = parseFrontmatter(current.raw);
      const fields = { ...before.data, ...input.frontmatter };
      const body = input.body ?? before.body;
      const draft =
        input.raw ??
        (isDeepStrictEqual(fields, before.data) && body === before.body
          ? current.raw
          : serializeFrontmatter(fields, body, before.keyOrder));
      const parsed = parseFrontmatter(draft);
      const canonicalFields = { ...parsed.data };
      const canonicalBody = await canonicalDocumentReferences(
        fs,
        current.path,
        canonicalFields,
        parsed.body,
      );
      const raw =
        isDeepStrictEqual(canonicalFields, parsed.data) && canonicalBody === parsed.body
          ? draft
          : serializeFrontmatter(canonicalFields, canonicalBody, parsed.keyOrder);
      parseRoleDocument(roleId, raw);
      const after = parseFrontmatter(raw).data;
      assertStatusEdit(before.data, after);
      if ((await fs.readFile(current.path)) !== current.raw)
        throw new Error(
          "Role context changed while resolving references; reread and reconcile your draft",
        );
      return saveRole(fs, roleId, raw, raw !== current.raw, "role.write");
    },
    { operation: "role.write" },
  );
}

export function writeRoleContext(fs: FsAdapter, roleId: string, body: string, baseEtag: string) {
  return editRoleContext(fs, roleId, { body, baseEtag });
}

async function saveRole(
  fs: FsAdapter,
  roleId: string,
  raw: string,
  changed: boolean,
  operation: string,
) {
  const document = parseRoleDocument(roleId, raw);
  if (changed) await fs.writeFile(document.path, raw);
  const version = await captureDocumentUnlocked(fs, document.path, raw, { operation }).catch(
    (error) => {
      throw new Error(
        `Role may already be saved, but Git capture failed; reread before retrying: ${String(error)}`,
      );
    },
  );
  return {
    roleId,
    path: document.path,
    etag: document.etag,
    changed,
    ...(version ? { version } : {}),
  };
}
