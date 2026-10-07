import * as z from "zod/v4";
import { canonicalSha256 } from "../core/canonical-digest.js";
import { boundary, ReaderError } from "../core/context-reader.js";
import { incompleteNodeReadEtag } from "../core/node-read-basis.js";

const nodeReadContainers = new Set([
  "node",
  "items",
  "readBack",
  "record",
  "page",
  "next",
  "read",
  "metadataRead",
  "match",
  "from",
  "target",
]);

/** Restrict exposed read bases without rewriting user metadata such as custom source fields. */
export function incompleteNodeRead<T>(value: T): T {
  if (Array.isArray(value)) return value.map(incompleteNodeRead) as T;
  if (!value || typeof value !== "object") return value;
  const nonNode = !("nodeId" in value) && ("roleId" in value || "cardId" in value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (key === "etag" || key === "expectedEtag" || key === "currentEtag") &&
      typeof item === "string" &&
      !nonNode
        ? incompleteNodeReadEtag(item)
        : nodeReadContainers.has(key)
          ? incompleteNodeRead(item)
          : item,
    ]),
  ) as T;
}

const bytes = 16 * 1024;
class PageError extends Error {
  constructor(
    readonly code: "INVALID_CURSOR" | "PAGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}
const cursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string(),
  revision: z.string(),
  position: z.number().int().nonnegative(),
});
function fits(value: unknown, budget = bytes) {
  return Buffer.byteLength(JSON.stringify(value)) <= budget;
}
function exactRead(value: Record<string, unknown>) {
  if (value.read && typeof value.read === "object") return value.read;
  if (typeof value.nodeId === "string")
    return {
      nodeId: value.nodeId,
      view: "raw",
      ...(typeof value.etag === "string" ? { expectedEtag: value.etag } : {}),
      ...(value.version ? { version: value.version } : {}),
    };
  if (typeof value.cardId === "string")
    return {
      cardId: value.cardId,
      view: "raw",
      ...(typeof value.etag === "string" ? { expectedEtag: value.etag } : {}),
    };
  if (typeof value.roleId === "string")
    return {
      roleId: value.roleId,
      view: "raw",
      ...(typeof value.etag === "string" ? { expectedEtag: value.etag } : {}),
    };
  return undefined;
}
export function compactItem<T>(item: T): T {
  if (fits(item, 6 * 1024)) return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const original = item as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(original)) {
    if (key === "sources" && Array.isArray(value) && !fits(value, 1024)) {
      output.sourcesOmitted = true;
    } else if (key === "changes" && Array.isArray(value) && !fits(value, 1024)) {
      output.changesOmitted = true;
    } else if (key === "tags" && Array.isArray(value) && !fits(value, 1024)) {
      output.tags = value.slice(0, 5);
      output.tagsTruncated = true;
    } else if (typeof value === "string" && value.length > 256) {
      if (["resource", "path", "uri"].includes(key)) output[`${key}Omitted`] = true;
      else {
        output[key] = value.slice(0, 256);
        output[`${key}Truncated`] = true;
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = compactItem(value);
    } else output[key] = value;
  }
  output.metadataRead ??= exactRead(original);
  if (fits(output, 8 * 1024)) return output as T;
  const identity = Object.fromEntries(
    ["nodeId", "cardId", "roleId", "commit", "etag", "version", "read"]
      .filter((key) => key in original)
      .map((key) => [key, original[key]]),
  );
  return { ...identity, metadataOmitted: true, metadataRead: exactRead(original) } as T;
}
export function formatTextPage(value: unknown): string {
  const result = value as {
    text: string;
    page?: { hasMore: boolean; next?: unknown; nextCursor?: string };
    version?: unknown;
  };
  return (
    result.text +
    (result.page?.hasMore
      ? `\n\n[Partial text]\nNext: ${JSON.stringify(result.page.next)}${result.page.nextCursor ? `\nCursor: ${result.page.nextCursor}` : ""}${result.version ? `\nVersion: ${JSON.stringify(result.version)}` : ""}`
      : "")
  );
}
function encode(scope: string, revision: string, position: number) {
  return Buffer.from(JSON.stringify({ version: 1, scope, revision, position })).toString(
    "base64url",
  );
}
function offset(cursor: string | undefined, scope: string, revision: string) {
  if (!cursor) return 0;
  let decoded: unknown;
  try {
    const value = Buffer.from(cursor, "base64url");
    if (cursor.length > 4096 || value.toString("base64url") !== cursor) throw new Error();
    decoded = JSON.parse(value.toString("utf8"));
  } catch {
    throw new PageError("INVALID_CURSOR", "Invalid reader cursor; restart the query");
  }
  const result = cursorSchema.safeParse(decoded);
  if (!result.success || result.data.scope !== scope)
    throw new PageError("INVALID_CURSOR", "Cursor belongs to another source or query");
  if (result.data.revision !== revision)
    throw new ReaderError("SOURCE_CHANGED", "Reader source changed; restart the query");
  return result.data.position;
}
export function pageItems<T extends { items: unknown[]; revision?: string }>(
  result: T,
  operation: string,
  options: { limit?: number; cursor?: string; start?: number; expectedRevision?: string } = {},
) {
  const revision = result.revision ?? canonicalSha256(result);
  const scope = canonicalSha256({
    operation,
    source: "cli",
    input: "scope" in result ? result.scope : undefined,
  });
  const compacted = result.items.map((item) =>
    compactItem(operation.startsWith("node.") ? incompleteNodeRead(item) : item),
  );
  const { scope: visibleScope, ...other } = result as T & { scope?: unknown };
  const base =
    visibleScope !== undefined && !fits(visibleScope, 1024)
      ? { ...other, scopeOmitted: true }
      : result;
  const start = options.cursor ? offset(options.cursor, scope, revision) : (options.start ?? 0);
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ReaderError("INVALID_INPUT", "Invalid page limit");
  if (!Number.isSafeInteger(start) || start < 0 || start > result.items.length)
    throw new PageError("INVALID_CURSOR", "Reader cursor position is invalid");
  if (options.expectedRevision && options.expectedRevision !== revision)
    throw new ReaderError("SOURCE_CHANGED", "List changed; restart the query");
  const make = (end: number) => ({
    ...base,
    items: compacted.slice(start, end),
    page: {
      hasMore: end < result.items.length,
      ...(end < result.items.length
        ? {
            nextCursor: encode(scope, revision, end),
            next: { start: end, expectedRevision: revision },
            nextIndex: end,
          }
        : {}),
    },
  });
  let end = Math.min(start + limit, result.items.length);
  while (end > start && !fits(make(end))) end--;
  const page = make(end);
  if ((end === start && start < result.items.length) || !fits(page))
    throw new PageError("PAGE_TOO_LARGE", "Record exceeds CLI page budget");
  return page;
}
export function pageText<
  T extends {
    text: string;
    etag: string;
    range: { unit: "utf16"; start: number; end: number };
    view: string;
    total?: number;
    viewLength?: number;
  },
>(
  result: T,
  operation: string,
  options: {
    cursor?: string;
    start?: number;
    end?: number;
    pageEnd?: number;
    maxBytes?: number;
  } = {},
) {
  const lower = result.range.start;
  const upper = result.range.end;
  const address = result as Record<string, unknown>;
  const scope = canonicalSha256({
    operation,
    view: result.view,
    source: address.source,
    from: address.from,
    to: address.to,
  });
  const start = options.cursor
    ? offset(options.cursor, scope, result.etag)
    : (options.start ?? lower);
  const requestedEnd = options.end ?? upper;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < lower ||
    requestedEnd > upper ||
    start > requestedEnd ||
    boundary(result.text, start - lower) !== start - lower ||
    boundary(result.text, requestedEnd - lower) !== requestedEnd - lower ||
    (options.pageEnd !== undefined &&
      (!Number.isSafeInteger(options.pageEnd) ||
        options.pageEnd < start ||
        options.pageEnd > requestedEnd ||
        boundary(result.text, options.pageEnd - lower) !== options.pageEnd - lower))
  ) {
    throw new ReaderError("INVALID_RANGE", "Invalid text page range");
  }
  const base = compactItem({ ...result, text: "" });
  const makePage = (end: number) => ({
    ...base,
    text: result.text.slice(start - lower, end - lower),
    range: { unit: "utf16" as const, start, end },
    partial: start !== 0 || end !== (result.total ?? result.viewLength),
    page: {
      hasMore: end < requestedEnd,
      ...(end < requestedEnd
        ? {
            nextCursor: encode(scope, result.etag, end),
            next: {
              view: result.view,
              range: { unit: "utf16" as const, start: end, end: requestedEnd },
              expectedEtag: result.etag,
            },
          }
        : {}),
    },
  });
  const make = (end: number) => {
    const page = makePage(end);
    return operation.startsWith("node.get:") && page.partial ? incompleteNodeRead(page) : page;
  };
  let end = Math.min(options.pageEnd ?? requestedEnd, requestedEnd);
  if (!fits(make(end), options.maxBytes)) {
    let low = start,
      high = end;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const safeMid = boundary(result.text, mid - lower) + lower;
      if (fits(make(safeMid), options.maxBytes)) low = mid;
      else high = mid - 1;
    }
    end = boundary(result.text, low - lower) + lower;
  }
  const page = make(end);
  if ((end === start && start < requestedEnd) || !fits(page, options.maxBytes))
    throw new PageError("PAGE_TOO_LARGE", "Text exceeds CLI page budget");
  return page;
}
