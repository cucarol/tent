import { assertRoleHasNoUnfinishedCards } from "../graph/role-cards.js";
import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { executeDeleteUnlocked } from "../store/delete-recovery.js";
import { captureDocumentUnlocked } from "../store/document-history.js";
import { readRoleDocument } from "../store/role-document.js";

/** Remove only the Role document; the Cards it took or returned keep their history. */
export async function deleteRole(fs: FsAdapter, roleId: string) {
  return withTentMutation(
    fs,
    async (recovered) => {
      if (recovered?.kind === "role" && recovered.id === roleId)
        return { roleId, path: recovered.source };
      const role = await readRoleDocument(fs, roleId);
      await assertRoleHasNoUnfinishedCards(fs, roleId);
      if ((await fs.readFile(role.path)) !== role.raw)
        throw new Error("Role file changed while checking Cards; retry the delete");
      await captureDocumentUnlocked(fs, role.path, role.raw, {
        operation: "document.external-capture",
      });
      await executeDeleteUnlocked(fs, {
        kind: "role",
        id: roleId,
        source: role.path,
        raw: role.raw,
        writes: [],
      });
      return { roleId, path: role.path };
    },
    { operation: "role.delete" },
  );
}
