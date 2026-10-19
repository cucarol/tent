import { readOnlyFs, type FsAdapter } from "../store/adapter.js";
import { parseFrontmatter } from "../base/frontmatter.js";
import { documentVersionSchema, type DocumentVersion } from "../store/git-history.js";
import { materialLocator, isDirectoryMaterial, type MaterialSource } from "../base/material.js";
import { systemMaterialPath } from "./material-target.js";
import { loadNodeCatalog } from "./node-catalog.js";
import { isRequirementNode, isOutputNode } from "./node-sync-record.js";
import { documentLifecycle } from "../base/document-status.js";
import { nodeIsStale, nodeVerifications, okfTimestampSchema } from "../base/node-provenance.js";
import { cardRecordPath } from "../base/paths.js";
import { parseRoleDocument } from "../store/role-document.js";
import { canonicalIdentityError } from "../store/tree.js";

export type CardSourceInput = { cardId: string; sources: readonly MaterialSource[] };

/** A pinned Node or Role must still pass its own identity rules; null when it does. */
export function cardSourceIdentityError(
  path: string,
  raw: string,
  data: Record<string, unknown>,
): string | null {
  if (path.startsWith("roles/")) {
    try {
      parseRoleDocument(path.slice(6, -3), raw);
      return null;
    } catch {
      return "Selected Role is invalid";
    }
  }
  return canonicalIdentityError(data) ?? null;
}

/** Read only the versions pinned by these Cards, never replay document history. */
export async function readCardGoalIds(fs: FsAdapter, cards: readonly CardSourceInput[]) {
  const result = new Map(
    cards.map((card) => [card.cardId, { goalIds: new Set<string>(), diagnostics: [] as string[] }]),
  );
  const selected = cards.flatMap((card) =>
    card.sources.flatMap((source) => {
      if (!source.version) return [];
      const version = documentVersionSchema.safeParse(source.version);
      if (!version.success) {
        result.get(card.cardId)!.diagnostics.push(`Invalid source version: ${source.resource}`);
        return [];
      }
      return [{ cardId: card.cardId, source, version: version.data }];
    }),
  );
  if (!selected.length) return result;
  if (!fs.history || !(await fs.exists(".git"))) {
    for (const entry of selected)
      result.get(entry.cardId)!.diagnostics.push("Card source history unavailable");
    return result;
  }
  const key = (v: DocumentVersion) => `${v.commit}:${v.path}`;
  const versions = [
    ...new Map(selected.map((entry) => [key(entry.version), entry.version])).values(),
  ];
  const reads = await fs.history.readVersions(versions);
  const byVersion = new Map(versions.map((version, index) => [key(version), reads[index]!]));
  for (const entry of selected) {
    const target = result.get(entry.cardId)!;
    try {
      const locator = materialLocator(entry.source.resource, cardRecordPath(entry.cardId), true);
      if (
        isDirectoryMaterial(locator) ||
        systemMaterialPath(locator, fs.workspaceRoot) !== entry.version.path
      )
        throw new Error("Source address disagrees with its pinned version");
      const read = byVersion.get(key(entry.version))!;
      if (read instanceof Error) throw read;
      const data = read.frontmatter ?? parseFrontmatter(read.raw).data;
      const identityError = cardSourceIdentityError(entry.version.path, read.raw, data);
      if (identityError) throw new Error(identityError);
      if (isRequirementNode(data)) target.goalIds.add(data.id as string);
    } catch (error) {
      target.diagnostics.push(`Cannot read Card source ${entry.source.resource}: ${String(error)}`);
    }
  }
  return result;
}

function active(node: { archived: boolean; header: string }) {
  const status = documentLifecycle(parseFrontmatter(node.header).data).status;
  return !node.archived && (status === "draft" || status === "stable");
}

/** Activity is declared by the current output's own generated/verified timestamps. */
export async function readOutputActivity(fs: FsAdapter): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const now = new Date().toISOString();
  const catalog = await loadNodeCatalog(readOnlyFs(fs));
  const outputs = [...catalog.byId.values()].filter((node) => isOutputNode(node) && active(node));
  if (!outputs.length) return result;
  for (const node of outputs) {
    const data = parseFrontmatter(node.header).data;
    if (nodeIsStale(data, now)) continue;
    const times: string[] = [];
    const generated = data.generated as { at?: unknown } | undefined;
    const at = okfTimestampSchema.safeParse(generated?.at);
    if (at.success) times.push(at.data);
    try {
      times.push(...nodeVerifications(data).map((entry) => entry.at));
    } catch {
      /* Invalid provenance supplies no verification evidence. */
    }
    times.sort((a, b) => Date.parse(a) - Date.parse(b));
    if (times[0]) result.set(node.nodeId, new Date(times[0]).toISOString());
  }
  return result;
}
