import {
  materialFields,
  resolvedMaterialOccurrences,
  materialLocator,
  materialIdentity,
  isDirectoryMaterial,
  resourceSchema,
  type MaterialFields,
} from "./material.js";
import * as z from "zod/v4";
import { nodeReadRevisionEtag } from "./node-read-basis.js";
import { canonicalSha256 } from "./canonical-digest.js";
import { parseFrontmatter } from "./frontmatter.js";
import { buildOkfNodeIndex } from "./okf-index.js";
import { nodeNotePath } from "./paths.js";
import { documentVersionSchema, type DocumentVersion } from "./git-history.js";
import { extractOutLinksDetailed, extractNodeMentions, resolveOutLink } from "../markdown/links.js";
import { documentLifecycle } from "./document-status.js";
import type { WorkspaceRelation, DocumentRef } from "./workspace-relations.js";

export type ReaderSource =
  | { kind: "live"; workspaceId: string }
  | { kind: "git"; workspaceId: string; version: DocumentVersion };
export type ReaderDocument = {
  nodeId: string;
  name: string;
  path: string;
  type?: string;
  etag: string;
  raw: string;
  archived: boolean;
  invalid: boolean;
  parentNodeId: string | null;
  childNodeIds: string[];
};

/** Deprecated ancestors remain navigable when they contain current descendants. */
export function navigationIds(
  documents: Iterable<Pick<ReaderDocument, "nodeId" | "parentNodeId" | "archived">>,
) {
  const byId = new Map([...documents].map((n) => [n.nodeId, n])),
    visible = new Set<string>();
  for (const node of byId.values()) {
    if (node.archived) continue;
    let current: typeof node | undefined = node;
    while (current && !visible.has(current.nodeId)) {
      visible.add(current.nodeId);
      current = current.parentNodeId ? byId.get(current.parentNodeId) : undefined;
    }
  }
  return visible;
}
export const readerRangeSchema = z.strictObject({
  unit: z.literal("utf16"),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type ReaderRange = z.infer<typeof readerRangeSchema>;
export const readerSearchSchema = z
  .strictObject({
    query: z.string().trim().min(1).optional(),
    resource: resourceSchema.optional(),
    includeArchived: z.boolean().optional(),
  })
  .refine(
    (p) => [p.query, p.resource].filter((value) => value !== undefined).length === 1,
    "Supply exactly one query or resource",
  );
export const readerReadSchema = z
  .strictObject({
    nodeId: z.string().min(1),
    view: z.enum(["summary", "body", "raw"]).optional(),
    version: documentVersionSchema.optional(),
    range: readerRangeSchema.optional(),
    expectedEtag: z.string().optional(),
    capture: z.boolean().optional(),
  })
  .refine(
    (p) => p.view !== "summary" || (p.expectedEtag === undefined && !p.range),
    "summary has no full-document ETag or text range; read body/raw instead",
  );
export const readerRelationsSchema = z
  .strictObject({
    nodeId: z.string().min(1).nullable(),
    direction: z.enum(["parent", "children", "outgoing", "incoming"]),
    includeArchived: z.boolean().optional(),
  })
  .refine(
    (p) => p.nodeId !== null || p.direction === "children",
    "Only children supports the Workspace root",
  );
export const readerListSchema = z.strictObject({
  parentNodeId: z.string().nullable().optional(),
  includeArchived: z.boolean().optional(),
});
export type ReaderSearch = z.infer<typeof readerSearchSchema>;
export type ReaderRead = z.infer<typeof readerReadSchema>;
export type ReaderRelations = z.infer<typeof readerRelationsSchema>;

export class ReaderError extends Error {
  constructor(
    readonly code:
      "INVALID_INPUT" | "SOURCE_CHANGED" | "NOT_FOUND" | "INVALID_RANGE" | "UNSUPPORTED_MATCH",
    message: string,
  ) {
    super(message);
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function boundary(text: string, end: number): number {
  if (
    end > 0 &&
    end < text.length &&
    ((/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) ||
      (text[end - 1] === "\r" && text[end] === "\n"))
  )
    return end - 1;
  return end;
}
const range = (start: number, end: number): ReaderRange => ({ unit: "utf16", start, end });
export function nodeSummary(d: {
  nodeId: string;
  name: string;
  type?: string;
  tags: string[];
  description?: string;
}) {
  return { nodeId: d.nodeId, name: d.name, type: d.type, tags: d.tags, description: d.description };
}

export function readerResult<T>(
  source: ReaderSource,
  revision: string,
  input: Record<string, unknown>,
  items: T[],
) {
  return { source, revision, scope: input, items };
}
type Term = { value: string; start: number; end: number; weight: number };
function terms(text: string): Term[] {
  const result: Term[] = [];
  for (const m of text.matchAll(/\p{Script=Han}+|[\p{L}\p{N}_$]+/gu)) {
    const value = m[0];
    const start = m.index;
    const add = (part: string, at: number, weight: number) =>
      result.push({
        value: part.normalize("NFKC").toLowerCase(),
        start: at,
        end: at + part.length,
        weight,
      });
    if (/^\p{Script=Han}+$/u.test(value)) {
      add(value, start, 3);
      const chars = [...value];
      let at = start;
      chars.forEach((char, i) => {
        add(char, at, 0.15);
        if (chars[i + 1]) add(char + chars[i + 1], at, 1);
        at += char.length;
      });
    } else {
      add(value, start, 2);
      for (const part of value.matchAll(/[A-Z]+(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|\d+/g))
        if (part[0] !== value) add(part[0], start + part.index, 1);
    }
  }
  return result;
}
function snippet(text: string, matches: Term[], query: Map<string, number>) {
  // 两组重叠的定长窗口，每个命中只参与两次评分，避免重复词造成平方级扫描。
  const windows = new Map<number, Set<string>>();
  for (const term of matches) {
    const bucket = Math.floor(term.start / 96) * 96;
    for (const at of [bucket - 96, bucket]) {
      if (at < 0 || term.end > at + 192) continue;
      const covered = windows.get(at) ?? new Set<string>();
      covered.add(term.value);
      windows.set(at, covered);
    }
  }
  let start = matches[0]!.start,
    score = 0;
  for (const [at, covered] of windows) {
    const candidate = [...covered].reduce((sum, term) => sum + query.get(term)!, 0);
    if (candidate > score || (candidate === score && at < start)) {
      start = at;
      score = candidate;
    }
  }
  start = boundary(text, start);
  const end = boundary(text, Math.min(text.length, start + 192));
  return { score, range: range(start, end), text: text.slice(start, end) };
}
type MaterializedDocument = ReaderDocument & {
  lifecycle: ReturnType<typeof documentLifecycle>;
  body: string;
  materials?: MaterialFields;
  materialOccurrences: ReturnType<typeof resolvedMaterialOccurrences>;
  tags: string[];
  description?: string;
};

/** Query a materialized observation; CLI pagination never changes this data. */
export class ContextReader {
  readonly revision: string;
  private readonly documents: MaterializedDocument[];
  private readonly byId: Map<string, MaterializedDocument>;
  constructor(
    readonly source: ReaderSource,
    documents: ReaderDocument[],
    readonly rootNodeIds: string[],
    private readonly workspaceRelations?: WorkspaceRelation[],
  ) {
    this.documents = documents.map((d) => {
      const {
        body,
        data,
      }: Pick<ReturnType<typeof parseFrontmatter>, "body" | "data"> = d.invalid
        ? { body: "", data: {} }
        : parseFrontmatter(d.raw);
      let materials: MaterialFields | undefined;
      try {
        materials = materialFields(data);
      } catch {
        /* Historical raw remains readable even with nonstandard metadata. */
      }
      return {
        ...d,
        lifecycle: documentLifecycle(data),
        type: typeof data.type === "string" ? data.type : d.type,
        body,
        materials,
        materialOccurrences: materials
          ? resolvedMaterialOccurrences(materials, nodeNotePath(d.path))
          : [],
        tags: Array.isArray(data.tags)
          ? data.tags.filter((t): t is string => typeof t === "string")
          : [],
        description: typeof data.description === "string" ? data.description : undefined,
      };
    });
    this.byId = new Map(this.documents.filter((d) => !d.invalid).map((d) => [d.nodeId, d]));
    this.revision = canonicalSha256({
      source,
      rootNodeIds,
      documents: this.documents.map(
        ({ nodeId, etag, path, parentNodeId, childNodeIds, archived, invalid }) => ({
          nodeId,
          etag,
          path,
          parentNodeId,
          childNodeIds,
          archived,
          invalid,
        }),
      ),
      ...(workspaceRelations ? { relations: workspaceRelations } : {}),
    });
  }
  private document(id: string): MaterializedDocument {
    const d = this.byId.get(id);
    if (!d) throw new ReaderError("NOT_FOUND", `Node is not readable in this source: ${id}`);
    return d;
  }
  /** Exact selected descriptor for history capture after a successful body/raw delivery. */
  documentBytes(nodeId: string) {
    const d = this.document(nodeId);
    return { path: nodeNotePath(d.path), raw: d.raw };
  }
  private summary(d: MaterializedDocument) {
    return { ...nodeSummary(d), ...d.lifecycle };
  }
  private result<T>(input: Record<string, unknown>, items: T[]) {
    return readerResult(this.source, this.revision, input, items);
  }
  read(input: ReaderRead, capturedVersion?: DocumentVersion) {
    const p = readerReadSchema.parse(input);
    const d = this.document(p.nodeId);
    const view = p.view ?? "body";
    if (
      p.version &&
      (this.source.kind !== "git" ||
        p.version.commit !== this.source.version.commit ||
        p.version.path !== this.source.version.path)
    )
      throw new ReaderError(
        "SOURCE_CHANGED",
        "Requested Git version differs from this reader source",
      );
    if (p.expectedEtag !== undefined && nodeReadRevisionEtag(p.expectedEtag) !== d.etag)
      throw new ReaderError("SOURCE_CHANGED", "Node ETag changed; reread before using offsets");
    if (view === "summary") {
      if (p.range) throw new ReaderError("INVALID_RANGE", "summary has no text range");
      return { source: this.source, ...this.summary(d), view, archived: d.archived };
    }
    const text = view === "raw" ? d.raw : d.body;
    const requested = p.range ?? range(0, text.length);
    if (
      requested.end < requested.start ||
      requested.end > text.length ||
      boundary(text, requested.start) !== requested.start ||
      boundary(text, requested.end) !== requested.end
    )
      throw new ReaderError(
        "INVALID_RANGE",
        "Range must fit the source and preserve UTF-16/CRLF boundaries",
      );
    return {
      source: this.source,
      ...(capturedVersion ? { version: capturedVersion } : {}),
      ...this.summary(d),
      etag: d.etag,
      view,
      path: d.path,
      requestedRange: requested,
      range: requested,
      viewLength: text.length,
      text: text.slice(requested.start, requested.end),
      partial: requested.start !== 0 || requested.end !== text.length,
      ...(view === "body" && d.materials ? structuredClone(d.materials) : {}),
    };
  }
  search(input: ReaderSearch) {
    const p = readerSearchSchema.parse(input);
    // A search has no declaring Node: explicit relative addresses start at .tent.
    const material =
      p.resource === undefined
        ? undefined
        : materialIdentity(materialLocator(p.resource, ".search.md", true));
    if (p.resource !== undefined && material === undefined)
      throw new Error("Exact material search requires an explicit path or URI");
    const query = new Map(terms(p.query ?? "").map((t) => [t.value, t.weight]));
    const hits: Array<{
      doc: MaterializedDocument;
      score: number;
      match: Record<string, unknown>;
    }> = [];
    for (const d of this.documents) {
      if (d.invalid || ((d.archived || d.lifecycle.status === null) && !p.includeArchived))
        continue;
      if (material !== undefined) {
        const occurrence = d.materialOccurrences.find(
          (item) => item.locator && materialIdentity(item.locator) === material,
        );
        if (occurrence)
          hits.push({
            doc: d,
            score: 1,
            match: {
              field: occurrence.field,
              index: occurrence.index,
              relation: "same-resource",
              resource: occurrence.resource,
              read: { nodeId: d.nodeId, view: "raw", expectedEtag: d.etag },
            },
          });
        continue;
      }
      const materialText: Array<{ field: string; value: string; index?: number; part?: string }> = [
        ...(d.materials?.resource === undefined
          ? []
          : [{ field: "resource", value: d.materials.resource }]),
        ...(d.materials?.sources ?? []).flatMap((source, index) => [
          { field: "sources", index, part: "resource", value: source.resource },
          ...(typeof source.title === "string"
            ? [{ field: "sources", index, part: "title", value: source.title }]
            : []),
        ]),
      ];
      const fields = [
        { field: "body", value: d.body },
        { field: "name", value: d.name },
        { field: "description", value: d.description ?? "" },
        { field: "path", value: d.path },
        { field: "type", value: d.type ?? "" },
        { field: "tags", value: d.tags.join(" ") },
        ...materialText,
      ];
      let best: { score: number; match: Record<string, unknown> } | undefined;
      const covered = new Map<string, number>();
      for (const f of fields) {
        const matches = terms(f.value).filter((t) => query.has(t.value));
        if (!matches.length) continue;
        for (const t of matches) covered.set(t.value, query.get(t.value)!);
        const excerpt = snippet(f.value, matches, query);
        const score =
          f.field === "body"
            ? excerpt.score
            : [...new Set(matches.map((t) => t.value))].reduce((sum, t) => sum + query.get(t)!, 0);
        const match =
          f.field === "body"
            ? { field: f.field, range: excerpt.range, text: excerpt.text }
            : {
                field: f.field,
                ...("index" in f ? { index: f.index, part: f.part } : {}),
                value: f.value,
              };
        if (!best || score > best.score) best = { score, match };
      }
      if (best)
        hits.push({
          doc: d,
          score: [...covered.values()].reduce((a, b) => a + b, 0),
          match: best.match,
        });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score || compare(a.doc.path, b.doc.path) || compare(a.doc.nodeId, b.doc.nodeId),
    );
    return this.result(
      { query: p.query, resource: p.resource, includeArchived: p.includeArchived ?? false },
      hits.map((h) => ({ ...this.summary(h.doc), etag: h.doc.etag, match: h.match })),
    );
  }
  list(input: z.infer<typeof readerListSchema> = {}) {
    const p = readerListSchema.parse(input);
    return this.relations({
      nodeId: p.parentNodeId ?? null,
      direction: "children",
      includeArchived: p.includeArchived,
    });
  }
  relations(input: ReaderRelations) {
    const p = readerRelationsSchema.parse(input);
    const d = p.nodeId === null ? undefined : this.document(p.nodeId);
    const items: Array<Record<string, unknown>> = [];
    if (p.direction === "parent" || p.direction === "children") {
      const ids =
        p.direction === "parent"
          ? d?.parentNodeId
            ? [d.parentNodeId]
            : []
          : d
            ? d.childNodeIds
            : this.rootNodeIds;
      const visible = navigationIds(this.byId.values());
      for (const id of ids) {
        const doc = this.byId.get(id);
        if (doc && (p.direction === "parent" || visible.has(id) || p.includeArchived))
          items.push(this.summary(doc));
      }
    } else if (this.workspaceRelations) {
      const refSummary = (ref: DocumentRef) => {
        const node = ref.kind === "node" ? this.byId.get(ref.id) : undefined;
        return node
          ? { ...this.summary(node), kind: ref.kind, id: ref.id, archived: node.archived }
          : { kind: ref.kind, id: ref.id, [`${ref.kind}Id`]: ref.id, name: ref.id };
      };
      for (const relation of this.workspaceRelations) {
        if (
          p.direction === "outgoing"
            ? relation.from.kind !== "node" || relation.from.id !== p.nodeId
            : relation.target.kind !== "node" || relation.target.id !== p.nodeId
        )
          continue;
        const from = relation.from.kind === "node" ? this.byId.get(relation.from.id) : undefined;
        if (p.direction === "incoming" && from?.archived && !p.includeArchived) continue;
        const { via, target, fromEtag, range: occurrenceRange, ...occurrence } = relation;
        if (from && from.etag !== fromEtag)
          throw new ReaderError(
            "SOURCE_CHANGED",
            "Node changed during relation observation; retry",
          );
        const bodyRange = occurrenceRange
          ? range(occurrenceRange.start, occurrenceRange.end)
          : undefined;
        const start =
          from && bodyRange ? boundary(from.body, Math.max(0, bodyRange.start - 64)) : 0;
        const end =
          from && bodyRange
            ? boundary(from.body, Math.min(from.body.length, bodyRange.end + 64, start + 256))
            : 0;
        items.push({
          ...occurrence,
          from: refSummary(relation.from),
          kind: via === "resource" || via === "sources" ? "material" : via,
          ...(via === "resource" || via === "sources"
            ? { field: via, resource: relation.raw }
            : {}),
          ...(bodyRange ? { range: bodyRange } : {}),
          ...(from && bodyRange
            ? { text: from.body.slice(start, end), textRange: range(start, end) }
            : {}),
          target:
            target.kind === "node" || target.kind === "role" || target.kind === "card"
              ? refSummary(target)
              : target,
          ...(target.kind === "unresolved" ? { unresolved: true } : {}),
          ...(target.kind === "invalid" ? { error: target.error } : {}),
          read: {
            [`${relation.from.kind}Id`]: relation.from.id,
            view: bodyRange ? "body" : "raw",
            expectedEtag: fromEtag,
            ...(bodyRange ? { range: bodyRange } : {}),
          },
        });
      }
    } else {
      const index = buildOkfNodeIndex(
        this.documents
          .filter((n) => !n.invalid)
          .map((n) => ({
            id: n.nodeId,
            nodeId: n.nodeId,
            path: n.path,
            notePath: nodeNotePath(n.path),
            name: n.name,
            type: n.type,
          })),
      );
      const documentsByPath = new Map(
        this.documents
          .filter((node) => !node.invalid)
          .map((node) => [nodeNotePath(node.path), node]),
      );
      const knownIds = new Set(this.byId.keys());
      for (const from of this.documents) {
        if (
          from.invalid ||
          (p.direction === "incoming"
            ? from.archived && !p.includeArchived
            : from.nodeId !== p.nodeId)
        )
          continue;
        for (const occurrence of from.materialOccurrences) {
          const target =
            occurrence.locator?.kind === "path" && !isDirectoryMaterial(occurrence.locator)
              ? documentsByPath.get(occurrence.locator.target)
              : undefined;
          if (p.direction === "incoming" && target?.nodeId !== p.nodeId) continue;
          items.push({
            from: this.summary(from),
            kind: "material",
            field: occurrence.field,
            index: occurrence.index,
            resource: occurrence.resource,
            ...(target ? { target: { ...this.summary(target), archived: target.archived } } : {}),
            ...(occurrence.error ? { error: occurrence.error } : {}),
            ...(occurrence.locator?.kind === "unresolved" ? { unresolved: true } : {}),
            read: { nodeId: from.nodeId, view: "raw", expectedEtag: from.etag },
          });
        }
        for (const link of extractOutLinksDetailed(from.body, true)) {
          const resolved = resolveOutLink(index, link, nodeNotePath(from.path));
          if (p.direction === "incoming" && resolved.targetNodeId !== p.nodeId) continue;
          if (!link.range) throw new Error("Link occurrence has no source range");
          const target = resolved.targetNodeId ? this.byId.get(resolved.targetNodeId) : undefined;
          const start = boundary(from.body, Math.max(0, link.range.start - 64));
          const end = boundary(
            from.body,
            Math.min(from.body.length, link.range.end + 64, start + 256),
          );
          items.push({
            from: this.summary(from),
            range: link.range,
            raw: link.raw,
            label: link.label,
            fragment: link.fragment,
            text: from.body.slice(start, end),
            textRange: range(start, end),
            read: { nodeId: from.nodeId, view: "body", expectedEtag: from.etag, range: link.range },
            ...(target
              ? { target: { ...this.summary(target), archived: target.archived } }
              : { unresolved: resolved.kind !== "artifact", kind: resolved.kind }),
          });
        }
        for (const mention of extractNodeMentions(from.body, knownIds, from.nodeId)) {
          if (p.direction === "incoming" && mention.targetNodeId !== p.nodeId) continue;
          const target = this.document(mention.targetNodeId);
          items.push({
            from: this.summary(from),
            kind: "mention",
            raw: mention.targetNodeId,
            range: mention.range,
            target: { ...this.summary(target), archived: target.archived },
            read: {
              nodeId: from.nodeId,
              view: "body",
              expectedEtag: from.etag,
              range: mention.range,
            },
          });
        }
      }
    }
    return this.result(
      { nodeId: p.nodeId, direction: p.direction, includeArchived: p.includeArchived ?? false },
      items,
    );
  }
}
