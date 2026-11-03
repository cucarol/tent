import type { FsAdapter } from "../store/adapter.js";
import { parseCardDocument } from "./card-document.js";
import { documentLifecycle } from "../base/document-status.js";
import { isCardId } from "../base/id.js";
import { CARDS_DIR, cardRecordPath } from "../base/paths.js";

export class RoleCardsError extends Error {
  readonly code = "PENDING_CARDS";
  constructor(readonly details: { cardIds: string[] }) {
    super(
      `Role has unfinished Cards: ${details.cardIds.join(", ")}. Take or return each one, or cancel it with tent card deprecate <card-id>, then retry.`,
    );
    this.name = "RoleCardsError";
  }
}

/** Roles a live Card still waits on: to take it, return it, or read its result. */
export function rolesHoldingCard(data: Record<string, unknown>): string[] {
  if (documentLifecycle(data).status === "deprecated" || data.state === "closed") return [];
  const roles = [data.returnTo];
  if (data.state === "pending") roles.push(data.target);
  if (data.state === "consumed" && data.returnTo !== undefined) roles.push(data.receivedBy);
  return roles.filter((role): role is string => typeof role === "string");
}

/** Called under the mutation lock before deleting a Role. */
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
    if (rolesHoldingCard(card.data).includes(roleId)) cardIds.push(id);
  }
  if (cardIds.length) throw new RoleCardsError({ cardIds: cardIds.sort() });
}
