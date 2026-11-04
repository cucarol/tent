import { assertRoleHasNoUnfinishedCards } from "../graph/role-cards.js";
import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { readRoleDocument } from "../store/role-document.js";

/** Remove only the Role document; the Cards it took or returned keep their history. */
export async function deleteRole(fs: FsAdapter, roleId: string) {
  return withTentMutation(
    fs,
    async () => {
      const role = await readRoleDocument(fs, roleId);
      await assertRoleHasNoUnfinishedCards(fs, roleId);
      await fs.remove(role.path);
      return { roleId, path: role.path };
    },
    { operation: "role.delete" },
  );
}
