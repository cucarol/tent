import { assertRoleHasNoUnfinishedCards } from "../graph/role-cards.js";
import { withTentMutation, type FsAdapter } from "../store/adapter.js";
import { executeDeleteUnlocked } from "../store/delete-recovery.js";
import { captureDocumentUnlocked } from "../store/document-history.js";
import { contentEtag } from "../base/etag.js";
import { readRoleDocument } from "../store/role-document.js";

function checkEtag(current: string, baseEtag: string) {
  if (!baseEtag || current !== baseEtag)
    throw new Error("Role context changed or baseEtag missing; reread and reconcile your draft");
}

/** Remove only the Role document; reception and pinned source facts remain historical. */
export async function deleteRole(fs: FsAdapter, roleId: string, input: { baseEtag: string }) {
  if (!input.baseEtag) checkEtag("", input.baseEtag);
  return withTentMutation(
    fs,
    async (recovered) => {
      if (recovered?.kind === "role" && recovered.id === roleId) {
        checkEtag(contentEtag(recovered.raw), input.baseEtag);
        return { roleId, path: recovered.source };
      }
      const role = await readRoleDocument(fs, roleId);
      checkEtag(role.etag, input.baseEtag);
      await assertRoleHasNoUnfinishedCards(fs, roleId);
      if ((await fs.readFile(role.path)) !== role.raw)
        throw new Error("Role context changed while checking Cards; reread before deleting");
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
