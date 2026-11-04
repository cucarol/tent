import * as z from "zod/v4";
import { canonicalSha256 } from "../core/base/canonical-digest.js";
import { ReaderError } from "../core/graph/reader-error.js";

const bytes = 16 * 1024 - 1; // The CLI appends one terminating newline.
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
function compactItem<T>(item: T): T {
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
  if (fits(output, 8 * 1024)) return output as T;
  const identity = Object.fromEntries(
    ["nodeId", "cardId", "roleId", "commit", "etag", "version", "uncaptured"]
      .filter((key) => key in original)
      .map((key) => [key, original[key]]),
  );
  return { ...identity, metadataOmitted: true } as T;
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
export function itemPageStart(cursor: string | undefined, operation: string, limit = 20) {
  let start = 0;
  if (cursor) {
    const scope = canonicalSha256({ operation, source: "cli" });
    // pageItems checks the revision against the selected history snapshot before
    // publishing any records; only the position is needed for the SQL query.
    let revision: string;
    try {
      revision = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).revision;
    } catch {
      throw new PageError("INVALID_CURSOR", "Invalid reader cursor; restart the query");
    }
    start = offset(cursor, scope, revision);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ReaderError("INVALID_INPUT", "Invalid page limit");
  return start;
}
export function pageItems<T extends { items: unknown[]; revision: string }>(
  result: T,
  operation: string,
  options: {
    limit?: number;
    cursor?: string;
    start?: number;
    expectedRevision?: string;
    window?: { start: number; total: number };
  } = {},
) {
  const { revision } = result;
  const scope = canonicalSha256({ operation, source: "cli" });
  const compacted = result.items.map((item) => compactItem(item));
  const start = options.cursor ? offset(options.cursor, scope, revision) : (options.start ?? 0);
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ReaderError("INVALID_INPUT", "Invalid page limit");
  const total = options.window?.total ?? result.items.length;
  const windowStart = options.window?.start ?? 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > total)
    throw new PageError("INVALID_CURSOR", "Reader cursor position is invalid");
  if (options.expectedRevision && options.expectedRevision !== revision)
    throw new ReaderError("SOURCE_CHANGED", "List changed; restart the query");
  const make = (end: number) => ({
    ...result,
    items: compacted.slice(start - windowStart, end - windowStart),
    page: {
      hasMore: end < total,
      ...(end < total
        ? {
            nextCursor: encode(scope, revision, end),
            next: { start: end, expectedRevision: revision },
          }
        : {}),
    },
  });
  let end = Math.min(start + limit, total);
  while (end > start && !fits(make(end))) end--;
  const page = make(end);
  if ((end === start && start < total) || !fits(page))
    throw new PageError("PAGE_TOO_LARGE", "Record exceeds CLI page budget");
  return page;
}
