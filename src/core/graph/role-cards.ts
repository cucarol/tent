import type { FsAdapter } from "../store/adapter.js";
import { parseCardDocument } from "./card-document.js";
import { documentLifecycle } from "../base/document-status.js";
import { isCardId } from "../base/id.js";
import { CARDS_DIR, cardRecordPath } from "../base/paths.js";

export class RoleCardsError extends Error {
  readonly code = "PENDING_CARDS";
  constructor(readonly details: { cardIds: string[] }) {
    super(
      `Role has unfinished Cards: ${details.cardIds.join(", ")}. Collect returned Cards, finish outstanding returns, move pending targets, or deprecate the Cards before retiring the Role.`,
    );
    this.name = "RoleCardsError";
  }
}

/** Called under the mutation lock before deleting or deprecating a Role. */
export async function assertRoleHasNoUnfinishedCards(fs: FsAdapter, roleId: string) {
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
      documentLifecycle(card.data).status !== "deprecated" &&
      ((card.data.state === "pending" && card.data.target === roleId) ||
        (card.data.state !== "closed" && card.data.returnTo === roleId) ||
        (card.data.state === "consumed" &&
          card.data.returnTo !== undefined &&
          card.data.receivedBy === roleId))
    )
      cardIds.push(id);
  }
  if (cardIds.length) throw new RoleCardsError({ cardIds: cardIds.sort() });
}
