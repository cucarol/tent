import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { serializeFrontmatter } from "../base/frontmatter.js";
import { isRoleId, makeUniqueRoleId } from "../base/id.js";
import { ROLES_DIR, roleDocumentPath } from "../base/paths.js";
import { parseRoleDocument } from "../store/role-document.js";
import { captureDocumentUnlocked } from "../store/document-history.js";
import { canonicalDocumentReferences } from "../graph/document-links.js";

async function existingRoleIds(fs: FsAdapter) {
  if (!(await fs.exists(ROLES_DIR))) return new Set<string>();
  return new Set(
    (await fs.listDir(ROLES_DIR))
      .filter((entry) => !entry.isDir && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3))
      .filter(isRoleId),
  );
}

/** After creation a Role file is read and edited natively, like a Node. */
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
      const used = await existingRoleIds(fs);
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
      const document = parseRoleDocument(roleId, raw);
      await fs.writeFile(document.path, raw);
      const version = await captureDocumentUnlocked(fs, document.path, raw, {
        operation: "role.create",
      });
      return { roleId, path: document.path, ...(version ? { version } : {}) };
    },
    { operation: "role.create" },
  );
}
