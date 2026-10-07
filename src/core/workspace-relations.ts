import path from "node:path";
import { readOnlyFs, type FsAdapter } from "./adapter.js";
import { loadTent } from "./tree.js";
import { buildNodeIndex } from "./okf-index.js";
import { extractOutLinksDetailed, extractNodeMentions, resolveOutLink } from "../markdown/links.js";
import { resolveTargetPath } from "./link-target.js";
import {
  materialFields,
  materialLocator,
  resolvedMaterialOccurrences,
  type MaterialSource,
} from "./material.js";
import { parseFrontmatter } from "./frontmatter.js";
import { parseRoleDocument } from "./role-document.js";
import { parseCardDocument, verifyCardSourceVersions } from "./card-document.js";
import { isCardId, isRoleId } from "./id.js";
import { CARDS_DIR, ROLES_DIR, nodeNotePath } from "./paths.js";
import type { DocumentVersion } from "./git-history.js";
import { contentEtag } from "./etag.js";

export type DocumentRef = { kind: "node" | "role" | "card"; id: string };
export type WorkspaceRelation = {
  from: DocumentRef;
  fromEtag: string;
  via: "link" | "mention" | "resource" | "sources";
  raw: string;
  target:
    | DocumentRef
    | { kind: "file"; workspacePath: string }
    | { kind: "uri"; uri: string }
    | { kind: "unresolved" }
    | { kind: "invalid"; error: string };
  label?: string;
  range?: { start: number; end: number };
  index?: number;
  title?: string;
  version?: DocumentVersion;
  changedSince?: boolean;
};

/** One live document load. Discovery does not capture, receive Cards, or repair documents. */
export async function listWorkspaceRelations(fs: FsAdapter): Promise<WorkspaceRelation[]> {
  const readonlyFs = readOnlyFs(fs);
  const tent = await loadTent(readonlyFs);
  const nodes = [...tent.byPath.values()].filter((n) => !n.invalid);
  const index = buildNodeIndex(nodes);
  const documents = nodes.map((node) => ({
    ref: { kind: "node", id: node.id } as DocumentRef,
    path: nodeNotePath(node.path),
    data: node.fm as Record<string, unknown>,
    body: node.body,
    etag: node.etag,
  }));
  for (const [directory, kind] of [
    [ROLES_DIR, "role"],
    [CARDS_DIR, "card"],
  ] as const) {
    if (!(await readonlyFs.exists(directory))) continue;
    const entries = (await readonlyFs.listDir(directory))
      .filter(
        (entry) =>
          !entry.isDir &&
          entry.name.endsWith(".md") &&
          (kind === "role" ? isRoleId(entry.name.slice(0, -3)) : isCardId(entry.name.slice(0, -3))),
      )
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (let start = 0; start < entries.length; start += 8) {
      const batch = await Promise.all(
        entries.slice(start, start + 8).map(async (entry) => {
          const id = entry.name.slice(0, -3);
          const file = `${directory}/${entry.name}`;
          const bytes = await readonlyFs.readBinary(file);
          // I/O failures above stay visible; malformed unrelated identity documents are not edges.
          try {
            const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            if (kind === "role") parseRoleDocument(id, raw);
            else parseCardDocument(id, raw);
            const parsed = parseFrontmatter(raw);
            materialFields(parsed.data);
            return {
              ref: { kind, id },
              path: file,
              data: parsed.data,
              body: parsed.body,
              etag: contentEtag(raw),
            };
          } catch {
            return undefined;
          }
        }),
      );
      documents.push(...batch.filter((document) => document !== undefined));
    }
  }
  const byPath = new Map(documents.map((d) => [d.path, d.ref]));
  function locatorTarget(locator: ReturnType<typeof materialLocator>): WorkspaceRelation["target"] {
    if (locator.kind === "unresolved") return { kind: "unresolved" };
    if (locator.kind === "uri") return { kind: "uri", uri: locator.uri };
    return (
      byPath.get(locator.target) ?? {
        kind: "file",
        workspacePath: path.posix.normalize(`.tent/${locator.target}`),
      }
    );
  }
  const relations: WorkspaceRelation[] = [];
  const knownIds = new Set(nodes.map((node) => node.id));
  const pinned: Array<{
    relation: WorkspaceRelation;
    owner: string;
    source: MaterialSource;
  }> = [];
  for (const document of documents) {
    const fields = materialFields(document.data);
    for (const occurrence of resolvedMaterialOccurrences(document.data, document.path)) {
      const source =
        occurrence.index === undefined ? undefined : fields.sources?.[occurrence.index];
      const relation: WorkspaceRelation = {
        from: document.ref,
        fromEtag: document.etag,
        via: occurrence.field,
        raw: occurrence.resource,
        target: occurrence.error
          ? { kind: "invalid", error: occurrence.error }
          : locatorTarget(occurrence.locator!),
        ...(occurrence.index === undefined ? {} : { index: occurrence.index }),
        ...(typeof source?.title === "string" ? { title: source.title } : {}),
      };
      if (document.ref.kind === "card" && source?.version !== undefined) {
        pinned.push({ relation, owner: document.path, source });
      }
      relations.push(relation);
    }
    for (const link of extractOutLinksDetailed(document.body, true)) {
      const resolved = resolveOutLink(index, link, document.path);
      let target: WorkspaceRelation["target"] = { kind: "unresolved" };
      if (resolved.targetNodeId) target = { kind: "node", id: resolved.targetNodeId };
      else if (link.kind === "artifact") target = { kind: "uri", uri: link.raw };
      else {
        const normalized = resolveTargetPath(link.raw, document.path);
        const identity = byPath.get(normalized) ?? byPath.get(`${normalized}.md`);
        if (identity) target = identity;
        else if (/^(?:\.{1,2}\/|\/)/.test(link.raw)) {
          try {
            target = locatorTarget(materialLocator(link.raw, document.path));
          } catch (error) {
            target = {
              kind: "invalid",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
      relations.push({
        from: document.ref,
        fromEtag: document.etag,
        via: "link",
        raw: link.raw,
        target,
        ...(link.label === undefined ? {} : { label: link.label }),
        ...(link.range ? { range: { start: link.range.start, end: link.range.end } } : {}),
      });
    }
    for (const mention of extractNodeMentions(document.body, knownIds, document.ref.id)) {
      relations.push({
        from: document.ref,
        fromEtag: document.etag,
        via: "mention",
        raw: mention.targetNodeId,
        target: { kind: "node", id: mention.targetNodeId },
        range: { start: mention.range.start, end: mention.range.end },
      });
    }
  }
  const retained = await verifyCardSourceVersions(readonlyFs, pinned);
  for (const [i, { relation }] of pinned.entries()) {
    const value = retained[i]!;
    if (value instanceof Error) relation.target = { kind: "invalid", error: value.message };
    else {
      relation.target = {
        kind: value.version.path.startsWith(ROLES_DIR + "/") ? "role" : "node",
        id: String(parseFrontmatter(value.raw).data.id),
      };
      relation.version = value.version;
      relation.changedSince = value.changedSince;
    }
  }
  return relations;
}
