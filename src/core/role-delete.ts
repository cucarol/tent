import { withTentMutation, type FsAdapter } from "./adapter.js";
import { parseCardDocument } from "./card-document.js";
import { executeDeleteUnlocked } from "./delete-recovery.js";
import { captureDocumentUnlocked } from "./document-history.js";
import { documentLifecycle } from "./document-status.js";
import { contentEtag } from "./etag.js";
import { isCardId } from "./id.js";
import { CARDS_DIR, cardRecordPath } from "./paths.js";
import { readRoleDocument } from "./role-document.js";

export class RoleDeleteError extends Error {
  readonly code = "PENDING_CARDS";
  constructor(readonly details: { cardIds: string[] }) {
    super(
      `Role has pending Cards: ${details.cardIds.join(", ")}. Move or deprecate them before deleting it.`,
    );
    this.name = "RoleDeleteError";
  }
}

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
      const cardIds: string[] = [];
      for (const entry of (await fs.exists(CARDS_DIR)) ? await fs.listDir(CARDS_DIR) : []) {
        const id = entry.name.slice(0, -3);
        if (entry.isDir || !entry.name.endsWith(".md") || !isCardId(id)) continue;
        const raw = await fs.readFile(cardRecordPath(id));
        let card: ReturnType<typeof parseCardDocument>;
        try {
          card = parseCardDocument(id, raw);
        } catch {
          continue;
        }
        if (
          card.data.state === "pending" &&
          card.data.target === roleId &&
          documentLifecycle(card.data).status !== "deprecated"
        )
          cardIds.push(id);
      }
      if (cardIds.length) throw new RoleDeleteError({ cardIds: cardIds.sort() });
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
